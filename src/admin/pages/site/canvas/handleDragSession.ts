/**
 * handleDragSession — the pointer, key and lifetime plumbing of ONE drag on a
 * selection handle inside a frame, shared by the single-element resize
 * (`useElementResizeDrag`), the multi-selection resize (`useGroupResizeDrag`,
 * P5-F / IX-6g) and rotation (`useElementRotateDrag`, P5-F / IX-25).
 *
 * They differ in WHAT a step computes and writes; they must not differ in how
 * a drag starts, follows the pointer, reads ⇧ / ⌥, ends, cancels or is
 * abandoned — those are the ERR-12 and IX-6c guarantees, and a second copy of
 * them is how one of them would lose one. So this module owns:
 *
 *  - the canvas-gesture freeze (`beginCanvasGesture` / `endCanvasGesture`)
 *    and, for a resize, the frame's `RESIZE_ACTIVE_ATTR` (the W×H badge,
 *    IX-18);
 *  - pointer capture on the handle, and the pointer listeners on the frame
 *    document (a pointer event inside the iframe is already in the frame's
 *    own CSS px — see `useElementResizeDrag`'s docblock on zoom);
 *  - ⇧ / ⌥ read on every move AND every key change (IX-6c), and Escape,
 *    claimed in the capture phase of both documents;
 *  - ONE write per animation frame — the caller's `paint`;
 *  - `guardDragSession` (ERR-12): a move with the button up finishes at the
 *    last point shown, a window blur abandons.
 *
 * The caller supplies three callbacks: `step` (read-free: the pointer delta
 * and modifiers to a new state), `paint` (the write phase, once per frame)
 * and `end` (restore previews, then commit when asked), and gets back the
 * cancel function to call if its handles are torn down mid-drag.
 */
import { guardDragSession, resizeModifiersOf, type ResizeModifiers } from '@core/studio-runtime'
import { beginCanvasGesture, endCanvasGesture } from './canvasGesture'

export interface HandleDragCallbacks {
  /** A new pointer delta (frame-document px) or modifier state. Compute; do not write. */
  step(dx: number, dy: number, modifiers: ResizeModifiers): void
  /** The write phase, at most once per animation frame. */
  paint(): void
  /**
   * The drag is over. Restore every preview FIRST, then write when `commit`
   * (the preview-then-commit contract). Called after every listener is gone
   * and before the gesture freeze lifts, so the settle pass measures the
   * committed state.
   */
  end(commit: boolean): void
}

export interface HandleDragInput {
  /** The `pointerdown` that pressed the handle. */
  event: PointerEvent
  handleEl: HTMLElement
  /** The handle frame. */
  frame: HTMLElement
  /**
   * The attribute the frame carries for the length of the drag —
   * `RESIZE_ACTIVE_ATTR` for a resize (it shows the W×H badge), or `null`.
   */
  activeAttr: string | null
  iframeDoc: Document
  /** `K4`'s scale tool, latched for the gesture: ⇧ as if held. */
  scaleTool: boolean
  callbacks: HandleDragCallbacks
}

/** Start the drag. Returns the cancel to call if the handles go away under it. */
export function startHandleDrag(input: HandleDragInput): () => void {
  const { event, handleEl, frame, activeAttr, iframeDoc, scaleTool, callbacks } = input
  const startX = event.clientX
  const startY = event.clientY
  let pointer = { x: startX, y: startY }
  let modifiers = resizeModifiersOf(event, scaleTool)
  let finished = false

  // Freeze the expensive derived geometry (the parent-doc anchor session,
  // the frame's auto-height refit) for the length of the drag — this gesture
  // changes layout on every frame, which is exactly what those two are built
  // to assume does not happen. See `canvasGesture.ts`.
  const gesture = beginCanvasGesture()
  if (activeAttr) frame.setAttribute(activeAttr, 'true')

  try {
    handleEl.setPointerCapture(event.pointerId)
  } catch (_err) {
    // A capture the browser refuses (a pointer already released) is not
    // fatal — the document-level listeners below still drive the drag.
  }

  // Coalesced to ONE write per animation frame. A pointermove stream runs
  // well past 60Hz on a trackpad or a high-rate mouse, and every size write
  // invalidates layout for the whole page inside the frame — writing once per
  // frame cannot fall behind the cursor, and loses nothing.
  let pendingFrame: number | null = null
  const applyPending = () => {
    pendingFrame = null
    callbacks.paint()
  }
  const step = () => {
    callbacks.step(pointer.x - startX, pointer.y - startY, modifiers)
    pendingFrame ??= requestAnimationFrame(applyPending)
  }

  const onMove = (moveEvent: PointerEvent) => {
    pointer = { x: moveEvent.clientX, y: moveEvent.clientY }
    modifiers = resizeModifiersOf(moveEvent, scaleTool)
    step()
  }

  // Keys go to whichever document holds focus — the frame after a click on
  // the page, the editor after a click in a panel — so the drag listens on
  // both, in the capture phase, and CLAIMS what it uses: an Escape that ends
  // the drag must not also deselect through the dispatcher, and a ⌥ that
  // means "from the centre" must not also open the Alt-hover tree ladder.
  const keyDocuments = [iframeDoc, document]
  const onKey = (keyEvent: KeyboardEvent) => {
    if (keyEvent.type === 'keydown' && keyEvent.key === 'Escape') {
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      finish(false)
      return
    }
    if (keyEvent.key !== 'Shift' && keyEvent.key !== 'Alt') return
    keyEvent.stopPropagation()
    // A bare Alt release focuses the browser's menu on Windows, which would
    // blur the page and abandon the drag.
    if (keyEvent.key === 'Alt') keyEvent.preventDefault()
    modifiers = resizeModifiersOf(keyEvent, scaleTool)
    step()
  }

  const finish = (commit: boolean) => {
    if (finished) return
    finished = true
    disposeGuard()
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    iframeDoc.removeEventListener('pointermove', onMove)
    iframeDoc.removeEventListener('pointerup', onUp)
    iframeDoc.removeEventListener('pointercancel', onCancel)
    for (const doc of keyDocuments) {
      doc.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('keyup', onKey, true)
    }
    if (activeAttr) frame.removeAttribute(activeAttr)
    try {
      handleEl.releasePointerCapture(event.pointerId)
    } catch (_err) {
      // Already released with the pointer — nothing to undo.
    }
    callbacks.end(commit)
    // Unfreeze AFTER the commit, so the single settle pass measures the final
    // size rather than the last previewed one.
    endCanvasGesture(gesture)
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // ERR-12 — registered BEFORE the move listener below, so a move with the
  // button already up finishes the drag instead of being a step.
  const disposeGuard = guardDragSession({
    documents: [iframeDoc],
    focusWindow: window,
    onReleaseLost: () => finish(true),
    onAbandon: () => finish(false),
  })
  iframeDoc.addEventListener('pointermove', onMove)
  iframeDoc.addEventListener('pointerup', onUp)
  iframeDoc.addEventListener('pointercancel', onCancel)
  for (const doc of keyDocuments) {
    doc.addEventListener('keydown', onKey, true)
    doc.addEventListener('keyup', onKey, true)
  }

  return onCancel
}
