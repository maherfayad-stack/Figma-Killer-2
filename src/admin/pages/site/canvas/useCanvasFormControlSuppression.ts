import { useEffect } from 'react'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'

const CANVAS_NODE_SELECTOR = '[data-node-id]'
const CANVAS_EDITOR_CONTROL_SELECTOR = '[data-canvas-interactive="true"]'
const CANVAS_FORM_CONTROL_SELECTOR = 'input, textarea, select, button'

interface CanvasFormControlSuppressionOptions {
  enabled: boolean
}

/**
 * Canvas design mode renders real authored form controls, but they are still
 * canvas nodes. Suppress their NATIVE activation — focus, autofill, a
 * `<select>`'s picker — before the browser can show any of it.
 *
 * This hook only cancels. It never selects: which layer a press on a control
 * selects, and whether it selects anything at all (a press can still become a
 * drag), is decided on RELEASE by `NodeRenderer`, through the same
 * `canvasPressTarget.ts` resolution every other press uses. It used to select
 * a `<select>`'s node on `pointerdown`, and the cancellation it made there
 * also turned away the body-drag trigger, which is why a component rendering
 * a real `<button>` could never be dragged by its body — its "click state"
 * always won. (`useCanvasBodyDragTrigger` no longer reads `defaultPrevented`.)
 *
 * Portal mode only (`live-05`, STATE.md, Batch 3) — reads the frame's
 * `Document` through `PortalFrameAdapter`'s escape hatch. A bridge frame's
 * runtime cancels every design-mode press in its own document
 * (`gestureForwarding.ts`'s `editorOwnsGesture`), which stops the focus a
 * press would give a control; a bridge frame has no equivalent of the
 * `focusin` blur below.
 */
export function useCanvasFormControlSuppression(
  adapter: FrameDocumentAdapter | null,
  { enabled }: CanvasFormControlSuppressionOptions,
): void {
  useEffect(() => {
    if (!enabled) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return

    const suppressPointerActivation = (event: Event) => {
      if (getAuthoredFormControlEventTarget(event.target)) event.preventDefault()
    }

    const suppressFocus = (event: Event) => {
      if (!getAuthoredFormControlEventTarget(event.target)) return
      event.preventDefault()
      if (isFocusableElement(event.target)) event.target.blur()
    }

    iframeDoc.addEventListener('pointerdown', suppressPointerActivation, { capture: true, passive: false })
    iframeDoc.addEventListener('mousedown', suppressPointerActivation, { capture: true, passive: false })
    iframeDoc.addEventListener('focusin', suppressFocus, { capture: true })
    return () => {
      iframeDoc.removeEventListener('pointerdown', suppressPointerActivation, { capture: true })
      iframeDoc.removeEventListener('mousedown', suppressPointerActivation, { capture: true })
      iframeDoc.removeEventListener('focusin', suppressFocus, { capture: true })
    }
  }, [enabled, adapter])
}

function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}

function getAuthoredFormControlEventTarget(target: EventTarget | null): Element | null {
  if (!isElementLike(target)) return null
  const control = target.closest(CANVAS_FORM_CONTROL_SELECTOR)
  if (!control) return null
  if (target.closest(CANVAS_EDITOR_CONTROL_SELECTOR)) return null
  return target.closest(CANVAS_NODE_SELECTOR) ? control : null
}

function isFocusableElement(target: EventTarget | null): target is HTMLElement {
  return isElementLike(target) && typeof (target as HTMLElement).blur === 'function'
}
