/**
 * simplify — turning a freehand pointer trail into a few smooth cubics.
 *
 * The pencil pipeline (audit `08-svg.md` §6): a radial-distance pre-pass drops
 * points closer together than the pointer's own jitter, Douglas-Peucker keeps
 * only the points that carry shape, and Schneider's curve fit (Graphics Gems,
 * "An Algorithm for Automatically Fitting Digitized Curves", 1990) turns what
 * is left into cubic Béziers within a maximum error. A typical 3-second
 * scribble becomes tens of cubics rather than the hundreds of line-tos Penpot
 * emits, which is both smaller and editable without a jagged result.
 */
import {
  cubicAt,
  distance,
  newtonStepTowards,
  nearestOnLine,
  type Cubic,
  type Point,
} from './pathGeometry'

/** Drop every point closer than `tolerance` to the last point kept. Keeps both ends. */
export function simplifyRadial(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points]
  const kept: Point[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i += 1) {
    if (distance(points[i]!, kept[kept.length - 1]!) >= tolerance) kept.push(points[i]!)
  }
  kept.push(points[points.length - 1]!)
  return kept
}

/**
 * Douglas-Peucker: keep the point farthest from each chord while it is farther
 * than `tolerance`, recursively. Iterative, so a long trail cannot overflow
 * the stack.
 */
export function simplifyDouglasPeucker(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let farthest = -1
    let farthestDistance = tolerance
    for (let i = first + 1; i < last; i += 1) {
      const d = nearestOnLine(points[first]!, points[last]!, points[i]!).distance
      if (d > farthestDistance) {
        farthest = i
        farthestDistance = d
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}

function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k }
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function normalize(a: Point): Point {
  const length = Math.hypot(a.x, a.y)
  return length === 0 ? { x: 0, y: 0 } : { x: a.x / length, y: a.y / length }
}

function chordLengthParameters(points: readonly Point[]): number[] {
  const u = [0]
  for (let i = 1; i < points.length; i += 1) u.push(u[i - 1]! + distance(points[i]!, points[i - 1]!))
  const total = u[u.length - 1]!
  return total === 0 ? u.map((_, i) => i / (u.length - 1)) : u.map((value) => value / total)
}

/** The least-squares cubic through `points` at parameters `u`, with fixed end tangents. */
function generateCubic(points: readonly Point[], u: readonly number[], leftTangent: Point, rightTangent: Point): Cubic {
  const first = points[0]!
  const last = points[points.length - 1]!
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < points.length; i += 1) {
    const t = u[i]!
    const mt = 1 - t
    const a1 = scale(leftTangent, 3 * mt * mt * t)
    const a2 = scale(rightTangent, 3 * mt * t * t)
    c00 += dot(a1, a1)
    c01 += dot(a1, a2)
    c11 += dot(a2, a2)
    const straight = cubicAt([first, first, last, last], t)
    const residual = sub(points[i]!, straight)
    x0 += dot(a1, residual)
    x1 += dot(a2, residual)
  }
  const determinant = c00 * c11 - c01 * c01
  const chord = distance(first, last)
  let alphaLeft = determinant === 0 ? 0 : (x0 * c11 - x1 * c01) / determinant
  let alphaRight = determinant === 0 ? 0 : (c00 * x1 - c01 * x0) / determinant
  const floor = chord * 1e-6
  if (alphaLeft < floor || alphaRight < floor) {
    // Wu/Barsky heuristic: the least-squares answer is degenerate, so fall
    // back to handles one third of the chord long.
    alphaLeft = chord / 3
    alphaRight = chord / 3
  }
  return [first, add(first, scale(leftTangent, alphaLeft)), add(last, scale(rightTangent, alphaRight)), last]
}

/** The worst squared fit error and where it occurs. */
function maxError(points: readonly Point[], cubic: Cubic, u: readonly number[]): { error: number; index: number } {
  let error = 0
  let index = Math.floor(points.length / 2)
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = sub(cubicAt(cubic, u[i]!), points[i]!)
    const squared = dot(d, d)
    if (squared > error) {
      error = squared
      index = i
    }
  }
  return { error, index }
}

function fitRange(points: readonly Point[], leftTangent: Point, rightTangent: Point, errorSquared: number, out: Cubic[]): void {
  if (points.length === 2) {
    const third = distance(points[0]!, points[1]!) / 3
    out.push([points[0]!, add(points[0]!, scale(leftTangent, third)), add(points[1]!, scale(rightTangent, third)), points[1]!])
    return
  }
  let u = chordLengthParameters(points)
  let cubic = generateCubic(points, u, leftTangent, rightTangent)
  let worst = maxError(points, cubic, u)
  if (worst.error < errorSquared) {
    out.push(cubic)
    return
  }
  if (worst.error < errorSquared * 4) {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      u = u.map((t, i) => newtonStepTowards(cubic, points[i]!, t))
      cubic = generateCubic(points, u, leftTangent, rightTangent)
      worst = maxError(points, cubic, u)
      if (worst.error < errorSquared) {
        out.push(cubic)
        return
      }
    }
  }
  const split = Math.min(points.length - 2, Math.max(1, worst.index))
  let centre = normalize(sub(points[split - 1]!, points[split + 1]!))
  if (centre.x === 0 && centre.y === 0) centre = normalize(sub(points[split - 1]!, points[split]!))
  fitRange(points.slice(0, split + 1), leftTangent, centre, errorSquared, out)
  fitRange(points.slice(split), scale(centre, -1), rightTangent, errorSquared, out)
}

/**
 * Fit `points` with cubic Béziers whose distance to every input point, at the
 * fitted parameter, is below `maxDistance`. Consecutive duplicate points are
 * ignored. Returns `[]` for fewer than two distinct points.
 */
export function fitCubics(points: readonly Point[], maxDistance: number): Cubic[] {
  const distinct = points.filter((point, i) => i === 0 || distance(point, points[i - 1]!) > 0)
  if (distinct.length < 2) return []
  const leftTangent = normalize(sub(distinct[1]!, distinct[0]!))
  const rightTangent = normalize(sub(distinct[distinct.length - 2]!, distinct[distinct.length - 1]!))
  const out: Cubic[] = []
  fitRange(distinct, leftTangent, rightTangent, maxDistance * maxDistance, out)
  return out
}
