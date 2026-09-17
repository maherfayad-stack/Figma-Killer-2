/**
 * canvasDragAutoPan — nudging the board when a drag reaches the edge of the
 * canvas.
 *
 * Pure apart from one `getBoundingClientRect()` on the canvas ROOT, which is a
 * stable, untransformed element: reading it invalidates no frame's layout, and
 * it is read once per painted frame rather than once per pointer event.
 *
 * Its own module so the drag session stays about the drag. Auto-pan is a
 * self-contained answer to one question — "is the pointer in an edge band, and
 * if so how hard do we push" — and the answer is the same for every gesture
 * that might grow one later (a marquee, an insertion drag).
 */
import type { ClientPoint } from './canvasDragSession'

/** How close to the canvas edge the pointer has to get before the board moves. */
const AUTO_PAN_EDGE_PX = 48
/** Board pixels per frame at the very edge; scales linearly to 1 at the band's inner lip. */
const AUTO_PAN_MAX_SPEED = 18

/**
 * How far to nudge the canvas this frame because the pointer is in an edge
 * band, or `null` when it is not — which is the common case, and costs
 * nothing beyond the one rect read.
 */
export function autoPanDelta(
  root: HTMLElement | null,
  point: ClientPoint,
): { dx: number; dy: number } | null {
  if (!root) return null
  const rect = root.getBoundingClientRect()
  const leftDistance = point.x - rect.left
  const rightDistance = rect.right - point.x
  const topDistance = point.y - rect.top
  const bottomDistance = rect.bottom - point.y

  let dx = 0
  let dy = 0

  if (leftDistance >= 0 && leftDistance < AUTO_PAN_EDGE_PX) {
    dx = autoPanSpeed(leftDistance)
  } else if (rightDistance >= 0 && rightDistance < AUTO_PAN_EDGE_PX) {
    dx = -autoPanSpeed(rightDistance)
  }

  if (topDistance >= 0 && topDistance < AUTO_PAN_EDGE_PX) {
    dy = autoPanSpeed(topDistance)
  } else if (bottomDistance >= 0 && bottomDistance < AUTO_PAN_EDGE_PX) {
    dy = -autoPanSpeed(bottomDistance)
  }

  return dx === 0 && dy === 0 ? null : { dx, dy }
}

function autoPanSpeed(distanceFromEdge: number): number {
  const ratio = 1 - Math.max(0, Math.min(AUTO_PAN_EDGE_PX, distanceFromEdge)) / AUTO_PAN_EDGE_PX
  return Math.max(1, Math.ceil(ratio * AUTO_PAN_MAX_SPEED))
}
