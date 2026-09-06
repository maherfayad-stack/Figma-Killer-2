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
import type { CanvasFitRect } from './canvasZoomFit'

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
 */
export function measureCanvasFrameRects(root: HTMLElement, layer: HTMLElement): CanvasFitRect[] {
  const rootRect = root.getBoundingClientRect()
  const rects: CanvasFitRect[] = []
  for (const frame of layer.querySelectorAll<HTMLElement>('[data-breakpoint-id]')) {
    const r = frame.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    rects.push(toFitRect(r, rootRect))
  }
  return rects
}

/**
 * The current selection, measured from the ALREADY-POSITIONED selection ring
 * element(s) (`[data-canvas-selection-ring="true"]`,
 * `BreakpointSelectionOverlay.tsx`) rather than re-derived from node geometry:
 * the ring is already the exact cross-iframe, `nodeVisualRect`-aware,
 * per-`(frameId,nodeId)`-scoped screen rect a selection has, recomputed every
 * rAF tick by machinery this module has no visibility into (see
 * `canvasSelectionOverlayPositioning.ts`). Multiple rings (multi-select) are
 * unioned by `computeZoomToFitTransform`.
 */
export function measureCanvasSelectionRects(root: HTMLElement): CanvasFitRect[] {
  const rootRect = root.getBoundingClientRect()
  const rects: CanvasFitRect[] = []
  for (const ring of document.querySelectorAll<HTMLElement>('[data-canvas-selection-ring="true"]')) {
    const r = ring.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    rects.push(toFitRect(r, rootRect))
  }
  return rects
}
