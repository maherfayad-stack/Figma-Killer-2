/**
 * Undo/redo actions for the site slice.
 *
 * History is stored as Mutative patch pairs (see `HistoryEntry`): each entry
 * carries `inverse` patches (applied on undo) and `forward` patches (applied on
 * redo), scoped to the SiteDocument. Undo/redo `apply()` the relevant patch set
 * to the current `site` — O(change), no full-site clone — then move the entry
 * between the past/future stacks and re-derive the `packageJson` / `siteRuntime`
 * mirrors from the restored site.
 *
 * `store-09` — an entry may instead (or additionally) carry `board`: the board
 * domain's before/after state pair (`boardHistory.ts`). One stack, two domains
 * — ⌘Z gives back the last thing the user DID, whether that was a style value,
 * a structural move, a frame drag or a sticky-note move. A board-only entry
 * needs no `site` at all, which is why the `site` guard sits below the board
 * branch rather than at the top of the action.
 */

import { apply } from 'mutative'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { collectDirtyFromSitePatches, mergeDirtyMarks } from './dirtyTracking'
import { applyNodeIndexPatch, nodeIndexesOf } from './nodeIndex'
import { isBoardOnlyEntry, restoreBoardSnapshot } from '../boardHistory'
import { pushToast } from '@ui/components/Toast'
import { reissueStructuralMove, reissueStructuralSiblings, type StructuralStepOutcome } from './structuralHistory'
import { reissueStructuralSourceEdits } from './structuralSourceHistory'
import { mintPendingCommitId, trackStructuralStackCommit } from './structuralCommitRollback'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { HistoryEntry, SiteSlice, SiteSliceHelpers, StructuralHistory } from './types'

type UndoRedoActions = Pick<SiteSlice, 'undo' | 'redo'>

/**
 * `store-08` — a structural transaction is undone by RE-ISSUING the gesture,
 * never by replaying its patches. See `structuralHistory.ts` for why: the
 * user's `.tsx` is the document, and `saveSite` diffs values, not structure.
 *
 * Always handles the entry (there is no patch path to fall back to).
 *
 * The stack bookkeeping is done by hand because the re-issued gesture is an
 * ordinary mutation: it pushes its own history entry and clears the redo
 * stack. Both are corrected here, so one Ctrl+Z consumes exactly one entry and
 * a pending redo chain survives. The entry is stamped with the re-issued
 * write's `pendingCommit`, so a write that does not land can put it back or
 * drop it (ERR-6, `structuralCommitRollback.ts`).
 *
 * A step that can never happen as recorded is SKIPPED, never left on top
 * (ERR-2's stop-gap, ERR-28): see {@link skipStructuralStep}.
 */
function runStructuralStep(
  { get, set }: Pick<SiteSliceHelpers, 'get' | 'set'>,
  entry: HistoryEntry,
  structural: StructuralHistory,
  direction: 'undo' | 'redo',
): void {
  // ERR-4 — a structural undo/redo is a WRITE (a move re-issued through
  // `moveNodes`, or a source gesture's inverse posted), so it queues behind a
  // structural write still in flight like every other structural writer. The
  // whole step is parked, not just its write: when it runs it reads the top
  // of the stack as the in-flight write's resync (and its history remap) left
  // it, so ⌘Z pressed during a drag's commit undoes that drag.
  if (deferWhileStructuralCommitInFlight(() => get()[direction]())) return
  const from = direction === 'undo' ? '_historyPast' : '_historyFuture'
  const to = direction === 'undo' ? '_historyFuture' : '_historyPast'
  // Both stacks are snapshotted BEFORE the re-issue and assigned wholesale
  // after it. The re-issued gesture pushes its own entry onto `_historyPast`
  // and clears `_historyFuture` (`commitHistoryEntry`), so anything computed from
  // the post-gesture stacks would double-count in one direction and silently
  // drop a pending redo chain in the other.
  const fromBefore = [...get()[from]]
  const toBefore = [...get()[to]]

  // `store-14`/`store-15` — a SOURCE gesture (duplicate/wrap/group/ungroup/
  // paste/transplant/image-drop, and `delete`) has no gesture to re-issue
  // through a store action: its inverse is a WRITE, posted through the same
  // `/save` route the gesture used. A move re-issues `moveNodes`, whose own
  // entry (and rollback) the bookkeeping below folds into this one.
  // P2-C2 — a sibling batch re-issues `moveSiblings`, the same way.
  const outcome: StructuralStepOutcome =
    structural.gesture === 'source'
      ? reissueStructuralSourceEdits(get, structural, direction, trackStructuralStackCommit({ get, set }, mintPendingCommitId()))
      : structural.gesture === 'siblings'
        ? reissueStructuralSiblings(get, direction === 'undo' ? structural.undo : structural.redo)
        : reissueStructuralMove(get, direction === 'undo' ? structural.undo : structural.redo)
  if (outcome.kind === 'skipped') {
    skipStructuralStep({ get, set }, entry, direction, outcome.notice)
    return
  }

  const { pendingCommitId } = outcome
  set((state) => {
    state[from] = fromBefore.slice(0, -1)
    state[to] = [...toBefore, pendingCommitId === null ? entry : { ...entry, pendingCommit: { id: pendingCommitId, step: direction } }]
    state._historyCoalesceKey = null
    state.canUndo = state._historyPast.length > 0
    state.canRedo = state._historyFuture.length > 0
  })
}

