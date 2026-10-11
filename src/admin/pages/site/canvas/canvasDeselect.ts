/**
 * canvasDeselect — what a click on NOTHING does: everything selected is let go.
 *
 * "Nothing" has two places on a board, and both end here:
 *  - the empty board itself, around and between the frames
 *    (`useEmptyBoardDeselect`, `isEmptyBoardTarget`);
 *  - a frame's own empty background — the page root's area no child covers,
 *    typically the height below the page's content (`canvasPressTarget.ts`
 *    resolves a press there to `null`, and `onFrameBackgroundClick` lands here).
 *
 * One function so the two can never disagree about what "everything" is: what
 * Escape clears (`clearAllSelections`: nodes, frames, annotations, loose
 * layers) plus vector edit mode, which the selection alone does not end.
 */
import { useEditorStore } from '@site/store/store'
import { exitVectorEdit } from './BoardVectorLayer/vectorEditState'

export function deselectEverything(): void {
  useEditorStore.getState().clearAllSelections()
  exitVectorEdit()
}
