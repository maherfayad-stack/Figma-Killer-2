/**
 * useBoardFrameMoveDrag — dragging a board frame by its header.
 *
 * Extracted from `BoardFrameView.tsx` when K2's Alt+drag pushed that file past
 * the module-size ceiling, and the split is a real one: the view owns what a
 * frame LOOKS like (header chrome, rename, context menu, the breakpoint frame
 * inside it) while this hook owns one gesture end to end — press, snap, spawn
 * a copy, cancel, release. The resize handles stay in the view because they
 * are a different gesture with different geometry (`resizeRect`), not because
 * they belong there more.
 *
 * ## Pointer capture, not a RAF loop
 *
 * Deliberate, and gated: `overlayRafDiscipline.test.ts` asserts that no board
 * furniture drag runs an animation-frame loop, because an always-hot loop
 * across N frames defeats frame virtualisation. Board furniture moves by a
 * store write per pointermove, which is cheap because a frame's position is
 * ONE number pair in `boards.json` — unlike the element drag next door, whose
 * per-move work is a whole-page hit test and which therefore does need a rAF.
 *
 * ## One store write per move (D2 G8)
 *
 * This used to be two: `setBoardSnapGuides` AND `setFramePosition`, on every
 * pointermove, where the guide list was almost always identical to the last
 * one (usually empty). `setBoardSnapGuides` now no-ops on an equal list
 * (`snapGuidesEqual`), so the second write costs nothing until the guides
 * actually change.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { collectPeerRects } from '../boardSnapping'
import { computeSnap, snapThresholdAtZoom } from '@core/studio-runtime'

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  frameX: number
  frameY: number
  /**
   * K2 — Alt was held at `pointerdown`: this drag moves a COPY, and the
   * original stays where it is.
   *
   * Latched at press rather than read per move (unlike the ELEMENT drag,
   * where Alt is live): a frame copy is a real object in `boards.json` the
   * moment it exists, so letting the modifier toggle mid-gesture would mean
   * creating and destroying a board frame on every keypress.
   */
  duplicating: boolean
  /**
   * The frame this drag is actually moving. The source's id for an ordinary
   * drag; the COPY's id once an Alt+drag has spawned one.
   */
  movingFrameId: string
}

interface BoardFrameMoveDragOptions {
  /** The frame being dragged, and where it currently sits in board units. */
  frameId: string
  pageId: string
  x: number
  y: number
  /** Rendered size, for the snap rect. */
  width: number
  height: number
}

export interface BoardFrameMoveDragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  /** Bound to BOTH `onPointerUp` and `onPointerCancel` — a cancelled drag keeps what it moved. */
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
}

export function useBoardFrameMoveDrag({
  frameId,
  pageId,
  x,
  y,
  width,
  height,
}: BoardFrameMoveDragOptions): BoardFrameMoveDragHandlers {
  const dragRef = useRef<DragState | null>(null)

  /**
   * D2 G8 — Escape abandons a frame drag.
   *
   * Unlike the element drag (which writes nothing until `pointerup`), a frame
   * drag writes its position live, so cancelling has to put the frame back
   * where the press started — `DragState` is already carrying exactly that.
   * A cancelled Alt+drag takes its copy with it instead. The coalescing burst
   * is closed either way, so the cancelled drag does not fold into whatever
   * the user does next.
   *
   * On `window` rather than the header: the pointer is captured by the header
   * but keyboard focus is not, so a keydown during the drag lands wherever
   * focus already was.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const drag = dragRef.current
      if (event.key !== 'Escape' || !drag) return
      event.preventDefault()
      event.stopPropagation()
      dragRef.current = null
      const store = useEditorStore.getState()
      if (drag.movingFrameId !== frameId) store.removeFrameById(drag.movingFrameId)
      else store.setFramePosition(frameId, drag.frameX, drag.frameY)
      store.setBoardSnapGuides([])
      store.endBoardGesture()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [frameId])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary (left) button starts a move-drag — a right-click's
    // pointerdown must fall through to `onContextMenu` untouched, never
    // arming drag state (see `BoardFrameView`'s "Drag-to-reposition" note).
    if (e.button !== 0) return
    // WS-7.1 — select on pointerDOWN (not click/mouseup), matching Figma:
    // pressing a frame's header selects it immediately, and a drag that
    // follows moves the now-selected frame. Plain click replaces the
    // selection; Shift-click extends it (toggle-add).
    useEditorStore.getState().selectFrame(pageId, e.shiftKey ? 'toggle' : 'replace')
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      frameX: x,
      frameY: y,
      duplicating: e.altKey,
      movingFrameId: frameId,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom

    // Snap to the OTHER furniture on the board (Phase 6B) — every other
    // frame, note, and doc, excluding this frame's own page.
    const board = selectActiveBoard(useEditorStore.getState())
    const peers = board ? collectPeerRects(board, { kind: 'frame', pageId }) : []
    const snapped = computeSnap(
      { x: drag.frameX + dx, y: drag.frameY + dy, width, height },
      peers,
      // IX-5a — the same screen-px pull at every zoom.
      snapThresholdAtZoom(zoom),
    )

    // K2 — an Alt+drag spawns its copy on the FIRST move, not at
    // `pointerdown`: a plain Alt+click that never travels must not leave a
    // stray frame on the board. From here on the drag moves the copy and the
    // original never hears about this gesture again.
    if (drag.duplicating && drag.movingFrameId === frameId) {
      const copyId = useEditorStore.getState().duplicateFrameAt(frameId, drag.frameX, drag.frameY)
      if (!copyId) {
        // The source frame is gone (removed under the gesture) — abandon
        // rather than silently moving the original the user did not grab.
        dragRef.current = null
        return
      }
      drag.movingFrameId = copyId
    }

    useEditorStore.getState().setBoardSnapGuides(snapped.guides)
    useEditorStore.getState().setFramePosition(drag.movingFrameId, snapped.x, snapped.y)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    useEditorStore.getState().setBoardSnapGuides([])
    // `store-09` — close the undo-coalescing burst this drag opened, so a
    // second drag of the SAME frame is its own ⌘Z step.
    useEditorStore.getState().endBoardGesture()
  }

  return { onPointerDown, onPointerMove, onPointerUp }
}
