/**
 * elementResizeGuides — where a resize's snap guides are drawn (P2-E / IX-6e):
 * the frame's own parent-document drag layer, never the frame — canvas DOM is
 * the user's DOM. Which edge snaps, and to what, is `@core/studio-runtime`'s
 * `elementResizeSnapRules.ts`, shared by both resize hosts; this module is the
 * parent-side paint both of them end in. A portal drag paints here directly
 * (`useElementResizeDrag.ts`); a live frame posts its guides as
 * `resize:guides` and `useBridgeFrameInteraction.ts` paints them here.
 */
import type { SnapGuide } from '@core/studio-runtime'
import { clientRectToViewportRect, getViewportZoom } from './canvasDomGeometry'
import { paintCanvasDrag } from './canvasDragPainter'
import { listCanvasDropSurfaces } from './canvasDropSurfaceRegistry'

/**
 * Where a resize's guides are painted: the frame's own parent-document drag
 * layer, plus the offset that turns a frame-document point into that layer's
 * space and the canvas zoom — all three from ONE read of two rects, at
 * pointerdown. The layer sits inside `CanvasTransformLayer` with the iframe,
 * so frame-document px and layer px differ only by the iframe's offset in its
 * viewport (the same conversion `measureCanvasDropCandidates` applies).
 *
 * `null` for a frame with no registered drop surface (a Viewer, a test): the
 * resize still snaps, it just draws no guide.
 */
export interface ResizeGuideSurface {
  layer: HTMLElement
  originX: number
  originY: number
  zoom: number
}

export function resolveResizeGuideSurface(iframe: Element | null): ResizeGuideSurface | null {
  if (!iframe) return null
  const surface = listCanvasDropSurfaces().find((candidate) => candidate.iframe === iframe)
  const layer = surface?.dropLayer() ?? null
  if (!surface || !layer) return null
  const origin = clientRectToViewportRect(surface.viewport, iframe.getBoundingClientRect())
  return { layer, originX: origin.left, originY: origin.top, zoom: getViewportZoom(surface.viewport) }
}

/** The canvas zoom a frame is drawn at, from its iframe element alone (no drop surface). */
export function iframeZoom(iframe: Element | null): number {
  if (!iframe || !(iframe instanceof HTMLElement) || iframe.offsetWidth <= 0) return 1
  return iframe.getBoundingClientRect().width / iframe.offsetWidth
}

/** Paint (or, with an empty list, clear) the guides of one resize step. */
export function paintResizeGuides(surface: ResizeGuideSurface | null, guides: readonly SnapGuide[]): void {
  if (!surface) return
  if (guides.length === 0) {
    paintCanvasDrag(surface.layer, null)
    return
  }
  paintCanvasDrag(surface.layer, {
    target: null,
    invalid: null,
    ghost: null,
    guides: guides.map((guide) => {
      const along = guide.axis === 'x' ? surface.originX : surface.originY
      const across = guide.axis === 'x' ? surface.originY : surface.originX
      return { ...guide, position: guide.position + along, start: guide.start + across, end: guide.end + across }
    }),
  })
}
