/**
 * pathGeometry — the curve maths vector editing stands on: evaluate, split,
 * bound, flatten and nearest-point for quadratic and cubic Béziers.
 *
 * Every function is exact where an exact answer exists (de Casteljau split,
 * derivative-root bounds) and says how it approximates where one does not
 * (nearest point: a coarse sample, then Newton refinement). Pure: plain
 * `{x, y}` objects in, new objects out, nothing mutated.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export type Cubic = readonly [Point, Point, Point, Point]
export type Quad = readonly [Point, Point, Point]

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function cubicAt([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

export function quadAt([p0, p1, p2]: Quad, t: number): Point {
  const u = 1 - t
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y }
}

/** De Casteljau split at `t`: two cubics that together trace exactly the original. */
export function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerpPoint(p0, p1, t)
  const b = lerpPoint(p1, p2, t)
  const c = lerpPoint(p2, p3, t)
  const ab = lerpPoint(a, b, t)
  const bc = lerpPoint(b, c, t)
  const mid = lerpPoint(ab, bc, t)
  return [[p0, a, ab, mid], [mid, bc, c, p3]]
}

export function splitQuad([p0, p1, p2]: Quad, t: number): [Quad, Quad] {
  const a = lerpPoint(p0, p1, t)
  const b = lerpPoint(p1, p2, t)
  const mid = lerpPoint(a, b, t)
  return [[p0, a, mid], [mid, b, p2]]
}

/** The exact cubic a quadratic is (degree elevation). */
export function quadToCubic([p0, p1, p2]: Quad): Cubic {
  return [p0, lerpPoint(p0, p1, 2 / 3), lerpPoint(p2, p1, 2 / 3), p2]
}

/** Roots in (0, 1) of `a t² + b t + c`. */
function unitRoots(a: number, b: number, c: number): number[] {
  const roots: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a))
    }
  }
  return roots.filter((t) => t > 0 && t < 1)
}

function boundsOf(points: readonly Point[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/** Exact bounding box: the endpoints plus every extremum where the derivative is zero. */
export function cubicBounds(cubic: Cubic): Rect {
  const [p0, p1, p2, p3] = cubic
  const extrema: Point[] = [p0, p3]
  for (const axis of ['x', 'y'] as const) {
    // B'(t)/3 = a t² + b t + c
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis])
    const c = p1[axis] - p0[axis]
    for (const t of unitRoots(a, b, c)) extrema.push(cubicAt(cubic, t))
  }
  return boundsOf(extrema)
}

export function quadBounds(quad: Quad): Rect {
  const [p0, p1, p2] = quad
  const extrema: Point[] = [p0, p2]
  for (const axis of ['x', 'y'] as const) {
    const denominator = p0[axis] - 2 * p1[axis] + p2[axis]
    if (Math.abs(denominator) < 1e-12) continue
    const t = (p0[axis] - p1[axis]) / denominator
    if (t > 0 && t < 1) extrema.push(quadAt(quad, t))
  }
  return boundsOf(extrema)
}

export function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    minY: Math.min(...rects.map((r) => r.minY)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    maxY: Math.max(...rects.map((r) => r.maxY)),
  }
}

function cubicDerivative([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  }
}

function cubicSecondDerivative([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t
  return {
    x: 6 * u * (p2.x - 2 * p1.x + p0.x) + 6 * t * (p3.x - 2 * p2.x + p1.x),
    y: 6 * u * (p2.y - 2 * p1.y + p0.y) + 6 * t * (p3.y - 2 * p2.y + p1.y),
  }
}

/** One Newton step of `t` toward the closest point on `cubic` to `target`. */
export function newtonStepTowards(cubic: Cubic, target: Point, t: number): number {
  const p = cubicAt(cubic, t)
  const d1 = cubicDerivative(cubic, t)
  const d2 = cubicSecondDerivative(cubic, t)
  const dx = p.x - target.x
  const dy = p.y - target.y
  const numerator = dx * d1.x + dy * d1.y
  const denominator = d1.x * d1.x + d1.y * d1.y + dx * d2.x + dy * d2.y
  if (Math.abs(denominator) < 1e-12) return t
  return t - numerator / denominator
}

export interface NearestPoint {
  readonly t: number
  readonly point: Point
  readonly distance: number
}

/**
 * The closest point on `cubic` to `target`: the best of a coarse sample of
 * `samples` + 1 parameters, then refined by Newton iteration clamped to [0, 1].
 */
export function nearestOnCubic(cubic: Cubic, target: Point, samples = 32): NearestPoint {
  let bestT = 0
  let bestDistance = Infinity
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    const d = distance(cubicAt(cubic, t), target)
    if (d < bestDistance) {
      bestDistance = d
      bestT = t
    }
  }
  let t = bestT
  for (let i = 0; i < 8; i += 1) {
    const next = Math.min(1, Math.max(0, newtonStepTowards(cubic, target, t)))
    if (Math.abs(next - t) < 1e-12) break
    t = next
  }
  const refined = cubicAt(cubic, t)
  const refinedDistance = distance(refined, target)
  if (refinedDistance <= bestDistance) return { t, point: refined, distance: refinedDistance }
  return { t: bestT, point: cubicAt(cubic, bestT), distance: bestDistance }
}

/** The closest point on the line segment `a`–`b` to `target`. */
export function nearestOnLine(a: Point, b: Point, target: Point): NearestPoint {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared))
  const point = lerpPoint(a, b, t)
  return { t, point, distance: distance(point, target) }
}

/**
 * `cubic` as a polyline whose chords stay within `tolerance` of the curve,
 * by recursive subdivision until each piece is flat. Includes both endpoints.
 */
export function flattenCubic(cubic: Cubic, tolerance: number): Point[] {
  const out: Point[] = [cubic[0]]
  const flatEnough = ([p0, p1, p2, p3]: Cubic): boolean =>
    nearestOnLine(p0, p3, p1).distance <= tolerance && nearestOnLine(p0, p3, p2).distance <= tolerance
  const walk = (piece: Cubic, depth: number): void => {
    if (depth >= 16 || flatEnough(piece)) {
      out.push(piece[3])
      return
    }
    const [left, right] = splitCubic(piece, 0.5)
    walk(left, depth + 1)
    walk(right, depth + 1)
  }
  walk(cubic, 0)
  return out
}
