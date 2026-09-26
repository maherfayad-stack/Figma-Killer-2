/**
 * BoardDrawPagePicker — the add-page picker the board tool (B) opens where a
 * draw on the empty board ended (P5-F, IX-13). Its pick lands at the drawn
 * rect: a new page is created with that `placement` (the server writes the
 * page and the frame together), an existing page is added there.
 *
 * The same menu body as the toolbar's "Add page" (`AddPagePickerMenu`), so
 * the two can never offer different pages or write different frames. Opened
 * by `CanvasDrawToolLayer` through the store's `boardDrawRequest`; closing it
 * any way (a pick, Escape, a click outside) clears the request.
 *
 * Parent-document editor chrome: nothing here is inside any frame. The
 * anchor is an empty element the menu needs for its outside-click handling;
 * the menu is POSITIONED at the release point through `getAnchorRect`.
 */
import { useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { AddPagePickerMenu } from './AddPagePicker'

export function BoardDrawPagePicker() {
  const request = useEditorStore((s) => s.boardDrawRequest)
  const board = useEditorStore(selectActiveBoard)
  const setBoardDrawRequest = useEditorStore((s) => s.setBoardDrawRequest)
  const anchorRef = useRef<HTMLSpanElement>(null)

  if (!request || !board) return null

  return (
    <>
      <span ref={anchorRef} data-board-draw-anchor="true" aria-hidden="true" />
      <AddPagePickerMenu
        board={board}
        anchorRef={anchorRef}
        getAnchorRect={() => new DOMRect(request.clientX, request.clientY, 0, 0)}
        placement={request.placement}
        onClose={() => setBoardDrawRequest(null)}
      />
    </>
  )
}
