/**
 * `store-11` found the race; `store-14` changed what happens to the gesture
 * that loses it.
 *
 * A structural gesture (insert/duplicate/wrap/group/ungroup/paste) fired while
 * a PRIOR one is still being written+resynced used to race it: nothing marked
 * the client's tree as stale until the first commit's resync landed, so a
 * second gesture planned against the still-unshifted original and wrote a
 * SECOND real copy for what looked like one user action. `store-11` closed
 * that by REFUSING the second gesture ("Still writing your last change"), and
 * `verify-3` then measured what that felt like: ⌘D five times inside 300 ms
 * wrote ONE copy.
 *
 * So the serialization stays and the refusal goes. This suite pins both halves
 * against `writeDuplicateToSource` (`studioSourceWrites.ts`) — the exact shape
 * of a rapid ⌘D burst on the canvas:
 *
 *   1. five presses inside the first one's round trip post FIVE `/save`
 *      requests, never two at once, and never a "Still writing" warning;
 *   2. the queue has a ceiling, and overflowing it is reported rather than
 *      dropped in silence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode } from '../../../../../../../__tests__/fixtures'
import {
  MAX_DEFERRED_STRUCTURAL_GESTURES,
  deferredStructuralGestureCount,
  isStructuralCommitInFlight,
  resetStructuralCommitQueue,
} from '../../../../studio/structuralCommitQueue'
import { setStudioLoadedDir } from '../../../../studio/studioWorkspaceDir'
import { createStudioSourceWrites } from '../studioSourceWrites'
import type { SiteSliceHelpers } from '../types'

describe('structural commits queue instead of refusing (store-14)', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ url: string; body: unknown }>
  let toasts: readonly Toast[]
  let unregisterSave: (() => void) | null
  let unsubscribeToasts: (() => void) | null

  beforeEach(() => {
    __resetToastBusForTests()
    // The queue and the in-flight flag are module-level state, not reset
    // between files on their own: an unsettled burst in one spec would poison
    // every structural action in the next.
    resetStructuralCommitQueue()
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
    resetStructuralCommitQueue()
  })

  /**
   * A `/save` response that only resolves once `release()` is called, so a
   * test can inspect state WHILE a structural commit is still in flight — the
   * exact window the race lived in. `/reload-scope` answers "not narrow-safe"
   * (the honest default), so the resync after a landed write falls back to the
   * full reload rather than needing a `/load` stub too.
   *
   * `release` opens the gate for every request issued from then on, which is
   * what lets a queued burst drain to completion in one step.
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
          createdNodeIds: ['pages/Home.tsx:6:5'],
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

  /**
   * `writeDuplicateToSource` only reads `get`/`set` on the REFUSAL path, which
   * this suite never reaches. `previewActiveTreeMutation` is `perf-10`'s
   * optimistic-preview hook — a stub that always declines (`null`, "nothing
   * to roll back") is enough here: `structuralOptimism.ts`'s own
   * `safelyBuild` already swallows a missing/failing implementation, this
   * just keeps that path quiet instead of console.error-ing on every one of
   * this suite's five-⌘D-burst duplicates.
   */
  function makeHelpers(): SiteSliceHelpers {
    return {
      get: (() => ({})) as never,
      set: (() => {}) as never,
      previewActiveTreeMutation: () => null,
    } as unknown as SiteSliceHelpers
  }

  /**
   * Polls a real timer rather than counting microtask ticks: the commit chain
   * (`flushEditorSave` → `postEdits` → `resyncBoardAfterWrite` →
   * `apiRequest`/`readEnvelope`'s own internal awaits) has an unpredictable
   * number of microtask hops, so asserting on tick count is brittle.
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const saveCalls = () => calls.filter((c) => c.url.includes('/admin/api/studio/save'))

  it('five ⌘D presses inside one round trip write five copies, one commit at a time', async () => {
    const { release } = stubDeferredSaveFetch()
    const tree = makeStudioTree()
    const { writeDuplicateToSource } = createStudioSourceWrites(makeHelpers(), () => tree)

    expect(isStructuralCommitInFlight()).toBe(false)

    // Press one — plans and posts, but the response is gated so the other four
    // all land inside its in-flight window, which is what a 300 ms burst does.
    expect(writeDuplicateToSource(['pages/Home.tsx:5:5'])).toBe(true)
    await waitFor(() => saveCalls().length === 1)
    expect(isStructuralCommitInFlight()).toBe(true)

    for (let i = 0; i < 4; i += 1) {
      expect(writeDuplicateToSource(['pages/Home.tsx:5:5'])).toBe(true)
    }
    // Nothing extra reached the network yet: the queue is serializing, which is
    // still what closes `store-11`'s race.
    expect(saveCalls()).toHaveLength(1)
    expect(deferredStructuralGestureCount()).toBe(4)

    release()
    await waitFor(() => saveCalls().length === 5 && !isStructuralCommitInFlight())

    // Five presses, five real writes — each one its own commit, each carrying
    // exactly one edit.
    expect(saveCalls()).toHaveLength(5)
    for (const call of saveCalls()) {
      expect((call.body as { edits: unknown[] }).edits).toHaveLength(1)
    }
    expect(deferredStructuralGestureCount()).toBe(0)

    // The refusal is gone, and Z1 collapses the five successes onto ONE card.
    expect(toasts.some((t) => t.title === 'Still writing your last change')).toBe(false)
    const duplicated = toasts.filter((t) => t.kind === 'success' && t.title === 'Duplicated')
    expect(duplicated).toHaveLength(1)
    expect(duplicated[0]!.repeatCount).toBe(5)
  })

  it('a burst past the ceiling is reported, never silently dropped', async () => {
    const { release } = stubDeferredSaveFetch()
    const tree = makeStudioTree()
    const { writeDuplicateToSource } = createStudioSourceWrites(makeHelpers(), () => tree)

    writeDuplicateToSource(['pages/Home.tsx:5:5'])
    await waitFor(() => saveCalls().length === 1)

    // One more than the queue will hold — a stuck key, not a hand.
    for (let i = 0; i < MAX_DEFERRED_STRUCTURAL_GESTURES + 1; i += 1) {
      writeDuplicateToSource(['pages/Home.tsx:5:5'])
    }
    expect(deferredStructuralGestureCount()).toBe(MAX_DEFERRED_STRUCTURAL_GESTURES)
    expect(toasts.some((t) => t.kind === 'warning' && t.title === 'Too many changes at once')).toBe(true)

    release()
    await waitFor(
      () => saveCalls().length === MAX_DEFERRED_STRUCTURAL_GESTURES + 1 && !isStructuralCommitInFlight(),
    )
    // The ceiling bounds the writing, it does not stop it: everything that WAS
    // queued still lands.
    expect(saveCalls()).toHaveLength(MAX_DEFERRED_STRUCTURAL_GESTURES + 1)
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
    await waitFor(() => saveCalls().length === 2)

    expect(saveCalls()).toHaveLength(2)
    expect(deferredStructuralGestureCount()).toBe(0)
  })
})