/**
 * ERR-2 (stop-gap) / ERR-28 — a structural step that can never happen as
 * recorded: an inverse the editor cannot express, an element the board no
 * longer has, a file an agent or editor changed underneath the entry, or a
 * move the gate refuses.
 *
 * It used to stay where it was, behind a modal: every later ⌘Z hit the same
 * refusal, so nothing before it could be undone from the keyboard. Figma's
 * answer, and now this one: drop the step and keep going. One ⌘Z still does
 * one visible thing — an UNDO carries on to the step below in the same
 * keystroke. A REDO drops the whole redo chain instead: every step after this
 * one was recorded on top of it, so replaying them without it would be
 * replaying a history that did not happen.
 *
 * One quiet notice says what was skipped — never a dialog. `notice` is `null`
 * when the refusal was already presented (the move gate's own toast or
 * dialog), and then this adds nothing.
 */
function skipStructuralStep(
  { get, set }: Pick<SiteSliceHelpers, 'get' | 'set'>,
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
  notice: string | null,
): void {
  const label = entry.structural?.gesture === 'source' ? entry.structural.source.label : 'Move'
  set((state) => {
    if (direction === 'undo') state._historyPast = state._historyPast.slice(0, -1)
    else state._historyFuture = []
    state._historyCoalesceKey = null
    state.canUndo = state._historyPast.length > 0
    state.canRedo = state._historyFuture.length > 0
  })
  if (notice !== null) {
    pushToast({
      kind: 'warning',
      title: `Skipped “${label}” — it can’t be ${direction === 'undo' ? 'undone' : 'redone'}`,
      body: notice,
      location: 'site-editor',
      dedupeKey: `structural-${direction}-skipped`,
    })
  }
  if (direction === 'undo') get().undo()
}

/**
 * Move a BOARD-ONLY entry one step, restoring the named end of its snapshot
 * pair. No `site` is involved, so nothing here touches the site, the dirty
 * marks or the node indexes — `restoreBoardSnapshot` owns the board-side
 * bookkeeping (dirty flag, removal flag, selection pruning).
 */
function runBoardStep(
  { set }: Pick<SiteSliceHelpers, 'set'>,
  entry: HistoryEntry,
  direction: 'undo' | 'redo',
): void {
  set((state) => {
    if (direction === 'undo') {
      state._historyPast.pop()
      state._historyFuture.push(entry)
    } else {
      state._historyFuture.pop()
      state._historyPast.push(entry)
    }
    // A step across the stack always ends an in-progress coalescing burst, so
    // the next drag opens a fresh entry instead of folding into the one just
    // undone.
    state._historyCoalesceKey = null
    restoreBoardSnapshot(state, direction === 'undo' ? entry.board!.before : entry.board!.after)
    state.canUndo = state._historyPast.length > 0
    state.canRedo = state._historyFuture.length > 0
  })
}

export function createUndoRedoActions({ get, set }: SiteSliceHelpers): UndoRedoActions {
  return {
    undo: () => {
      const { _historyPast, site } = get()
      if (_historyPast.length === 0) return
      const entry = _historyPast[_historyPast.length - 1]!
      if (isBoardOnlyEntry(entry)) return runBoardStep({ set }, entry, 'undo')
      if (!site) return
      if (entry.structural) return runStructuralStep({ get, set }, entry, entry.structural, 'undo')
      const restored = apply(site, entry.inverse)
      const packageJson = clonePackageJson(restored.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
      // Undo changes the same paths the original mutation did — the restored
      // pages/VCs must be re-saved (and rows the undo removes again become
      // explicit deletions via the pre/post membership diff).
      const dirty = collectDirtyFromSitePatches(entry.inverse, site, restored)
      set((state) => {
        state._historyPast.pop()
        state._historyFuture.push(entry)
        // A transaction that spans BOTH domains restores both halves together.
        if (entry.board) restoreBoardSnapshot(state, entry.board.before)
        // End any in-progress input-coalescing burst so the next keystroke
        // starts a fresh undo entry rather than folding into the undone one.
        state._historyCoalesceKey = null
        state.site = { ...restored, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = state._historyPast.length > 0
        state.canRedo = true
        state.hasUnsavedChanges = true
        mergeDirtyMarks(state._dirtySave, dirty)
        // undo bypasses runHistoricMutation (it applies patches directly), so
        // it is its own node-index invalidation point — same DirtyMarks, same
        // reasoning as helpers.ts. See nodeIndex.ts.
        applyNodeIndexPatch(
          nodeIndexesOf(state),
          site,
          restored,
          dirty,
        )
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
        pruneCanvasSelectionDraft(state)
      })
    },

    redo: () => {
      const { _historyFuture, site } = get()
      if (_historyFuture.length === 0) return
      const entry = _historyFuture[_historyFuture.length - 1]!
      if (isBoardOnlyEntry(entry)) return runBoardStep({ set }, entry, 'redo')
      if (!site) return
      if (entry.structural) return runStructuralStep({ get, set }, entry, entry.structural, 'redo')
      const restored = apply(site, entry.forward)
      const packageJson = clonePackageJson(restored.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
      // Redo re-applies the mutation's paths — mark the replayed pages/VCs
      // (and re-deleted rows, via the pre/post membership diff).
      const dirty = collectDirtyFromSitePatches(entry.forward, site, restored)
      set((state) => {
        state._historyFuture.pop()
        state._historyPast.push(entry)
        if (entry.board) restoreBoardSnapshot(state, entry.board.after)
        state._historyCoalesceKey = null
        state.site = { ...restored, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = true
        state.canRedo = state._historyFuture.length > 0
        state.hasUnsavedChanges = true
        mergeDirtyMarks(state._dirtySave, dirty)
        // redo bypasses runHistoricMutation too — same reasoning as undo above.
        applyNodeIndexPatch(
          nodeIndexesOf(state),
          site,
          restored,
          dirty,
        )
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
        pruneCanvasSelectionDraft(state)
      })
    },
  }
}
