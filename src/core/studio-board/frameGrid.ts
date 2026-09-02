/**
 * frameGrid — the default grid-slot layout new board frames spawn into.
 *
 * Shared by client canvas code (`BoardFramesLayer` for its empty-state card
 * sizing; `boardSlice`'s `addFrame`/`seedFramesForActiveBoard`, which assign
 * a new frame's initial position from its index in the board's frame list)
 * AND the server (`server/handlers/studio.ts`'s `POST /admin/api/studio/page`
 * scaffolder, WS-13 step 4 — "auto-place the frame", D5 §11.3). Living in
 * `@core/studio-board` rather than under `src/admin/` is what lets both sides
 * agree on frame size / gap / column count without one importing the other's
 * layer — the server must never import admin/canvas code, and this constant
 * table has nothing UI-specific in it.
 */
export const FRAME_WIDTH = 1024
export const FRAME_HEIGHT = 800
export const FRAME_GAP = 80
export const GRID_COLUMNS = 2

/**
 * Smallest a frame may be resized to, in board units, on either axis. Lives
 * here with the other frame-size constants rather than beside the resize
 * geometry (`@site/canvas/rectResize.ts`), which is now shared with notes and
 * docs and has no opinion about how small any particular thing may get — the
 * floor is the caller's, passed in per gesture.
 */
export const MIN_FRAME_SIZE = 200

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
