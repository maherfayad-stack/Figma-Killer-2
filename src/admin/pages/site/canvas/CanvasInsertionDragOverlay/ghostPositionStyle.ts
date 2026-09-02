import type { CSSProperties } from 'react'

/**
 * The cursor-following ghost's position, as custom properties the module reads
 * back via `var()`.
 *
 * Its own file so `CanvasInsertionDragOverlay.tsx` stays component-only —
 * React Fast Refresh drops a module that exports both a component and a plain
 * function (Constraint #309). Takes a bare point rather than the drag state, so
 * a caller that keeps its own ghost markup (the media explorer draws a
 * thumbnail, not a label) can still position it the same way.
 */
export function ghostPositionStyle(point: { x: number; y: number }): CSSProperties {
  return {
    '--ghost-x': `${point.x}px`,
    '--ghost-y': `${point.y}px`,
  } as CSSProperties
}
