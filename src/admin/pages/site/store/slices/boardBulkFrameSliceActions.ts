/**
 * boardBulkFrameSliceActions — the `set`/`get` wiring for the six WS-7.2 bulk
 * frame actions (`setSelectedFramesSize`, `applyWidthToAllFrames`,
 * `setFrameHeights`, `alignSelectedFrames`, `distributeSelectedFrames`,
 * `tidySelectedFrames`). Split out of `boardSlice.ts` purely to stay under the
 * module-size-budget ceiling — same reasoning `boardFrameSelectionActions.ts`
 * gives for its own split: the pure `Board -> Board | null` transforms
 * already live in `boardBulkFrameActions.ts` (unit-testable on a plain
 * `Board`, no store), this module is just the uniform `set`/`get` shell
 * around all six of them, and `boardSlice.ts` composes it and stays the
 * board/frame slice its name promises.
 */
import type { EditorStore } from '@site/store/types'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { getActiveBoard, upsertBoard } from '@core/studio-board'
import * as bulk from './boardBulkFrameActions'

type BulkFrameActions = Pick<
  EditorStore,
  | 'setSelectedFramesSize'
  | 'applyWidthToAllFrames'
  | 'setFrameHeights'
  | 'alignSelectedFrames'
  | 'distributeSelectedFrames'
  | 'tidySelectedFrames'
>

export function createBulkFrameActions(
  set: Parameters<EditorStoreSliceCreator<EditorStore>>[0],
  get: Parameters<EditorStoreSliceCreator<EditorStore>>[1],
): BulkFrameActions {
  return {
    setSelectedFramesSize: (width, height) => {
      const { boards, activeBoardId, selectedFrameIds } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.setSelectedFramesSize(board, selectedFrameIds, width, height)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },

    applyWidthToAllFrames: (width) => {
      const { boards, activeBoardId, frameDefaults } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.applyWidthToAllFrames(board, width)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true, frameDefaults: { ...frameDefaults, width } })
    },

    setFrameHeights: (heightsByPageId) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.setFrameHeights(board, heightsByPageId)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },

    alignSelectedFrames: (edge) => {
      const { boards, activeBoardId, selectedFrameIds } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.alignSelectedFrames(board, selectedFrameIds, edge)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },

    distributeSelectedFrames: (axis) => {
      const { boards, activeBoardId, selectedFrameIds } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.distributeSelectedFrames(board, selectedFrameIds, axis)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },

    tidySelectedFrames: () => {
      const { boards, activeBoardId, selectedFrameIds } = get()
      const board = getActiveBoard(boards, activeBoardId)
      const nextBoard = board && bulk.tidySelectedFrames(board, selectedFrameIds)
      if (!nextBoard) return
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },
  }
}
