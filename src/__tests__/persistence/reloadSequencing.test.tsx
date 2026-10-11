/**
 * ERR-10 — a full board reload is awaitable, ordered, and carries its own
 * structural outcome.
 *
 * Three defects, one per block:
 *
 *  1. `usePersistence.reload()` had no sequence token. Two reloads in flight
 *     could resolve in either order, and the OLDER document landing last put
 *     the board back to a state from before the newer write.
 *  2. `resyncBoardAfterWrite`'s full-reload fallback only dispatched an event,
 *     so `await resyncBoardAfterWrite(...)` returned before `loadSite` ran —
 *     `commitStructural` released `structuralCommitQueue.ts` and the next
 *     parked gesture planned against the pre-write ids.
 *  3. The write's outcome (what to select, what ⌘Z does) waited in a one-slot
 *     global box that the FIRST re-read to land claimed — including an
 *     unrelated agent patch that did not contain the write yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import {
  claimCmsSiteReloadRequests,
  consumePendingCmsSiteReload,
  registerCmsSiteReloader,
  requestCmsSiteReload,
} from '@admin/state/adminEvents'
import { resyncBoardAfterWrite } from '@site/studio/studioBoardResync'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { useEditorStore } from '@site/store/store'
import type { IPersistenceAdapter } from '@core/persistence/types'
import type { SiteDocument } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'

function site(name: string, nodeIds: string[] = []): SiteDocument {
  return makeSite({
    name,
    pages: [
      makePage({
        id: 'page-home',
        rootNodeId: 'root',
        nodes: {
          root: makeNode({ id: 'root', moduleId: 'base.container', children: nodeIds }),
          ...Object.fromEntries(
            nodeIds.map((id) => [id, makeNode({ id, moduleId: 'base.text', props: { text: id }, parentId: 'root' })]),
          ),
        },
      }),
    ],
  })
}

interface Deferred {
  resolve: (site: SiteDocument) => void
}

/**
 * The mount load answers at once; every later load waits until the test
 * resolves it, so the test decides the order responses arrive in.
 */
function makeDeferredAdapter(initial: SiteDocument): IPersistenceAdapter & { pending: Deferred[]; loads: () => number } {
  let loads = 0
  const pending: Deferred[] = []
  return {
    pending,
    loads: () => loads,
    async loadSite() {
      loads += 1
      if (loads === 1) return structuredClone(initial)
      return new Promise<SiteDocument>((resolve) => {
        pending.push({ resolve: (next) => resolve(structuredClone(next)) })
      })
    },
    async saveSite() {},
  }
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    hasUnsavedChanges: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  consumePendingCmsSiteReload()
  originalFetch = globalThis.fetch
  setStudioLoadedDir('/tmp/studio-test')
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  setStudioLoadedDir(null)
  consumePendingCmsSiteReload()
})

async function mount(adapter: ReturnType<typeof makeDeferredAdapter>) {
  const hook = renderHook(() => usePersistence('default', adapter, { enabled: true }))
  await waitFor(() => expect(hook.result.current.saveStatus.state).toBe('saved'))
  return hook
}

/** `/reload-scope` says "not provably narrow", so the resync falls back to the full reload. */
function stubWideReloadScope() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, narrow: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('reload() drops a superseded response (ERR-10)', () => {
  it('keeps the newer document when two reloads resolve out of order', async () => {
    const adapter = makeDeferredAdapter(site('Initial'))
    await mount(adapter)

    act(() => {
      void requestCmsSiteReload()
      void requestCmsSiteReload()
    })
    await waitFor(() => expect(adapter.pending).toHaveLength(2))

    // The newer fetch answers first, then the older one straggles in.
    await act(async () => {
      adapter.pending[1]!.resolve(site('Newer'))
      await tick()
    })
    expect(useEditorStore.getState().site?.name).toBe('Newer')

    await act(async () => {
      adapter.pending[0]!.resolve(site('Older'))
      await tick()
    })
    expect(useEditorStore.getState().site?.name).toBe('Newer')
  })
})

describe('the full-reload fallback is awaitable (ERR-10)', () => {
  it('resolves only after loadSite has run and the write\'s outcome is applied', async () => {
    const adapter = makeDeferredAdapter(site('Initial'))
    await mount(adapter)
    stubWideReloadScope()

    let resynced = false
    const resync = resyncBoardAfterWrite(['pages/Home.tsx'], {
      structuralOutcome: { selectNodeIds: ['pages/Home.tsx:6:7'], history: null },
    }).then(() => {
      resynced = true
    })

    await waitFor(() => expect(adapter.pending).toHaveLength(1))
    await act(async () => {
      await tick()
    })
    // The board has not caught up yet, so the structural queue must still be held.
    expect(resynced).toBe(false)

    await act(async () => {
      adapter.pending[0]!.resolve(site('After write', ['pages/Home.tsx:6:7']))
      await resync
    })

    expect(resynced).toBe(true)
    expect(useEditorStore.getState().site?.name).toBe('After write')
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['pages/Home.tsx:6:7'])
  })

  it('an unrelated patch landing first cannot claim the write\'s outcome', async () => {
    const adapter = makeDeferredAdapter(site('Initial'))
    await mount(adapter)
    stubWideReloadScope()

    const resync = resyncBoardAfterWrite(['pages/Home.tsx'], {
      structuralOutcome: { selectNodeIds: ['pages/Home.tsx:6:7'], history: null },
    })
    await waitFor(() => expect(adapter.pending).toHaveLength(1))

    // An agent's live-reload patch for the same page arrives in the window —
    // it does not contain the write, and it brought no outcome of its own.
    act(() => {
      applySitePagesPatch({ pages: [site('Agent', ['agent-node']).pages[0]!], removedPageIds: [] })
    })
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])

    await act(async () => {
      adapter.pending[0]!.resolve(site('After write', ['pages/Home.tsx:6:7']))
      await resync
    })
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['pages/Home.tsx:6:7'])
  })
})

describe('requestCmsSiteReload — the request/settle contract', () => {
  it('resolves at once when no editor is mounted to answer it', async () => {
    let settled = false
    await requestCmsSiteReload().then(() => {
      settled = true
    })
    expect(settled).toBe(true)
  })

  it('waits for the reload that covers it, and hands that reload its outcome', async () => {
    const unregister = registerCmsSiteReloader()
    let settled = false
    const done = requestCmsSiteReload({ structuralOutcome: { selectNodeIds: ['x'], history: null } }).then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)

    // A claim covering request numbers below this one's would not reach it; one
    // covering it does.
    const claimed = claimCmsSiteReloadRequests(Number.POSITIVE_INFINITY)
    expect(claimed.structuralOutcomes).toEqual([{ selectNodeIds: ['x'], history: null }])
    claimed.settle()
    await done
    expect(settled).toBe(true)
    unregister()
  })

  it('settles whatever is still waiting when the last editor unmounts', async () => {
    const unregister = registerCmsSiteReloader()
    let settled = false
    const done = requestCmsSiteReload().then(() => {
      settled = true
    })
    unregister()
    await done
    expect(settled).toBe(true)
  })
})
