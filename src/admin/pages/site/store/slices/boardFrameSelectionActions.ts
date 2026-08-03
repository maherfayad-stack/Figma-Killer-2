/**
 * boardFrameSelectionActions — WS-7.1 frame multi-selection (`selectFrame`,
 * `setSelectedFrameIds`, `selectAllFrames`, `clearFrameSelection`). Split out
 * of `boardSlice.ts` purely to stay under the module-size-budget ceiling —
 * same reasoning `boardBulkFrameActions.ts`/`boardAnnotationActions.ts` give
 * for their own splits, but unlike those two this module keeps its own
 * `set`/`get` wiring rather than exporting pure `Board -> Board | null`
 * transforms: every action here mutates `selectedFrameIds` (and, for mutual
 * exclusivity, `selectedNodeIds`/`selectedNodeId`) directly, with no
 * `Board`-shaped value to hand back to a thin caller.
 *
 * `selectedFrameIds` is PAGE-id-keyed, not frame-id-keyed — see
 * `boardSlice.ts`'s module doc (WS-10 Phase 2) for the accepted scope
 * boundary this creates once a page has a "duplicate as variant" sibling.
 */
import type { EditorStore } from '@site/store/types'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { getActiveBoard } from '@core/studio-board'

type FrameSelectionActions = Pick<
  EditorStore,
  'selectFrame' | 'setSelectedFrameIds' | 'selectAllFrames' | 'clearFrameSelection'
>

export function createFrameSelectionActions(
  set: Parameters<EditorStoreSliceCreator<EditorStore>>[0],
  get: Parameters<EditorStoreSliceCreator<EditorStore>>[1],
): FrameSelectionActions {
  return {
    selectFrame: (pageId, mode = 'replace') => {
      const { selectedFrameIds } = get()
      const nextIds =
        mode === 'toggle'
          ? selectedFrameIds.includes(pageId)
            ? selectedFrameIds.filter((id) => id !== pageId)
            : [...selectedFrameIds, pageId]
          : [pageId]
      set((state) => {
        state.selectedFrameIds = nextIds
        // Mutual exclusivity (module doc) — a frame selection replaces any
        // node selection so the Properties panel shows exactly one inspector.
        if (nextIds.length > 0 && state.selectedNodeIds.length > 0) {
          state.selectedNodeIds = []
          state.selectedNodeId = null
        }
      })
    },

    setSelectedFrameIds: (pageIds) => {
      const { selectedFrameIds } = get()
      if (selectedFrameIds.length === 0 && pageIds.length === 0) return
      if (
        selectedFrameIds.length === pageIds.length &&
        selectedFrameIds.every((id, i) => id === pageIds[i])
      ) {
        return
      }
      set((state) => {
        state.selectedFrameIds = pageIds
        if (pageIds.length > 0 && state.selectedNodeIds.length > 0) {
          state.selectedNodeIds = []
          state.selectedNodeId = null
        }
      })
    },

    selectAllFrames: () => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board || board.frames.length === 0) return
      const ids = board.frames.map((f) => f.pageId)
      set((state) => {
        state.selectedFrameIds = ids
        if (state.selectedNodeIds.length > 0) {
          state.selectedNodeIds = []
          state.selectedNodeId = null
        }
      })
    },

    clearFrameSelection: () => {
      if (get().selectedFrameIds.length === 0) return
      set({ selectedFrameIds: [] })
    },
  }
}
