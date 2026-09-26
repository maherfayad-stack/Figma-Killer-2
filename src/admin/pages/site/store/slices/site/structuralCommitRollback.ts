/**
 * structuralCommitRollback — what a structural write that did NOT land takes
 * back (ERR-6).
 *
 * A move or a delete changes the canvas the instant the gesture runs and posts
 * its write afterwards; an undo or redo moves its history entry before its
 * re-issued write is posted. Both are right when the write lands, because the
 * resync that follows makes the board agree with disk. When it does not land —
 * the server refused it at AST level, or never answered at all — nothing
 * follows, and the board used to go on showing a layout the file does not have
 * until some unrelated reload, with a history entry that ⌘Z would "undo" by
 * really moving something on disk.
 *
 * So each such commit carries a {@link StructuralCommitRollback}, the same
 * settle-or-take-back contract `structuralOptimism.ts`'s preview handle gives
 * insert/duplicate/wrap/group, and `commitStructuralBody` calls exactly one of
 * its two methods once the outcome is known:
 *
 *  - `settle()` — the write landed (the resync owns the board from here).
 *  - `rollback(failure)` — it did not. Three parts:
 *      * the TREE: a move/delete's own inverse patches are applied, unless a
 *        re-read from disk has replaced the page since (`pageReadEpoch.ts` —
 *        the fresh page already says what the file says, and replaying the
 *        inverse over it would invent a change);
 *      * a live frame's DOM: the optimistic hide or move the gesture made in
 *        every bridge frame is put back (`broadcastOptimisticRevert`, store-17)
 *        — no HMR follows a write that did not land, so nothing else would;
 *      * the STACK: the entry the write stood for is found again by its
 *        `pendingCommit` id. A gesture that never happened is removed. An
 *        undo/redo step that the server REFUSED is removed too — it is the
 *        same refusal every time, so leaving it would jam the stack
 *        (ERR-2's stop-gap). A step that never REACHED the server goes back
 *        where it was, so the next ⌘Z can try it again.
 *
 * Toasts are not this module's business: `commitStructuralBody` says what
 * happened, once.
 */
import { apply, type Draft, type Patches } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import { broadcastOptimisticRevert } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import type { EditorStore } from '@site/store/types'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { collectDirtyFromSitePatches } from './dirtyTracking'
import { applyNodeIndexPatch, nodeIndexesOf } from './nodeIndex'
import { pageReadMark, pagesReadSince } from './pageReadEpoch'
import type { HistoryEntry, PendingStructuralCommit, SiteSliceHelpers } from './types'

/** Why a structural write did not land. Decides what happens to an undo/redo step's entry — see this module's doc. */
type StructuralCommitFailure = 'refused' | 'unreachable'

export interface StructuralCommitRollback {
  /** The pending-commit id this handle resolves — what `undoRedoActions.ts` stamps onto the entry a re-issued move stands for. */
  readonly id: number
  /** The write landed: forget the mark, touch nothing else. */
  settle: () => void
  /** The write did not land: take back what the gesture did locally. Idempotent with `settle`. */
  rollback: (failure: StructuralCommitFailure) => void
}

let lastPendingCommitId = 0

/** A fresh id for `HistoryEntry.pendingCommit`. */
export function mintPendingCommitId(): number {
  lastPendingCommitId += 1
  return lastPendingCommitId
}

/**
 * Track the tree mutation `mutateActiveTree`/`mutateTreesForNodeIds` JUST
 * committed for a move or delete about to post its write. Call it straight
 * after the mutation, BEFORE `tagStructuralGesture` — a delete's tag clears the
 * entry's patches (`structuralHistory.ts`), and they are exactly what a
 * rollback replays. The patches are held here, never on the entry, so the
 * delete's patch-free contract stands.
 *
 * `optimisticNodeIds` are the nodes the gesture hid or moved in the bridge
 * frames (`broadcastOptimisticDelete`/`Move`) — what a rollback puts back there.
 *
 * `topBefore` is the top of `_historyPast` from just BEFORE the mutation: a
 * recipe can report a change that produced no patch, and then no entry was
 * pushed — the top is somebody else's, and there is nothing to track.
 */
