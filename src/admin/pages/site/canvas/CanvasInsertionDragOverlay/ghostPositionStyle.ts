import type { CSSProperties } from 'react'

/**
 * The cursor-following ghost's custom properties, as the module reads them
 * back via `var()`.
 *
 * Its own file so `CanvasInsertionDragOverlay.tsx` stays component-only -
 * React Fast Refresh drops a module that exports both a component and a plain
 * function (Constraint #309).
 *
 * A drag with a `tracker` gets NO position here: the tracker writes
 * `--ghost-x` / `--ghost-y` straight to the element on every animation frame,
 * and a position in the React style would be re-applied, stale, on the next
 * render. A caller that re-renders per move (the draw tool's hover) passes
 * none and is positioned from the point as before.
 */
export function ghostPositionStyle(drag: {
  x: number
  y: number
  tracker?: unknown
  size?: { width: number; height: number } | null
  zoom?: number
}): CSSProperties {
  const style: Record<string, string> = {}
  if (!drag.tracker) {
    style['--ghost-x'] = `${drag.x}px`
    style['--ghost-y'] = `${drag.y}px`
  }
  style['--ghost-zoom'] = String(drag.zoom ?? 1)
  if (drag.size) {
    style['--ghost-w'] = `${drag.size.width}px`
    style['--ghost-h'] = `${drag.size.height}px`
  }
  return style as CSSProperties
}
