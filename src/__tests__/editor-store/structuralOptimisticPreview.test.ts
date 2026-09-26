/**
 * `perf-10` — the structural SOURCE family (insert/duplicate/wrap) used to
 * show NOTHING on the canvas until the write's own resync reparsed the file:
 * `editor-store.md`'s own words for it were "nothing is shown
 * optimistically". This suite pins the fix against the REAL store (not a
 * stub of it — see `structuralOptimisticBroadcast.test.ts`'s own doc for why
 * that harness is the honest one): the gesture must paint the canvas
 * SYNCHRONOUSLY, in the same tick the store action returns, and a preview
 * that turns out to have no honest write behind it must be taken back.
 *
 * Confirmed to fail without the fix: with `structuralOptimism.ts`'s
 * `previewOptimisticDuplicate`/`previewOptimisticInsert`/`previewOptimisticWrap`
 * calls removed from `studioSourceWrites.ts` (or with
 * `commitStructuralBody`'s `rollback()` call removed), the "appears
 * instantly" tests see no new node at all and the "rolled back" test still
 * sees the preview node after the refusal settles. See this file's own
 * history for the exact lines flipped to verify that, per the work order's
 * "confirm red without the fix" requirement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { isStructuralCommitInFlight, resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { isPendingOptimisticNodeId, resetOptimisticPreviewTracking } from '@site/store/slices/site/structuralOptimism'
import type { PageNode } from '@core/page-tree'
import { makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const FILE = 'app/page.tsx'
const at = (line: number) => `${FILE}:${line}:5`
const ROOT = 'page-1:body'

function studioSite(children: Record<string, { moduleId: string; children?: string[] }>, rootChildren: string[]) {
  const nodes: Record<string, PageNode> = {
    [ROOT]: { id: ROOT, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: rootChildren, classIds: [] },
  }
  for (const [id, def] of Object.entries(children)) {
    nodes[id] = {
      id,
      moduleId: def.moduleId,
      props: def.moduleId === 'base.text' ? { text: id } : {},
      breakpointOverrides: {},
      children: def.children ?? [],
      classIds: [],
    }
  }
  return makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: ROOT, nodes })] })
}

const store = () => useEditorStore.getState()

function currentChildren(): PageNode[] {
  const state = store()
  const page = state.site!.pages.find((p) => p.id === 'page-1')!
  return page.rootNodeId
    ? (page.nodes[page.rootNodeId]?.children ?? []).map((id) => page.nodes[id]!)
    : []
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let realFetch: typeof globalThis.fetch

/** A `/studio/save` that always reports the write landed. */
function stubSuccessfulSaveFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Reload-scope: "not provably narrow" — the resync widens to a full
    // reload this suite never awaits, since every assertion here is about
    // the SYNCHRONOUS preview, not the eventual re-read.
    return new Response(JSON.stringify({ ok: true, narrow: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

/** A `/studio/save` that always REFUSES — nothing ever reaches disk. */
function stubRefusingSaveFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      return new Response(
        JSON.stringify({
          ok: true,
          written: 0,
          skipped: 1,
          shifted: false,
          sharedComponents: false,
          refusals: [{ nodeId: 'x', kind: 'duplicate', reason: 'locked', message: 'Refused for the test.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

beforeEach(() => {
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
  realFetch = globalThis.fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
})

afterEach(async () => {
  // Drain any in-flight commit before the next test's `beforeEach` resets
  // module-level state out from under it — same landmine `structuralCommitQueue.test.ts`
  // documents for `structuralCommitInFlight`.
  await waitFor(() => !isStructuralCommitInFlight()).catch(() => {})
  globalThis.fetch = realFetch
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
})

describe('a structural SOURCE gesture paints the canvas before the write lands (perf-10)', () => {
  it('duplicateNode clones the node into the tree in the same tick, not after the resync', () => {
    stubSuccessfulSaveFetch()
    const a = at(3)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' } }, [a]))
    store().setActivePage('page-1')
    expect(currentChildren()).toHaveLength(1)

    store().duplicateNode(a)

    // Synchronous — no `await`, no `waitFor` — because the preview is applied
    // before the fire-and-forget write is even posted.
    const children = currentChildren()
    expect(children).toHaveLength(2)
    expect(children.some((n) => n.id !== a && n.moduleId === 'base.text')).toBe(true)
  })

  it('insertNode mints the new module into the tree in the same tick', () => {
    stubSuccessfulSaveFetch()
    const container = at(3)
    store().loadSite(studioSite({ [container]: { moduleId: 'base.container' } }, [container]))
    store().setActivePage('page-1')

    store().insertNode('base.text', { text: 'hi' }, container)

    const state = store()
    const page = state.site!.pages.find((p) => p.id === 'page-1')!
    const containerNode = page.nodes[container]!
    expect(containerNode.children).toHaveLength(1)
    const child = page.nodes[containerNode.children[0]!]!
    expect(child.moduleId).toBe('base.text')
    expect(child.props.text).toBe('hi')
    // A throwaway placeholder, never a real `rel:line:col` — same convention
    // `broadcastOptimisticInsert`'s ghost id already uses.
    expect(child.id.startsWith('optimistic:')).toBe(true)
    expect(isPendingOptimisticNodeId(child.id)).toBe(true)
  })

  it('wrapNode wraps the node into a new container in the same tick', () => {
    stubSuccessfulSaveFetch()
    const a = at(3)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' } }, [a]))
    store().setActivePage('page-1')

    store().wrapNode(a, 'base.container')

    const children = currentChildren()
    expect(children).toHaveLength(1)
    expect(children[0]!.moduleId).toBe('base.container')
    expect(children[0]!.children).toEqual([a])
  })
})

describe('a preview is taken back when its write never lands (perf-10)', () => {
  it('duplicateNode’s preview is rolled back once the refusal settles', async () => {
    stubRefusingSaveFetch()
    const a = at(3)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' } }, [a]))
    store().setActivePage('page-1')

    store().duplicateNode(a)
    // The preview is there immediately —
    expect(currentChildren()).toHaveLength(2)

    // — and gone again once the refusal comes back and no resync follows.
    await waitFor(() => !isStructuralCommitInFlight())
    expect(currentChildren()).toHaveLength(1)
    expect(currentChildren()[0]!.id).toBe(a)
  })
})
