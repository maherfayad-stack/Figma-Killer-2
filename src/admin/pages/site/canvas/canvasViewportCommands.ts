/**
 * canvasViewportCommands — the contract the mounted canvas publishes so
 * chrome that lives OUTSIDE `CanvasRoot` (today: the toolbar's `ZoomControls`)
 * can run a real viewport gesture instead of re-deriving one.
 *
 * ## Why this exists (viewport-01)
 *
 * `zoomToFit` / `zoomToSelection` used to be keyboard-only, with a TODO in
 * `ZoomControls.tsx` explaining that the toolbar renders outside
 * `CanvasViewportActionsContext`. It does, and it always will: `AdminCanvasLayout`
 * paints the `Toolbar` eagerly and mounts the whole editor body — `CanvasRoot`
 * included — behind a lazy boundary BELOW it. There is no common provider to
 * move either component into, and the context's own value is built from refs
 * that only exist once the canvas has mounted.
 *
 * The two honest options were "duplicate the measurement in the toolbar" and
 * "publish the canvas's own commands to the shared channel the toolbar
 * already reads". This is the second. `ZoomControls` already calls
 * `zoomIn`/`zoomOut`/`resetView` off the editor store; `canvasViewportCommands`
 * (see `canvasSlice.ts`) is the same shape for the three gestures that need
 * DOM measurement, published by `CanvasRoot` on mount and cleared on unmount.
 *
 * The commands stay INSIDE `useCanvas` rather than being reimplemented here
 * because they need `transformRef` — the live transform, which leads the
 * store's debounced `zoom`/`panX`/`panY` by up to 100 ms during a gesture (see
 * `CanvasTransform`'s doc in `useCanvas.ts`). Measuring against the store's
 * copy would compute the fit from a stale zoom. Only the DOM *measurement*
 * lives here, shared by the keyboard and toolbar paths alike.
 */
import { uniformInsets, type CanvasFitRect, type ZoomFitInsets } from './canvasZoomFit'

/**
 * The imperative viewport gestures `CanvasRoot` publishes to the editor store
 * while it is mounted in design mode. Each returns `false` when there was
 * nothing to act on (no frames, empty selection, canvas not laid out yet) so
 * a caller can stay silent rather than animating to nowhere.
 */
export interface CanvasViewportCommands {
  /** Fit every visible frame into the viewport, centered (`⇧1`). */
  zoomToFit: () => boolean
  /** Fit the current selection into the viewport, centered (`⇧2`). */
  zoomToSelection: () => boolean
  /**
   * Fill the viewport with every visible frame — the same union as
   * `zoomToFit`, but scaled to COVER rather than contain, so the content
   * bleeds off the short axis instead of leaving letterbox margins.
   */
  zoomToFill: () => boolean
}

/** Convert a viewport-space DOMRect into a rect relative to the canvas root. */
function toFitRect(rect: DOMRect, rootRect: DOMRect): CanvasFitRect {
  return {
    left: rect.left - rootRect.left,
    top: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height,
  }
}

/**
 * Every laid-out breakpoint frame on the canvas, as canvas-root-relative rects.
 *
 * `data-breakpoint-id` sits on each frame's own iframe-viewport wrapper
 * (`BreakpointFrame.tsx`) — one per rendered frame, and unlike
 * `canvas-frame-<id>` it has no `-activate-`/`-live-`/`-collapse-` button
 * siblings sharing the prefix, so a plain attribute-presence selector can't
 * accidentally pick up chrome buttons. Fully-unmeasured (0×0) frames are
 * dropped rather than fitted as points.
 *
 * On a board the unit is the whole frame card (`data-frame-mount`: title bar
 * plus body), so the title strip above a frame is inside the fit instead of
 * landing under the toolbar; sticky notes and docs (`data-annotation-id`) are
 * board objects too and are fitted with the frames. Outside a board (no frame
 * cards) it is each viewport wrapper.
 */