export function trackStructuralTreeCommit(
  { get, set }: Pick<SiteSliceHelpers, 'get' | 'set'>,
  topBefore: HistoryEntry | undefined,
  optimisticNodeIds: readonly string[],
): StructuralCommitRollback | null {
  const state = get()
  const top = state._historyPast[state._historyPast.length - 1]
  if (!top || top === topBefore || !state.site) return null
  const inverse = top.inverse
  const pageIds = pageIdsOfPatches(inverse, state.site)
  const mark = pageReadMark()
  const id = mintPendingCommitId()
  set((draft) => {
    const entry = draft._historyPast[draft._historyPast.length - 1]
    if (entry) entry.pendingCommit = { id, step: 'gesture' }
  })
  return buildRollback({ get, set }, id, { inverse, pageIds, mark, optimisticNodeIds })
}

/**
 * Track the write an undo/redo re-issues for a SOURCE entry: nothing in the
 * tree to take back (the family mutates no tree), only the stack. The caller
 * stamps `{ id, step: direction }` onto the entry it moved.
 */
export function trackStructuralStackCommit(helpers: Pick<SiteSliceHelpers, 'get' | 'set'>, id: number): StructuralCommitRollback {
  return buildRollback(helpers, id, null)
}

interface TreeInverse {
  inverse: Patches
  pageIds: ReadonlySet<string>
  mark: number
  optimisticNodeIds: readonly string[]
}

function buildRollback(
  { get, set }: Pick<SiteSliceHelpers, 'get' | 'set'>,
  id: number,
  tree: TreeInverse | null,
): StructuralCommitRollback {
  let done = false
  return {
    id,
    settle: () => {
      if (done) return
      done = true
      set((state) => {
        const found = findPending(state, id)
        if (found) delete found.entry.pendingCommit
      })
    },
    rollback: (failure) => {
      if (done) return
      done = true
      const before = get().site
      const restored = tree && before ? restoreTree(before, tree) : null
      set((state) => {
        if (restored && before) {
          state.site = restored
          applyNodeIndexPatch(
            nodeIndexesOf(state),
            before,
            restored,
            collectDirtyFromSitePatches(tree!.inverse, before, restored),
          )
          pruneCanvasSelectionDraft(state)
        }
        takeBackEntry(state, id, failure)
      })
      if (tree) broadcastOptimisticRevert(tree.optimisticNodeIds)
    },
  }
}

/**
 * The site with the gesture's inverse replayed, or `null` when replaying it
 * would not be honest: a re-read replaced one of its pages, or the patches no
 * longer apply. `null` leaves the tree as it is — after a re-read that is
 * already what disk says.
 */
function restoreTree(site: SiteDocument, tree: TreeInverse): SiteDocument | null {
  if (pagesReadSince(tree.pageIds, tree.mark)) return null
  try {
    return apply(site, tree.inverse)
  } catch (err) {
    console.error('[structuralCommitRollback] could not replay a refused gesture’s inverse:', err)
    return null
  }
}

/** The page ids a site-relative patch list addresses (`['pages', <index>, …]`), resolved against `site`. */
function pageIdsOfPatches(patches: Patches, site: SiteDocument): Set<string> {
  const ids = new Set<string>()
  for (const patch of patches) {
    if (patch.path[0] !== 'pages' || typeof patch.path[1] !== 'number') continue
    const page = site.pages[patch.path[1]]
    if (page) ids.add(page.id)
  }
  return ids
}

function findPending(
  state: Draft<EditorStore>,
  id: number,
): { stack: Draft<HistoryEntry>[]; index: number; entry: Draft<HistoryEntry> & { pendingCommit?: PendingStructuralCommit } } | null {
  for (const stack of [state._historyPast, state._historyFuture]) {
    const index = stack.findIndex((entry) => entry.pendingCommit?.id === id)
    if (index >= 0) return { stack, index, entry: stack[index]! }
  }
  return null
}

/** The STACK half of a rollback — see this module's doc for which way each case goes. */
function takeBackEntry(state: Draft<EditorStore>, id: number, failure: StructuralCommitFailure): void {
  const found = findPending(state, id)
  if (!found) return
  const { stack, index, entry } = found
  const step = entry.pendingCommit!.step
  stack.splice(index, 1)
  if (step !== 'gesture' && failure === 'unreachable') {
    delete entry.pendingCommit
    // An undo moved it past → future, a redo future → past; put it back.
    ;(step === 'undo' ? state._historyPast : state._historyFuture).push(entry)
  }
  state.canUndo = state._historyPast.length > 0
  state.canRedo = state._historyFuture.length > 0
}
