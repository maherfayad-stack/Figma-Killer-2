/**
 * useAnnotationInteraction — the pointer behaviour every board annotation (a
 * sticky note, a doc card) shares: select, drag to move, drag a handle to
 * resize, and open a context menu.
 *
 * Notes and docs had two independent copies of the move gesture before this
 * (identical down to the `screenDelta / zoom` conversion and the
 * `collectPeerRects` snap call), and adding resize + selection would have made
 * that three copies of three gestures. Everything genuinely note- or
 * doc-specific — what the card LOOKS like, what its chrome does, how its text
 * is edited — stays in the view; only the geometry lives here.
 *
 * Screen-space deltas are divided by the canvas `zoom` so a card tracks the
 * cursor 1:1 at any zoom level, and pointer capture keeps the handlers firing
 * when the cursor leaves the card mid-drag. Both are the same rules
 * `BoardFrameView` follows; this hook is the annotation-side counterpart to
 * its frame-side implementation.
 *
 * Mid-drag positions go through the store on every move (not a ref-write like
 * the ruler guides): an annotation's position is real board state that the
 * snap guides, the peer-rect collection and the autosave all read, and the
 * arrays involved are small.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { MIN_ANNOTATION_SIZE, type AnnotationRef } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { computeSnap, collectPeerRects, SNAP_THRESHOLD_BOARD_UNITS } from './boardSnapping'
import { resizeRect, type ResizeHandle, type ResizeRect } from './rectResize'

export interface AnnotationRect {
  x: number
  y: number
  w: number
  h: number
}

interface MoveDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  originX: number
  originY: number
}

interface ResizeDragState {
  pointerId: number
  handle: ResizeHandle
  startClientX: number
  startClientY: number
  anchor: ResizeRect
}

interface UseAnnotationInteractionParams {
  ref: AnnotationRef
  rect: AnnotationRect
  /** Called with the snapped board position on every move. */
  onMove: (x: number, y: number) => void
}

export function useAnnotationInteraction({ ref, rect, onMove }: UseAnnotationInteractionParams) {
  const moveDragRef = useRef<MoveDragState | null>(null)
  const resizeDragRef = useRef<ResizeDragState | null>(null)
  const selectAnnotation = useEditorStore((s) => s.selectAnnotation)
  const resizeAnnotation = useEditorStore((s) => s.resizeAnnotation)

  /**
   * Selection on POINTERDOWN rather than click, so a drag that starts on an
   * unselected card selects it before it moves — otherwise the first drag
   * would move an unselected card and leave the panel showing something else.
   * Shift/Cmd toggles into the set, matching frame multi-selection.
   */
  const select = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    selectAnnotation(ref, additive ? 'toggle' : 'replace')
  }

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    moveDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: rect.x,
      originY: rect.y,
    }
  }

  const onMovePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = moveDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const rawX = drag.originX + (event.clientX - drag.startClientX) / zoom
    const rawY = drag.originY + (event.clientY - drag.startClientY) / zoom

    // Snap to the OTHER furniture on the board — every frame, note and doc
    // except this one.
    const board = selectActiveBoard(useEditorStore.getState())
    const peers = board ? collectPeerRects(board, ref) : []
    const snapped = computeSnap(
      { x: rawX, y: rawY, width: rect.w, height: rect.h },
      peers,
      SNAP_THRESHOLD_BOARD_UNITS,
    )
    useEditorStore.getState().setBoardSnapGuides(snapped.guides)
    onMove(snapped.x, snapped.y)
  }

  const startResize = (handle: ResizeHandle) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    // Never let a handle drag reach the card body's own move gesture.
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    select(event)
    resizeDragRef.current = {
      pointerId: event.pointerId,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      anchor: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    }
  }

  const onResizePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = resizeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const next = resizeRect(
      drag.anchor,
      drag.handle,
      (event.clientX - drag.startClientX) / zoom,
      (event.clientY - drag.startClientY) / zoom,
      MIN_ANNOTATION_SIZE,
    )
    resizeAnnotation(ref, { x: next.x, y: next.y, w: next.width, h: next.height })
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (moveDragRef.current?.pointerId === event.pointerId) {
      moveDragRef.current = null
      useEditorStore.getState().setBoardSnapGuides([])
    }
    if (resizeDragRef.current?.pointerId === event.pointerId) {
      resizeDragRef.current = null
    }
  }

  return {
    select,
    startMove,
    onMovePointerMove,
    startResize,
    onResizePointerMove,
    endDrag,
  }
}
