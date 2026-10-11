/**
 * vectorGeometry — the pure arithmetic of the vector overlay (P5-D): affine
 * maps between a part's own user space and the board, the anchor and handle
 * lists of a path model, hit testing, and the O(1)-element overlay paths.
 *
 * No DOM: the layer measures once (`vectorEditParts.ts`) and everything that
 * runs per pointer event is here, where it is unit-testable and cheap.
 *
 * ## Coordinate spaces
 *
 *   - LOCAL — the part's own user space, where its `d` is written.
 *   - BOARD — the transform layer's units. Iframe content is unscaled (the
 *     canvas transform scales the `<iframe>` element), so a part's board point
 *     is `frame origin + (its screen CTM · p)`: one affine per part, measured
 *     at session start, valid at every pan and zoom.
 *
 * Overlay chrome is drawn in board units but SIZED in screen pixels: a square
 * is `ANCHOR_PX / zoom` board units across, so it is 8 px on screen at 25% and
 * at 400% alike (the `--canvas-zoom` rule every board layer follows).
 */
import { anchorSegmentIndices, type PathModel, type Point } from '@core/vector'

/** `x' = a·x + c·y + e`, `y' = b·x + d·y + f` — the `DOMMatrix` convention. */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function applyAffine(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/** The linear part only — for a DELTA, which a translation must not move. */
export function applyLinear(m: Affine, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y }
}

/** `m` then `n`: `(n ∘ m)(p) = n(m(p))`. */
export function composeAffine(m: Affine, n: Affine): Affine {
  return {
    a: n.a * m.a + n.c * m.b,
    b: n.b * m.a + n.d * m.b,
    c: n.a * m.c + n.c * m.d,
    d: n.b * m.c + n.d * m.d,
    e: n.a * m.e + n.c * m.f + n.e,
    f: n.b * m.e + n.d * m.f + n.f,
  }
}

/** The inverse, or `null` for a singular map (a `scale(0)` part cannot be edited). */
export function invertAffine(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function translation(dx: number, dy: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }
}

/** CSS px per user unit along the map's average axis — how finely a coordinate needs writing. */
export function affineScale(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
}

/** `matrix(a b c d e f)` for an SVG `transform` attribute. */
export function affineTransformAttribute(m: Affine): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((n) => round(n, 6)).join(' ')})`
}

function round(n: number, decimals: number): string {
  const s = n.toFixed(decimals)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

// ── Anchors and handles ─────────────────────────────────────────────────────

/** One draggable on-curve point: segment `segment` of part `part` ends there. */
export interface VectorAnchor {
  part: number
  segment: number
  local: Point
}

/** One control point, attached to the anchor it bends toward. */
export interface VectorHandle {
  part: number
  segment: number
  handle: 'c1' | 'c2'
  local: Point
  /** The anchor this handle hangs from (the segment's `from` for c1, its `to` for c2). */
  anchorLocal: Point
}

export function modelAnchors(model: PathModel, part: number): VectorAnchor[] {
  return anchorSegmentIndices(model).map((segment) => ({ part, segment, local: model.segments[segment]!.to }))
}

/**
 * The handles to show for the anchor ending segment `segment`: its incoming
 * handle (that segment's `c2`, or a quad's single control) and its outgoing
 * one (the NEXT segment's `c1`).
 */
export function anchorHandles(model: PathModel, part: number, segment: number): VectorHandle[] {
  const out: VectorHandle[] = []
  const incoming = model.segments[segment]
  if (incoming?.kind === 'cubic' && incoming.c2) {
    out.push({ part, segment, handle: 'c2', local: incoming.c2, anchorLocal: incoming.to })
  } else if (incoming?.kind === 'quad' && incoming.c1) {
    out.push({ part, segment, handle: 'c1', local: incoming.c1, anchorLocal: incoming.to })
  }
  const outgoing = model.segments[segment + 1]
  if ((outgoing?.kind === 'cubic' || outgoing?.kind === 'quad') && outgoing.c1) {
    out.push({ part, segment: segment + 1, handle: 'c1', local: outgoing.c1, anchorLocal: outgoing.from })
  }
  return out
}

/** The index of the point nearest `target` within `radius`, or -1. Linear: 5,000 points is well under a millisecond. */
export function nearestPointIndex(points: readonly Point[], target: Point, radius: number): number {
  let best = -1
  let bestDistance = radius * radius
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i]!.x - target.x
    const dy = points[i]!.y - target.y
    const d = dx * dx + dy * dy
    if (d <= bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

// ── Overlay path data ───────────────────────────────────────────────────────

function n(value: number): string {
  return round(value, 3)
}

/**
 * Every point as a square `half` board units from its centre, as ONE path —
 * so 2,000 anchors are one DOM element, not 2,000 (Penpot renders one
 * component per point, which does not scale to the SVG-9 budget).
 */
export function squaresPathData(points: readonly Point[], half: number): string {
  const side = n(half * 2)
  let out = ''
  for (const p of points) out += `M${n(p.x - half)} ${n(p.y - half)}h${side}v${side}h-${side}z`
  return out
}

/** Every point as a small circle of radius `r`, as one path. */
export function circlesPathData(points: readonly Point[], r: number): string {
  const rr = n(r)
  let out = ''
  for (const p of points) out += `M${n(p.x - r)} ${n(p.y)}a${rr} ${rr} 0 1 0 ${n(r * 2)} 0a${rr} ${rr} 0 1 0 -${n(r * 2)} 0`
  return out
}

/** Straight segments `[from, to]`, as one path. */
export function linesPathData(lines: readonly (readonly [Point, Point])[]): string {
  let out = ''
  for (const [a, b] of lines) out += `M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}`
  return out
}

// ── Pointer constraints ─────────────────────────────────────────────────────

/** `delta` snapped to the nearest multiple of 45° (⇧ while dragging or drawing), keeping its length along that axis. */
export function constrainTo45(delta: Point): Point {
  const length = Math.hypot(delta.x, delta.y)
  if (length === 0) return delta
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(delta.y, delta.x) / step) * step
  const along = delta.x * Math.cos(angle) + delta.y * Math.sin(angle)
  return { x: Math.cos(angle) * along, y: Math.sin(angle) * along }
}
