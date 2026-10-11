/**
 * useBoardFrameShortcuts - a `board` scope: Duplicate and Delete for the
 * SELECTED BOARD FRAMES, the two keys a frame header's menu already answers to.
 *
 * Both keys are the menu items' own actions, not new gestures:
 *   - the duplicate key is "Duplicate frame": a copy of each selected frame in
 *     free space beside it, carrying the source's own preview axes
 *     (`duplicateFrameAsVariant`, one undo entry per copy);
 *   - the delete key is "Remove from board": the frame leaves the board and the
 *     page stays in the project (`removeFrame`, one undo entry per frame). It
 *     never deletes the page's file - that is a different, destructive verb
 *     with its own confirmation.
 *
 * Inert unless a frame is selected: a node selection is the `node` rung's, a
 * note or doc card is the `annotation` rung's, and both sit above this one on
 * the ladder (`editorKeyDispatcher.ts`), so a mixed selection never reaches here.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'
import { useEditorKeyScope } from './useEditorKeyDispatcher'

/** Registers the scope. Inert while live, read-only, or with no frame selected. */
export function useBoardFrameShortcuts(editable: boolean, isLive: boolean): void {
  useEditorKeyScope(
    'board',
    () => !isLive && editable && useEditorStore.getState().selectedFrameIds.length > 0,
    (event) => {
      const duplicate = getKeybindingForCommand('layers.duplicate')?.match(event) === true
      const remove = getKeybindingForCommand('layers.delete')?.match(event) === true
      if (!duplicate && !remove) return false
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      const state = useEditorStore.getState()
      const board = selectActiveBoard(state)
      if (!board) return false
      // `selectedFrameIds` holds PAGE ids; a page with several frames is addressed by its first.
      const frames = state.selectedFrameIds.flatMap((pageId) => {
        const found = board.frames.find((candidate) => candidate.pageId === pageId)
        return found ? [found] : []
      })
      if (frames.length === 0) return false

      event.preventDefault()
      if (duplicate) {
        for (const frame of frames) state.duplicateFrameAsVariant(frame.id, { ...frame.axes })
      } else {
        for (const frame of frames) state.removeFrameById(frame.id)
      }
      return true
    },
  )
}