export function measureCanvasFrameRects(root: HTMLElement, layer: HTMLElement): CanvasFitRect[] {
  const rootRect = root.getBoundingClientRect()
  const rects: CanvasFitRect[] = []
  const cards = layer.querySelectorAll<HTMLElement>('[data-frame-mount]')
  const boxes = cards.length > 0
    ? [...cards, ...layer.querySelectorAll<HTMLElement>('[data-annotation-id]')]
    : [...layer.querySelectorAll<HTMLElement>('[data-breakpoint-id]')]
  for (const box of boxes) {
    const r = box.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    rects.push(toFitRect(r, rootRect))
  }
  return rects
}

/** Breathing room kept between fitted content and floating chrome. */
const CHROME_CLEARANCE_PX = 16

/**
 * The margins a fit leaves on each side: the edge padding, but never less than
 * the floating notch (it overlays the canvas root's top edge) plus a little
 * clearance, so a fitted frame's title bar is not hidden beneath it - and, on
 * the right, the width the docked Properties sidebar WILL take.
 *
 * That sidebar is a flex sibling of the canvas root that opens on selection:
 * a fit made while it is closed measures the full-width root, then the first
 * selection narrows the root by the panel's width and the rightmost frame sits
 * under the panel (clicks land in the inspector). Figma fits the viewport that
 * is left once its docked panels are open, so a closed docked sidebar's
 * layout width is reserved here. An open one has already shrunk the root.
 */
export function measureCanvasFitInsets(root: HTMLElement, padding: number): ZoomFitInsets {
  const insets = uniformInsets(padding)
  const sidebar = root.ownerDocument.querySelector<HTMLElement>('[data-testid="right-sidebar"]')
  if (sidebar && sidebar.dataset.mode === 'docked' && sidebar.dataset.expanded === 'false') {
    const reserved = Number.parseFloat(root.ownerDocument.defaultView?.getComputedStyle(sidebar).getPropertyValue('--right-sidebar-panel-layout-width') ?? '')
    if (Number.isFinite(reserved) && reserved > 0) insets.right = Math.max(insets.right, reserved + padding)
  }
  const notch = root.querySelector<HTMLElement>('[data-testid="canvas-notch"]')
  if (notch) {
    const clearance = notch.getBoundingClientRect().bottom - root.getBoundingClientRect().top + CHROME_CLEARANCE_PX
    insets.top = Math.max(insets.top, clearance)
  }
  return insets
}

/**
 * The current selection, measured from the ALREADY-POSITIONED selection ring
 * element(s) (`[data-canvas-selection-ring="true"]`,
 * `BreakpointSelectionOverlay.tsx`) rather than re-derived from node geometry:
 * the ring is already the exact `nodeVisualRect`-aware, per-`(frameId,nodeId)`
 * -scoped rect a selection has, recomputed every rAF tick by machinery this
 * module has no visibility into (`canvasSelectionOverlayPositioning.ts`).
 * Multiple rings (multi-select) are unioned by `computeZoomToFitTransform`.
 *
 * The rings live INSIDE each frame's iframe document (the editor chrome is
 * rendered into the frame it belongs to), so they are read there and projected
 * out through the iframe's own offset and scale. Asking the editor document -
 * the first version of this - found none and made Shift+2 a no-op (R4 N4).
 * A selected FRAME (no layer) has no ring; its card is the selection.
 */
export function measureCanvasSelectionRects(root: HTMLElement): CanvasFitRect[] {
  const rootRect = root.getBoundingClientRect()
  const rects: CanvasFitRect[] = []
  for (const iframe of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
    // A cross-origin (live) frame throws or answers null: its rings are not readable from here.
    let doc: Document | null = null
    try {
      doc = iframe.contentDocument
    } catch (_err) {
      continue
    }
    if (!doc) continue
    const frameRect = iframe.getBoundingClientRect()
    const scale = iframe.clientWidth > 0 ? frameRect.width / iframe.clientWidth : 1
    for (const ring of doc.querySelectorAll<HTMLElement>('[data-canvas-selection-ring="true"]')) {
      const r = ring.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      rects.push({
        left: frameRect.left - rootRect.left + r.left * scale,
        top: frameRect.top - rootRect.top + r.top * scale,
        width: r.width * scale,
        height: r.height * scale,
      })
    }
  }
  if (rects.length > 0) return rects
  for (const card of root.querySelectorAll<HTMLElement>('[data-frame-mount][data-selected="true"]')) {
    const r = card.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    rects.push(toFitRect(r, rootRect))
  }
  return rects
}
