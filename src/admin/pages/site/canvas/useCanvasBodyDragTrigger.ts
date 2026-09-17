/**
 * useCanvasBodyDragTrigger — the SECOND way an element drag starts: pressing
 * the element's own body, inside the frame's iframe.
 *
 * Until this existed, the only way to move an element on the canvas was the
 * selection toolbar's hand-grab icon: pressing the element and moving did
 * nothing at all, which is the opposite of what every design tool does and
 * what the user reported.
 *
 * ## Why a native capture-phase listener on the iframe's document
 *
 * Not a React handler on the node, and not a prop threaded through the module
 * prop bag:
 *
 *  - it must run BEFORE `NodeRenderer`'s `onPointerDownCapture` (which focuses
 *    the node and latches authored form-control suppression), and a
 *    document-level capture listener in the iframe is the only position that
 *    is guaranteed to;
 *  - it must see presses on EVERY node, and `NodeRenderer` would need the
 *    handler threaded through a context into every module's prop bag —
 *    per-node work for a gesture that is global by nature (one pointer, one
 *    drag);
 *  - no wrapper element is introduced, which is the canvas's first rule.
 *
 * ## Why it is its own module
 *
 * Extracted from `useCanvasReorderDrag` when S2's session rewrite pushed that
 * file past the module-size ceiling, and the split is real rather than
 * arbitrary: this hook owns the question "does this press mean a drag at
 * all", which is entirely about what ELSE on the canvas claims a pointer (the
 * pan gesture, an inline text edit, a resize handle, an authored
 * contentEditable). The session next door owns what happens once the answer
 * is yes. Neither needs the other's internals — they meet at one call,
 * `beginDrag(origin)`.
 */
import { useEffect, useEffectEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  CANVAS_EDITOR_CONTROL_SELECTOR,
  CANVAS_NODE_SELECTOR,
  isElementLike,
} from './canvasEventTargets'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import type { CanvasDragOrigin } from './canvasDragSession'

interface CanvasBodyDragTriggerOptions {
  /** True when a press on an element's body may start a drag (structural edit permitted). */
  enabled: boolean
  iframeElement: HTMLIFrameElement | null
  /**
   * The in-iframe overlay host. Doubles as the DESIGN-FRAME gate (the injector
   * that creates it is design-mode only, so a live frame never has one) and as
   * the handle on the iframe's CURRENT document — a frame reload mints a new
   * document and a new overlay root together, so keying the listener on this
   * value re-attaches it to the right document automatically.
   */
  overlayRoot: HTMLElement | null
  frameId: string | null
  /** Opens the drag session. Returns false when this press cannot start one. */
  beginDrag: (origin: CanvasDragOrigin) => boolean
}

export function useCanvasBodyDragTrigger({
  enabled,
  iframeElement,
  overlayRoot,
  frameId,
  beginDrag,
}: CanvasBodyDragTriggerOptions): void {
  // Reads the latest render closure (`beginDrag` -> `selectedNodeIds`,
  // `iframeElement`, `frameId`) without becoming a dependency of the effect
  // below — the listener must be attached once per iframe document, not
  // re-attached on every selection change.
  const beginBodyDrag = useEffectEvent((origin: CanvasDragOrigin) => beginDrag(origin))

  /**
   * Deliberately NOT deps-keyed on the selection: it is read fresh from the
   * store inside the handler, so the listener is attached once per iframe
   * document instead of re-attached on every selection change.
   */
  useEffect(() => {
    if (!enabled) return
    const iframe = iframeElement
    const doc = overlayRoot?.ownerDocument ?? null
    if (!iframe || !doc) return

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return
      // Space + left-drag and middle-drag are the canvas's PAN gesture on the
      // same button. `IframeFrameSurface`'s relay claims those; starting a
      // reorder here would make one gesture mean two things.
      if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) return

      const state = useEditorStore.getState()
      // An inline text edit owns the pointer inside its contentEditable: a
      // press-and-drag there is selecting text, not moving the element. Same
      // stand-down the keyboard bridge makes for the same reason.
      if (state.activeInlineEdit) return

      const target = event.target
      if (!isElementLike(target)) return
      // Editor chrome portaled into this SAME document (WS-5.1). The overlay
      // root is `pointer-events: none`, so in practice only the resize handles
      // inside it are pressable — and a resize is `useElementResizeDrag`'s
      // gesture, not this one. Matched on the overlay root rather than the
      // handle so anything else that opts back into pointer events later is
      // excluded by default.
      if (target.closest(CANVAS_EDITOR_CONTROL_SELECTOR)) return
      if (target.closest('[data-studio-canvas-overlay-root]')) return
      // Any authored contentEditable region: the caret is the user's target.
      if (target.closest('[contenteditable]')) return

      const nodeElement = target.closest(CANVAS_NODE_SELECTOR)
      const nodeId = nodeElement?.getAttribute('data-node-id')
      if (!nodeId) return

      // Pressing INSIDE the current selection drags the whole selection —
      // otherwise a multi-select would silently collapse to one node the
      // moment you tried to move it. Pressing outside it drags just that node.
      const selected = state.selectedNodeIds
      const inSelection = selected.includes(nodeId)

      const rect = iframe.getBoundingClientRect()
      const point = iframeLocalPointToParentClientPoint(
        rect,
        { width: iframe.clientWidth, height: iframe.clientHeight },
        { x: event.clientX, y: event.clientY },
      )

      const started = beginBodyDrag({
        pointerId: event.pointerId,
        clientX: point.x,
        clientY: point.y,
        candidateIds: inSelection ? selected : [nodeId],
        preferredDraggedId: nodeId,
        selectOnActivate: inSelection ? null : nodeId,
        frameId,
        altKey: event.altKey,
      })
      if (!started) return

      // Cancel the browser's default press behaviour — text selection and the
      // native image/link drag — both of which fight a pointer drag for the
      // same gesture. Canceling `pointerdown` suppresses the compatibility
      // MOUSE events only; `click` still fires, so `NodeRenderer`'s
      // click-to-select is untouched and a press that never becomes a drag is
      // still an ordinary click. Focus is not lost either: `NodeRenderer`'s
      // `onPointerDownCapture` focuses the node explicitly
      // (`focusNodeWithoutScrolling`) rather than relying on the default.
      event.preventDefault()
    }

    doc.addEventListener('pointerdown', onPointerDown, true)
    return () => doc.removeEventListener('pointerdown', onPointerDown, true)
  }, [enabled, iframeElement, overlayRoot, frameId])
}
