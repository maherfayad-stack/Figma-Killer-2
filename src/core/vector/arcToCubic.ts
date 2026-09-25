/**
 * arcToCubic — an SVG elliptical arc (`A rx ry rotation large-arc sweep x y`)
 * as cubic Béziers.
 *
 * Only used when the user explicitly converts an arc ("Convert to curve"), and
 * for geometry queries (bounds, hit testing) over a path that contains one.
 * Editing an arc's endpoint keeps it an arc (`pathModel.ts`); nothing here
 * rewrites source on its own.
 *
 * The maths is the SVG spec's endpoint-to-centre conversion (SVG 1.1 F.6.5,
 * with the F.6.6 out-of-range radius correction), then one cubic per ≤ 90°
 * sweep using the standard `4/3 · tan(θ/4)` handle length. The error of that
 * approximation is below 3e-4 of the radius per quarter turn.
 */
import type { Cubic, Point } from './pathGeometry'

export interface ArcParameters {
  readonly rx: number
  readonly ry: number
  /** Degrees. */
  readonly rotation: number
  readonly largeArc: boolean
  readonly sweep: boolean
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1
  const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
  return sign * Math.acos(Math.max(-1, Math.min(1, dot)))
}

/**
 * The cubics tracing the arc from `from` to `to`. Returns `[]` when the
 * endpoints coincide (the spec draws nothing), and a single straight cubic
 * when either radius is zero (the spec draws a line).
 */
export function arcToCubics(from: Point, arc: ArcParameters, to: Point): Cubic[] {
  if (from.x === to.x && from.y === to.y) return []
  let rx = Math.abs(arc.rx)
  let ry = Math.abs(arc.ry)
  if (rx === 0 || ry === 0) return [[from, from, to, to]]

  const phi = (arc.rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    rx *= scale
    ry *= scale
  }

  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const root = Math.sqrt(Math.max(0, numerator / denominator)) * (arc.largeArc === arc.sweep ? -1 : 1)
  const cxp = (root * rx * y1p) / ry
  const cyp = (-root * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2
  const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let delta = vectorAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!arc.sweep && delta > 0) delta -= 2 * Math.PI
  if (arc.sweep && delta < 0) delta += 2 * Math.PI

  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / pieces
  const handle = (4 / 3) * Math.tan(step / 4)
  const onEllipse = (angle: number): Point => ({
    x: cx + rx * Math.cos(angle) * cos - ry * Math.sin(angle) * sin,
    y: cy + rx * Math.cos(angle) * sin + ry * Math.sin(angle) * cos,
  })
  const tangent = (angle: number): Point => ({
    x: -rx * Math.sin(angle) * cos - ry * Math.cos(angle) * sin,
    y: -rx * Math.sin(angle) * sin + ry * Math.cos(angle) * cos,
  })

  const cubics: Cubic[] = []
  for (let i = 0; i < pieces; i += 1) {
    const a0 = theta1 + i * step
    const a1 = a0 + step
    const start = i === 0 ? from : onEllipse(a0)
    const end = i === pieces - 1 ? to : onEllipse(a1)
    const t0 = tangent(a0)
    const t1 = tangent(a1)
    cubics.push([
      start,
      { x: start.x + handle * t0.x, y: start.y + handle * t0.y },
      { x: end.x - handle * t1.x, y: end.y - handle * t1.y },
      end,
    ])
  }
  return cubics
}
