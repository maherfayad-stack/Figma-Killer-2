/**
 * frameGrid — the default grid-slot layout new board frames spawn into.
 *
 * Shared by `BoardFramesLayer` (which no longer needs to compute a fallback
 * position — every rendered `BoardFrame` carries a saved `x`/`y` now — but
 * still needs the pixel dimensions to size its empty-state card) and
 * `boardSlice` (`addFrame` / `seedFramesForActiveBoard`, which assign a new
 * frame's initial position from its index in the board's frame list). Living
 * in one module keeps the two agreeing on frame size / gap / column count
 * without either importing the other's component code.
 */
export const FRAME_WIDTH = 1024
export const FRAME_HEIGHT = 800
export const FRAME_GAP = 80
export const GRID_COLUMNS = 2

/**
 * Header height (board units) added to a frame's own height for on-screen
 * intersection tests, so the drag header itself isn't cut off the rect.
 * Shared by `BoardFramesLayer.tsx`'s virtualization window and its
 * multi-selection bounding box. NOT used by the marquee, which hit-tests each
 * frame's rendered box instead (`board-03` — see `framesInMarquee.ts`).
 */
export const FRAME_HEADER_HEIGHT = 48

/** Grid slot for the Nth frame added to a board (0-indexed). */
export function defaultFramePosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLUMNS
  const row = Math.floor(index / GRID_COLUMNS)
  return { x: col * (FRAME_WIDTH + FRAME_GAP), y: row * (FRAME_HEIGHT + FRAME_GAP) }
}
