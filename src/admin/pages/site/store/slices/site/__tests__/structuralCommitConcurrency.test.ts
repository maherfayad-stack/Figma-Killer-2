/**
 * `store-11` — a structural gesture (insert/duplicate/wrap/move/delete) fired
 * while a PRIOR one is still being written+resynced used to race it: nothing
 * marked the client's tree as stale until the first commit's resync landed,
 * so a second gesture planned against the still-unshifted original and wrote
 * a SECOND real copy for what looked like one user action.
 *
 * Reproduced concretely against `writeDuplicateToSource` (`studioSourceWrites.ts`):
 * two back-to-back calls, neither one awaited before the second fires — the
 * exact shape of a rapid double-click on the canvas toolbar's Duplicate
 * button, or two `⌘D` keydowns before the first's network round trip
 * resolves. Before the fix this posted TWO `duplicate` edits for the same
 * node and pushed two "Written to your project source" toasts; after the
 * fix, the second call never reaches the network at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode } from '../../../../../../../__tests__/fixtures'
import { isStructuralCommitInFlight } from '../../../../studio/studioStructuralCommits'
import { setStudioLoadedDir } from '../../../../studio/studioWorkspaceDir'
import { createStudioSourceWrites } from '../studioSourceWrites'
import type { SiteSliceHelpers } from '../types'

describe('structural commit re-entrancy guard (store-11)', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ url: string; body: unknown }>
  let toasts: readonly Toast[]
  let unregisterSave: (() => void) | null
  let unsubscribeToasts: (() => void) | null

  beforeEach(() => {
    __resetToastBusForTests()
    originalFetch = globalThis.fetch
    calls = []
    toasts = []
    unregisterSave = registerEditorSave(async () => {})
    unsubscribeToasts = subscribeToasts((next) => { toasts = next })
    setStudioLoadedDir('/tmp/studio-test')
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    unsubscribeToasts?.()
  })

  /**
   * A `/save` response that only resolves once `release()` is called, so a
   * test can inspect state WHILE the first structural commit is still in
   * flight — the exact window the race lived in. `/reload-scope` answers
   * "not narrow-safe" (the honest default), so the resync after a landed
   * write falls back to the full reload rather than needing a `/load` stub
   * too.
   */
  function stubDeferredSaveFetch() {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url.includes('/admin/api/studio/reload-scope')) {
        return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200 })
      }
      await gate
      return new Response(
        JSON.stringify({
          ok: true,
          written: 1,
          skipped: 0,
          shifted: true,
          sharedComponents: true,
          touchedFiles: ['pages/Home.tsx'],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    return { release: () => release?.() }
  }

  /** A minimal studio-imported tree: one duplicate-able, source-derived child of the root. */
  function makeStudioTree(): NodeTree<PageNode> {
    const nodeId = 'pages/Home.tsx:5:5'
    return {
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.text' }),
      },
    }
  }

  /** `writeDuplicateToSource` only reads `get`/`set` on the REFUSAL path, which this suite never reaches. */
  function makeHelpers(): SiteSliceHelpers {
    return { get: (() => ({})) as never, set: (() => {}) as never } as unknown as SiteSliceHelpers
  }

  /**
   * Polls a real timer rather than counting microtask ticks: the commit chain
   * (`flushEditorSave` → `postEdits` → `resyncBoardAfterWrite` →
   * `apiRequest`/`readEnvelope`'s own internal awaits) has an unpredictable
   * number of microtask hops, so asserting on tick count is brittle.
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('a second duplicate fired before the first resolves is refused, not posted', async () => {
    const { release } = stubDeferredSaveFetch()
    const tree = makeStudioTree()
    const { writeDuplicateToSource } = createStudioSourceWrites(makeHelpers(), () => tree)

    expect(isStructuralCommitInFlight()).toBe(false)

    // First click — plans and posts, but the response is gated so we can
    // observe the in-flight window.
    const stopped1 = writeDuplicateToSource(['pages/Home.tsx:5:5'])
    expect(stopped1).toBe(true) // studio tree: "written or refused", caller must stop either way

    // Give the fire-and-forget commit's chain a moment to actually issue the
    // POST (past the /reload-scope pre-check `flushEditorSave` doesn't touch)
    // before we check the flag.
    await waitFor(() => calls.some((c) => c.url.includes('/admin/api/studio/save')))
    expect(isStructuralCommitInFlight()).toBe(true)

    // Second click, same gesture, while the first is still in flight — the
    // bug this guards against.
    const stopped2 = writeDuplicateToSource(['pages/Home.tsx:5:5'])
    expect(stopped2).toBe(true)

    release()
    // Let the first commit's chain (post → resync fallback) finish.
    await waitFor(() => !isStructuralCommitInFlight())

    // Exactly ONE POST to /save reached the network — the second gesture
    // never got that far.
    const saveCalls = calls.filter((c) => c.url.includes('/admin/api/studio/save'))
    expect(saveCalls).toHaveLength(1)
    expect((saveCalls[0]!.body as { edits: unknown[] }).edits).toHaveLength(1)

    // The user sees why: one "still writing" warning for the blocked second
    // click, alongside the first click's real success toast.
    expect(toasts.some((t) => t.kind === 'warning' && t.title === 'Still writing your last change')).toBe(true)
    expect(toasts.some((t) => t.kind === 'success' && t.title === 'Duplicated')).toBe(true)
  })

  it("a duplicate AFTER the previous one's resync has landed proceeds normally", async () => {
    const { release } = stubDeferredSaveFetch()
    const tree = makeStudioTree()
    const { writeDuplicateToSource } = createStudioSourceWrites(makeHelpers(), () => tree)

    writeDuplicateToSource(['pages/Home.tsx:5:5'])
    release()
    // Drain the first commit's chain fully.
    await waitFor(() => !isStructuralCommitInFlight())

    writeDuplicateToSource(['pages/Home.tsx:5:5'])
    await waitFor(() => calls.filter((c) => c.url.includes('/admin/api/studio/save')).length === 2)

    const saveCalls = calls.filter((c) => c.url.includes('/admin/api/studio/save'))
    expect(saveCalls).toHaveLength(2)
  })
})
