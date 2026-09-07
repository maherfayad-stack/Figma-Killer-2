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
import { refuseStructuralUndo, reissueStructuralMove } from './structuralHistory'
import type { HistoryEntry, SiteSlice, SiteSliceHelpers, StructuralHistory } from './types'

type UndoRedoActions = Pick<SiteSlice, 'undo' | 'redo'>

/**
 * `store-08` — a structural transaction is undone by RE-ISSUING the gesture,
 * never by replaying its patches. See `structuralHistory.ts` for why: the
 * user's `.tsx` is the document, and `saveSite` diffs values, not structure.
 *
 * Returns whether this function handled the entry. `false` means "not
 * structural — take the patch path".
 *
 * The stack bookkeeping is done by hand because the re-issued gesture is an
 * ordinary mutation: it pushes its own history entry and clears the redo
 * stack. Both are corrected here, so one Ctrl+Z consumes exactly one entry and
 * a pending redo chain survives.
 */
function runStructuralStep(
  { get, set }: Pick<SiteSliceHelpers, 'get' | 'set'>,
  entry: HistoryEntry,
  structural: StructuralHistory,
  direction: 'undo' | 'redo',
): boolean {
  if (structural.gesture !== 'move') {
    refuseStructuralUndo(structural.gesture)
    return true
  }
  const from = direction === 'undo' ? '_historyPast' : '_historyFuture'
  const to = direction === 'undo' ? '_historyFuture' : '_historyPast'
  // Both stacks are snapshotted BEFORE the re-issue and assigned wholesale
  // after it. The re-issued gesture pushes its own entry onto `_historyPast`
  // and clears `_historyFuture` (`commitHistoryEntry`), so anything computed from
  // the post-gesture stacks would double-count in one direction and silently
  // drop a pending redo chain in the other.
  const fromBefore = [...get()[from]]
  const toBefore = [...get()[to]]

  if (!reissueStructuralMove(get, direction === 'undo' ? structural.undo : structural.redo)) {
    return true
  }

  set((state) => {
    state[from] = fromBefore.slice(0, -1)
    state[to] = [...toBefore, entry]
    state._historyCoalesceKey = null
    state.canUndo = state._historyPast.length > 0
    state.canRedo = state._historyFuture.length > 0
  })
  return true
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
      if (entry.structural && runStructuralStep({ get, set }, entry, entry.structural, 'undo')) return
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
      if (entry.structural && runStructuralStep({ get, set }, entry, entry.structural, 'redo')) return
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
