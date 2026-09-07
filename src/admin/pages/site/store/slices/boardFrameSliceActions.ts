/**
 * boardFrameSliceActions — the `set`/`get` wiring for every FRAME mutation on
 * the active board: position, size, combined rect, membership (add / remove /
 * seed) and the WS-10 "duplicate as variant" / per-frame axes overrides.
 *
 * Split out of `boardSlice.ts` for the reason its three siblings
 * (`boardFrameSelectionActions.ts`, `boardBulkFrameSliceActions.ts`,
 * `boardAnnotationSliceActions.ts`) give for their own splits: the module-size
 * budget. The pure `Board -> Board` transforms stay in `@core/studio-board`;
 * this module is the store shell around them, and `boardSlice.ts` composes it.
 *
 * `store-09` — every action here except `seedFramesForActiveBoard` records ONE
 * undo entry through `commitBoardChange`. The seed is the exception on purpose:
 * it is the one-time default-board hydration `useStudioDefaultBoardSeed` runs
 * at load, not a gesture, and there is nothing for the user to have "just
 * done". Making it undoable would put an entry on the stack before the user
 * has touched anything.
 */
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import {
  getActiveBoard,
  upsertBoard,
  upsertFrame,
  moveFrame,
  resizeFrame,
  removeFrame as removeFrameById,
  removeFramesForPage,
  setFrameAxes as setFrameAxesOnBoard,
  duplicateFrame,
  defaultFramePosition,
  FRAME_WIDTH,
  VARIANT_GAP,
} from '@core/studio-board'
import { boardCoalesceKey, commitBoardChange } from './boardHistory'

type FrameMutationActions = Pick<
  EditorStore,
  | 'setFramePosition'
  | 'setFrameSize'
  | 'setFrameRect'
  | 'removeFrame'
  | 'removeFrameById'
  | 'addFrame'
  | 'seedFramesForActiveBoard'
  | 'duplicateFrameAsVariant'
  | 'setFrameAxes'
>

export function createFrameMutationActions(
  set: Parameters<EditorStoreSliceCreator<EditorStore>>[0],
  get: Parameters<EditorStoreSliceCreator<EditorStore>>[1],
): FrameMutationActions {
  return {
    setFramePosition: (frameId, x, y) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      commitBoardChange(set, get, boardCoalesceKey.frameMove(frameId), upsertBoard(boards, moveFrame(board, frameId, x, y)))
    },

    setFrameSize: (frameId, width, height) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      commitBoardChange(set, get, null, upsertBoard(boards, resizeFrame(board, frameId, width, height)))
    },

    setFrameRect: (frameId, x, y, width, height) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      const moved = moveFrame(board, frameId, x, y)
      const resized = resizeFrame(moved, frameId, width, height)
      commitBoardChange(set, get, boardCoalesceKey.frameRect(frameId), upsertBoard(boards, resized))
    },

    removeFrame: (pageId) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      const nextBoard = removeFramesForPage(board, pageId)
      const removedSomething = nextBoard.frames.length !== board.frames.length
      commitBoardChange(set, get, null, upsertBoard(boards, nextBoard), { explicitRemoval: removedSomething })
    },

    removeFrameById: (frameId) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      const nextBoard = removeFrameById(board, frameId)
      const removedSomething = nextBoard.frames.length !== board.frames.length
      commitBoardChange(set, get, null, upsertBoard(boards, nextBoard), { explicitRemoval: removedSomething })
    },

    addFrame: (pageId) => {
      const { boards, activeBoardId, frameDefaults } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      if (board.frames.some((f) => f.pageId === pageId)) return
      const { x, y } = defaultFramePosition(board.frames.length)
      // WS-7.2 — a page added after "apply to all pages" inherits the
      // project's frame default instead of the hardcoded FRAME_WIDTH/HEIGHT.
      const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
      if (frameDefaults.width) frame.width = frameDefaults.width
      if (frameDefaults.height) frame.height = frameDefaults.height
      commitBoardChange(set, get, null, upsertBoard(boards, upsertFrame(board, frame)))
    },

    seedFramesForActiveBoard: (pageIds) => {
      const { boards, activeBoardId, frameDefaults } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      const existingIds = new Set(board.frames.map((f) => f.pageId))
      const missingIds = pageIds.filter((id) => !existingIds.has(id))
      if (missingIds.length === 0) return

      const nextBoard = missingIds.reduce((acc, pageId, i) => {
        const { x, y } = defaultFramePosition(board.frames.length + i)
        const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
        if (frameDefaults.width) frame.width = frameDefaults.width
        if (frameDefaults.height) frame.height = frameDefaults.height
        return upsertFrame(acc, frame)
      }, board)
      set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
    },

    duplicateFrameAsVariant: (sourceFrameId, axesOverride) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return null
      const source = board.frames.find((f) => f.id === sourceFrameId)
      if (!source) return null

      const newFrameId = crypto.randomUUID()
      const nextBoard = duplicateFrame(board, sourceFrameId, {
        id: newFrameId,
        // Beside the source, same row — the primary way users reach this
        // feature (§4.4), so it must never land exactly on top of its sibling.
        x: source.x + (source.width ?? FRAME_WIDTH) + VARIANT_GAP,
        y: source.y,
        axes: axesOverride,
      })
      if (!nextBoard) return null

      commitBoardChange(set, get, null, upsertBoard(boards, nextBoard), {
        also: (state) => {
          // Select the new frame, mirroring `selectFrame`'s mutual-exclusivity
          // with node selection — the user's next action is almost always
          // "look at the variant I just made". Selection is not undoable, so it
          // rides `also` rather than the recorded snapshot.
          state.selectedFrameIds = [source.pageId]
          if (state.selectedNodeIds.length > 0) {
            state.selectedNodeIds = []
            state.selectedNodeId = null
          }
        },
      })
      return newFrameId
    },

    setFrameAxes: (frameId, axes) => {
      const { boards, activeBoardId } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      commitBoardChange(set, get, null, upsertBoard(boards, setFrameAxesOnBoard(board, frameId, axes)))
    },
  }
}
