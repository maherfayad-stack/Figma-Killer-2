/**
 * frameResize — pure geometry for dragging a board frame's resize handles.
 *
 * `BoardFrameView` renders up to eight handles (four corners + four edge
 * midpoints) around the active frame. Dragging one moves the edge(s) it
 * owns by the pointer's delta (already converted to board units — see
 * `screenDelta / zoom` in `BoardFramesLayer.tsx`'s frame-drag handler for the
 * same conversion) while the OPPOSITE edge(s) stay anchored, mirroring how
 * every design tool's resize handles behave. A handle on the north or west
 * edge therefore moves the frame's `x`/`y` in addition to its `width`/
 * `height` — `resizeFrameRect` returns the full next rect so the caller can
 * feed `x`/`y` to `setFramePosition` and `width`/`height` to `setFrameSize`
 * in the same gesture.
 *
 * Deliberately pure — no React, no DOM reads — so the min-size clamp and the
 * eight handle directions are unit-tested without a browser.
 */

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface FrameResizeRect {
  x: number
  y: number
  width: number
  height: number
}

/** Smallest a frame may shrink to, in board units, on either axis. */
export const MIN_FRAME_SIZE = 200

/**
 * The next frame rect after dragging `handle` by (`dx`, `dy`) board units
 * from `anchor` (the frame's rect at drag-start). Clamps `width`/`height` to
 * `minSize`, keeping the edge OPPOSITE the dragged handle fixed in place —
 * so e.g. dragging `nw` past the min size stops shrinking but never lets the
 * frame's bottom-right corner drift.
 */
export function resizeFrameRect(
  anchor: FrameResizeRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  minSize: number = MIN_FRAME_SIZE,
): FrameResizeRect {
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
