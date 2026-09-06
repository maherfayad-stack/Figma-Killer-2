/**
 * canvasZoomFit — pure zoom/pan math for "fit these rects on screen",
 * shared by `Shift+1` (zoom-to-fit) and `Shift+2` (zoom-to-selection).
 * See D3 in `STUDIO-FIGMA-PARITY-PLAN.md` — neither existed before; `Shift+1`
 * used to just reset to 100% (`useCanvas.ts`'s own module doc already said
 * "fit-to-screen" while the code underneath still reset — this file is what
 * makes the doc true).
 *
 * Zero DOM access — callers measure rects (`getBoundingClientRect`, already
 * relative to the canvas root) and hand them in, so this stays unit-testable
 * without a browser.
 */
import { clampPan, clampZoom, type CanvasTransform } from './math'

/** A screen-space rect, relative to the canvas root's own top-left corner. */
export interface CanvasFitRect {
  left: number
  top: number
  width: number
  height: number
}

/** Screen-space margin kept between the fitted content and the viewport edge. */
export const DEFAULT_ZOOM_FIT_PADDING_PX = 64

/**
 * How the union of `targetRects` is scaled into the viewport.
 *
 * - `contain` — the whole union fits, letterboxed on the long axis. This is
 *   "Zoom to fit" / "Zoom to selection".
 * - `cover` — the union FILLS the viewport, bleeding off the short axis. This
 *   is the toolbar zoom menu's "Fill" (viewport-01), Figma's zoom-to-fill.
 *
 * Everything else about the two is identical, including centering — the only
 * difference is `min` vs. `max` of the two axis ratios.
 */
export type ZoomFitMode = 'contain' | 'cover'

/**
 * Compute the `{ zoom, panX, panY }` that fits every rect in `targetRects`
 * inside a `rootRect.width × rootRect.height` viewport, centered, with
 * `padding` screen pixels of margin on all sides.
 *
 * `targetRects` are SCREEN-space (already scaled by `current.zoom`) — this
 * function first undoes that scale (`math.ts`'s `translate(panX,panY)
 * scale(zoom)` model) to get each rect's board-space extent, unions them,
 * then solves for the zoom/pan that makes the union fill the available
 * viewport space. Un-scaling first (rather than fitting the screen-space
 * union directly) is what makes calling this again at a different starting
 * zoom idempotent — the target only depends on where the content IS on the
 * board, never on how zoomed-in you already were when you asked.
 *
 * Returns `null` when there is nothing to fit (`targetRects` is empty) or
 * every rect is a true point (zero width AND height) — the caller should
 * no-op rather than zoom to a single, meaningless point.
 */
export function computeZoomToFitTransform(
  rootRect: { width: number; height: number },
  targetRects: readonly CanvasFitRect[],
  current: CanvasTransform,
  padding: number = DEFAULT_ZOOM_FIT_PADDING_PX,
  mode: ZoomFitMode = 'contain',
): CanvasTransform | null {
  if (targetRects.length === 0) return null
  if (current.zoom <= 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const rect of targetRects) {
    const boardLeft = (rect.left - current.panX) / current.zoom
    const boardTop = (rect.top - current.panY) / current.zoom
    const boardRight = boardLeft + rect.width / current.zoom
    const boardBottom = boardTop + rect.height / current.zoom
    minX = Math.min(minX, boardLeft)
    minY = Math.min(minY, boardTop)
    maxX = Math.max(maxX, boardRight)
    maxY = Math.max(maxY, boardBottom)
  }

  const boardWidth = maxX - minX
  const boardHeight = maxY - minY
  if (boardWidth <= 0 && boardHeight <= 0) return null

  const availableWidth = Math.max(1, rootRect.width - padding * 2)
  const availableHeight = Math.max(1, rootRect.height - padding * 2)

  // A rect degenerate on exactly one axis (e.g. an unmeasured 0-height frame)
  // must not force zoom to infinity on that axis alone — fall back to the
  // other axis's ratio. `cover` therefore takes the max of the FINITE ratios:
  // a plain `Math.max` would pick the `Infinity` sentinel and clamp to max
  // zoom, which is the opposite of "fill".
  const widthRatio = boardWidth > 0 ? availableWidth / boardWidth : Infinity
  const heightRatio = boardHeight > 0 ? availableHeight / boardHeight : Infinity
  const finiteRatios = [widthRatio, heightRatio].filter(Number.isFinite)
  const zoom = clampZoom(
    mode === 'cover' && finiteRatios.length > 0
      ? Math.max(...finiteRatios)
      : Math.min(widthRatio, heightRatio),
  )

  const boardCenterX = minX + boardWidth / 2
  const boardCenterY = minY + boardHeight / 2
  const panX = clampPan(rootRect.width / 2 - boardCenterX * zoom)
  const panY = clampPan(rootRect.height / 2 - boardCenterY * zoom)

  return { zoom, panX, panY }
}
