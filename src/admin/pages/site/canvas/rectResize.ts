/**
 * rectResize — pure geometry for dragging a resize handle on any board rect.
 *
 * Three things on the board are resized by dragging one of eight handles
 * (four corners + four edge midpoints): a frame, a sticky note, and a doc
 * card. Dragging a handle moves the edge(s) it owns by the pointer's delta
 * (already converted to board units — `screenDelta / zoom`, see
 * `BoardFrameView`'s drag handler) while the OPPOSITE edge(s) stay anchored,
 * mirroring how every design tool's resize handles behave. A handle on the
 * north or west edge therefore moves the rect's `x`/`y` in addition to its
 * `width`/`height`, so `resizeRect` returns the FULL next rect rather than a
 * size delta.
 *
 * `minSize` is a required argument, not a default: a frame's floor (200,
 * `MIN_FRAME_SIZE`) and an annotation's (80, `MIN_ANNOTATION_SIZE`) are
 * genuinely different numbers, and an implicit default here would silently
 * apply the wrong one to whichever caller forgot it.
 *
 * Deliberately pure — no React, no DOM reads — so the clamp and the eight
 * handle directions are unit-tested without a browser. It lives at the
 * `canvas/` root rather than under `BoardFramesLayer/` (where it began, as
 * `frameResize.ts`) because a note is not a frame; the notes and docs layers
 * import it too.
 */

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface ResizeRect {
  x: number
  y: number
  width: number
  height: number
}

/** Every handle, in visual order (top-left clockwise) — the order each view renders them in. */
export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * The next rect after dragging `handle` by (`dx`, `dy`) board units from
 * `anchor` (the rect at drag-start). Clamps `width`/`height` to `minSize`,
 * keeping the edge OPPOSITE the dragged handle fixed in place — so e.g.
 * dragging `nw` past the min size stops shrinking but never lets the
 * bottom-right corner drift.
 */
export function resizeRect(
  anchor: ResizeRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  minSize: number,
): ResizeRect {
  const movesEast = handle.includes('e')
  const movesWest = handle.includes('w')
  const movesNorth = handle.includes('n')
  const movesSouth = handle.includes('s')

  let width = anchor.width
  let height = anchor.height
  let x = anchor.x
  let y = anchor.y

  if (movesEast) width = anchor.width + dx
  if (movesWest) {
    width = anchor.width - dx
    x = anchor.x + dx
  }
  if (movesSouth) height = anchor.height + dy
  if (movesNorth) {
    height = anchor.height - dy
    y = anchor.y + dy
  }

  if (width < minSize) {
    // Re-anchor to the fixed (non-dragged) edge so it doesn't drift once the
    // clamp kicks in.
    if (movesWest) x = anchor.x + anchor.width - minSize
    width = minSize
  }
  if (height < minSize) {
    if (movesNorth) y = anchor.y + anchor.height - minSize
    height = minSize
  }

  return { x, y, width, height }
}
