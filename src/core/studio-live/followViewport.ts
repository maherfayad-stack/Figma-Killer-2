/**
 * Follow-mode maths, pure so it can be tested without a canvas.
 *
 * A canvas shows board point `b` at `offset + pan + zoom * b` (relative to the
 * canvas root), where `offset` is the transform layer's CSS inset. The sender
 * publishes the board rectangle it sees; the follower picks the zoom that fits
 * that whole rectangle in its own (possibly differently sized) viewport and
 * centres on it.
 */
import type { LiveViewport } from './protocol'

export interface ViewportGeometry {
  /** Canvas root size in CSS px. */
  rootWidth: number
  rootHeight: number
  /** The transform layer's own CSS inset from the root. */
  offsetX: number
  offsetY: number
}

export interface CanvasTransformValue {
  zoom: number
  panX: number
  panY: number
}

/** The board rectangle the canvas currently shows. */
export function visibleBoardRect(geometry: ViewportGeometry, transform: CanvasTransformValue): LiveViewport {
  const { zoom, panX, panY } = transform
  return {
    x: (0 - geometry.offsetX - panX) / zoom,
    y: (0 - geometry.offsetY - panY) / zoom,
    w: geometry.rootWidth / zoom,
    h: geometry.rootHeight / zoom,
    zoom,
  }
}

/**
 * The transform that frames `target` in `geometry`'s viewport, or `null` when
 * the viewport has no size yet. `clampZoom` is the editor's own zoom clamp.
 */
export function transformToFollow(
  target: LiveViewport,
  geometry: ViewportGeometry,
  clampZoom: (zoom: number) => number,
): CanvasTransformValue | null {
  if (geometry.rootWidth <= 0 || geometry.rootHeight <= 0 || target.w <= 0 || target.h <= 0) return null
  const zoom = clampZoom(Math.min(geometry.rootWidth / target.w, geometry.rootHeight / target.h))
  const centerX = target.x + target.w / 2
  const centerY = target.y + target.h / 2
  return {
    zoom,
    panX: geometry.rootWidth / 2 - geometry.offsetX - zoom * centerX,
    panY: geometry.rootHeight / 2 - geometry.offsetY - zoom * centerY,
  }
}
