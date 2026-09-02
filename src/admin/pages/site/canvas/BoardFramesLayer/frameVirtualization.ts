/**
 * frameVirtualization — pure viewport-intersection test for studio board
 * frames.
 *
 * `BoardFramesLayer` renders one frame per curated page; each frame carries
 * fixed board-space bounds (`x`/`y` + the frame's width/height in board
 * units). `CanvasTransformLayer` renders this layer inside a transform of
 * `translate(panX, panY) scale(zoom)`, so a board-space point `(bx, by)`
 * lands on screen at:
 *
 *   screenX = panX + bx * zoom
 *   screenY = panY + by * zoom
 *
 * `isFrameOnScreen` converts a frame's board rect to that screen space, then
 * tests it for intersection against the viewport box `[0, width] x [0,
 * height]` (the untransformed canvas root's client size — screen-space
 * origin, since the transform is applied to a descendant, not the root)
 * inflated by `marginPx` on every side. The margin keeps ~1 extra screen of
 * frames mounted around the visible area so panning/scrolling doesn't pop
 * iframes in and out at the viewport edge.
 *
 * Deliberately pure — no React, no DOM reads — so it's trivially unit
 * tested and reusable from both the layer component and its tests.
 */

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportState {
  panX: number
  panY: number
  zoom: number
  width: number
  height: number
}

/** ~1 extra screen of margin around the visible viewport, in screen pixels. */
export const FRAME_VIEWPORT_MARGIN = 600

/**
 * Does `frame` (board-space rect) intersect the current viewport, inflated
 * by `marginPx` on every side?
 */
export function isFrameOnScreen(frame: FrameRect, viewport: ViewportState, marginPx: number): boolean {
  const { panX, panY, zoom, width, height } = viewport

  const left = panX + frame.x * zoom
  const top = panY + frame.y * zoom
  const right = left + frame.width * zoom
  const bottom = top + frame.height * zoom

  const viewLeft = -marginPx
  const viewTop = -marginPx
  const viewRight = width + marginPx
  const viewBottom = height + marginPx

  return left < viewRight && right > viewLeft && top < viewBottom && bottom > viewTop
}
