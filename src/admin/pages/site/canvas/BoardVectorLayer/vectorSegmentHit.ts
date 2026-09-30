/**
 * vectorSegmentHit — which segment of a path a point is on, and where (P5-D):
 * the answer "double-click the outline to add a point" needs.
 *
 * In the path's own user space. Lines (and a close's closing edge) use the
 * exact projection; curves use `@core/vector`'s sampled-then-Newton nearest
 * point, a quad through its exact cubic elevation (same parameter). Arcs are
 * skipped: `insertAnchor` refuses them anyway.
 */
import { nearestOnCubic, nearestOnLine, quadToCubic, type NearestPoint, type PathModel, type Point } from '@core/vector'

export interface SegmentHit {
  segment: number
  t: number
  distance: number
}

export function nearestSegmentPoint(model: PathModel, local: Point): SegmentHit | null {
  let best: SegmentHit | null = null
  model.segments.forEach((seg, segment) => {
    let hit: NearestPoint | null = null
    if (seg.kind === 'line' || seg.kind === 'close') hit = nearestOnLine(seg.from, seg.to, local)
    else if (seg.kind === 'cubic') hit = nearestOnCubic([seg.from, seg.c1!, seg.c2!, seg.to], local)
    else if (seg.kind === 'quad') hit = nearestOnCubic(quadToCubic([seg.from, seg.c1!, seg.to]), local)
    if (hit && (!best || hit.distance < best.distance)) best = { segment, t: hit.t, distance: hit.distance }
  })
  return best
}
