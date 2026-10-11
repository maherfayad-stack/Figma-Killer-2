/**
 * The cursor-following ghost of an insertion drag, moved without React.
 *
 * A drag out of a panel used to `setState` the pointer position on every
 * animation frame, so the whole overlay (and its children, an SVG or an image)
 * re-rendered sixty times a second just to follow the cursor. The position is a
 * pure presentation fact that nothing reads back, so it is written straight to
 * the ghost element's custom properties and the component only re-renders when
 * something it DRAWS changes (the drop preview, the ghost's own size).
 *
 * `attach` is the ghost element's ref callback: React hands over the element on
 * mount (and `null` on unmount), and the last point is applied at once so a
 * ghost that mounts after the first move does not flash at the origin.
 */
export interface InsertionGhostTracker {
  attach: (element: HTMLElement | null) => void
  moveTo: (x: number, y: number) => void
}

export function createInsertionGhostTracker(x: number, y: number): InsertionGhostTracker {
  let element: HTMLElement | null = null
  let point = { x, y }
  const write = () => {
    if (!element) return
    element.style.setProperty('--ghost-x', `${point.x}px`)
    element.style.setProperty('--ghost-y', `${point.y}px`)
  }
  return {
    attach: (next) => {
      element = next
      write()
    },
    moveTo: (nextX, nextY) => {
      point = { x: nextX, y: nextY }
      write()
    },
  }
}
