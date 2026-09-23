import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { canvasClickSelectionMode } from './canvasSelectionUtils'

const CANVAS_NODE_SELECTOR = '[data-node-id]'
const CANVAS_EDITOR_CONTROL_SELECTOR = '[data-canvas-interactive="true"]'
const CANVAS_FORM_CONTROL_SELECTOR = 'input, textarea, select, button'

interface CanvasFormControlSuppressionOptions {
  breakpointId: string
  enabled: boolean
}

/**
 * Canvas design mode renders real authored form controls, but they are still
 * canvas nodes. Suppress native activation before browser autofill/select UI
 * appears, while preserving canvas selection.
 *
 * Portal mode only (`live-05`, STATE.md, Batch 3) — reads the frame's
 * `Document` through `PortalFrameAdapter`'s escape hatch. Bridge mode is a
 * documented gap, not a silent one: suppressing a native control's default
 * activation (`preventDefault`/`stopPropagation`/`blur()`) has to run INSIDE
 * the cross-origin frame, which means it needs a real `runtime.ts` behavior
 * analogous to `hoverSuppressionRules.ts` — a new capability, not a message
 * translation, and out of this batch's scope. `interaction='canvas'` (design
 * mode) against a bridge frame currently leaves native form controls
 * un-suppressed; flag this to whoever wires up `documentMode==='bridge'` for
 * real.
 */
export function useCanvasFormControlSuppression(
  adapter: FrameDocumentAdapter | null,
  { breakpointId, enabled }: CanvasFormControlSuppressionOptions,
): void {
  useEffect(() => {
    if (!enabled) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    let latestPointerActivatedSelect: Element | null = null
    let latestActivatedSelectForClick: Element | null = null

    const suppressPointerActivation = (event: Event) => {
      const control = getAuthoredFormControlEventTarget(event.target)
      if (!control) return
      event.preventDefault()
      if (control.tagName !== 'SELECT') return
      if (event.type === 'mousedown' && latestPointerActivatedSelect === control) {
        latestPointerActivatedSelect = null
        return
      }
      if (event.type === 'pointerdown') latestPointerActivatedSelect = control
      latestActivatedSelectForClick = control
      activateCanvasNodeFromNativeControlEvent(event, breakpointId)
    }

    const suppressClickActivation = (event: Event) => {
      const control = getAuthoredFormControlEventTarget(event.target)
      if (!control || control.tagName !== 'SELECT') return
      event.preventDefault()
      event.stopPropagation()
      if (latestActivatedSelectForClick === control) {
        latestActivatedSelectForClick = null
        return
      }
      activateCanvasNodeFromNativeControlEvent(event, breakpointId)
    }

    const suppressFocus = (event: Event) => {
      if (!getAuthoredFormControlEventTarget(event.target)) return
      event.preventDefault()
      if (isFocusableElement(event.target)) event.target.blur()
    }

    iframeDoc.addEventListener('pointerdown', suppressPointerActivation, { capture: true, passive: false })
    iframeDoc.addEventListener('mousedown', suppressPointerActivation, { capture: true, passive: false })
    iframeDoc.addEventListener('click', suppressClickActivation, { capture: true })
    iframeDoc.addEventListener('focusin', suppressFocus, { capture: true })
    return () => {
      iframeDoc.removeEventListener('pointerdown', suppressPointerActivation, { capture: true })
      iframeDoc.removeEventListener('mousedown', suppressPointerActivation, { capture: true })
      iframeDoc.removeEventListener('click', suppressClickActivation, { capture: true })
      iframeDoc.removeEventListener('focusin', suppressFocus, { capture: true })
    }
  }, [breakpointId, enabled, adapter])
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

function activateCanvasNodeFromNativeControlEvent(event: Event, breakpointId: string): void {
  if (!isElementLike(event.target)) return
  const node = event.target.closest(CANVAS_NODE_SELECTOR)
  const nodeId = node?.getAttribute('data-node-id')
  if (!nodeId) return
  const state = useEditorStore.getState()
  if (breakpointId !== state.activeBreakpointId) state.setActiveBreakpoint(breakpointId)
  // The same modifier reading as every other canvas click (OD-3).
  state.selectNode(nodeId, canvasClickSelectionMode(event as MouseEvent))
  state.setFocusedPanel('canvas')
}
