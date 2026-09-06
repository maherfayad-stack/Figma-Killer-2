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
import { getActiveBoard, moveFrame, upsertBoard } from '@core/studio-board'
import { firstFrameForPage } from './boardBulkFrameActions'

type FrameSelectionActions = Pick<
  EditorStore,
  | 'selectFrame'
  | 'setSelectedFrameIds'
  | 'selectAllFrames'
  | 'clearFrameSelection'
  | 'nudgeSelectedFrames'
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

    /**
     * viewport-01 — move every selected frame by a board-space delta
     * (arrow-key nudge: 1 unit, 10 with Shift). ONE `set()` for the whole
     * selection, so a press costs one `Board` reallocation and one
     * `boardsDirty` flip — the same shape `nudgeSelectedAnnotations` uses.
     *
     * Board layout is NOT in the page-tree undo history. It persists to
     * `.studio/boards.json` through `AdminCanvasLayout`'s debounced
     * auto-save (`BOARDS_AUTOSAVE_DEBOUNCE_MS`), which is what actually
     * coalesces a burst of held-arrow nudges into a single write; ⌘Z does
     * not (and never did) rewind a frame move.
     *
     * `selectedFrameIds` is page-id-keyed, so this reaches the FIRST frame
     * of each selected page — the documented WS-10 Phase 2 scope boundary
     * every other bulk frame action shares.
     */
    nudgeSelectedFrames: (dx, dy) => {
      if (dx === 0 && dy === 0) return
      const { boards, activeBoardId, selectedFrameIds } = get()
      if (selectedFrameIds.length === 0) return
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return

      let nextBoard = board
      let moved = false
      for (const pageId of selectedFrameIds) {
        const frame = firstFrameForPage(nextBoard, pageId)
        if (!frame) continue
        nextBoard = moveFrame(nextBoard, frame.id, frame.x + dx, frame.y + dy)
        moved = true
      }
      // A selection of ids that no longer resolve to frames must not flip
      // `boardsDirty` and trigger a pointless save.
      if (!moved) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },
  }
}
