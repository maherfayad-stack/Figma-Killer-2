/**
 * flowGeometry — where a connector between two frames is drawn.
 *
 * Everything here is in BOARD coordinates and pure. That combination is the
 * whole performance story `STUDIO-PROTOTYPE-PLAN.md` §6 warns about: board-space
 * endpoints are pan/zoom invariant, so `CanvasTransformLayer` moves them for
 * free and this only has to run when a FRAME moves or resizes — never on a pan,
 * never on a zoom, and never per animation frame. A connector measured in
 * screen space would need the opposite, and that is how this feature turns into
 * a stutter machine.
 *
 * It also means nothing here reads the DOM. A connector runs between two
 * FRAMES, not between two elements inside two different iframes, which is what
 * lets it be arithmetic over `BoardFrame` rather than a cross-document
 * measurement pass. See `BoardFlowLayer.tsx` for why frame-level is the right
 * granularity for a flow map and not merely the cheap one.
 */

/** A frame's box in board coordinates, with the optional size fields already resolved. */
export interface FlowRect {
  x: number
  y: number
  w: number
  h: number
}

/** A drawn connector: an SVG viewport in board coordinates plus what goes in it. */
export interface FlowConnector {
  /** The SVG element's board-space box. Sized to the curve's convex hull plus room for the cap. */
  left: number
  top: number
  width: number
  height: number
  /** The cubic bezier, in coordinates local to that box. */
  path: string
  /** The arrowhead's tip, in board coordinates. */
  tipX: number
  tipY: number
  /** Travel direction at the tip, in degrees clockwise from east — the arrowhead's rotation. */
  tipAngle: number
  /** The curve's midpoint, in board coordinates — where a count/label chip hangs. */
  labelX: number
  labelY: number
}

/** How far the curve bows out of each frame, as a fraction of the gap between them. */
const BOW_RATIO = 0.4
/** Floor and ceiling on that bow, so adjacent frames still get a curve and distant ones do not get a balloon. */
const BOW_MIN = 48
const BOW_MAX = 420
/** Board-space slack around the curve's hull, so a thick stroke is not clipped by the SVG viewport. */
const VIEWPORT_PADDING = 24

interface Vector {
  x: number
  y: number
}

function centerOf(rect: FlowRect): Vector {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/**
 * Which edges the connector leaves and enters by.
 *
 * Chosen by which axis separates the two frames more, which is the same rule
 * Figma's own connectors use and the only one that reads correctly on a board
 * laid out in either a row or a column: frames side by side connect flank to
 * flank, frames stacked connect bottom to top.
 *
 * The exit and entry normals are the SAME vector on purpose — a connector
 * leaving a frame's right edge enters the next one's left edge still travelling
 * right, so the curve never doubles back on itself.
 */
function edgePorts(source: FlowRect, target: FlowRect): { start: Vector; end: Vector; normal: Vector } {
  const from = centerOf(source)
  const to = centerOf(target)
  const dx = to.x - from.x
  const dy = to.y - from.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { start: { x: source.x + source.w, y: from.y }, end: { x: target.x, y: to.y }, normal: { x: 1, y: 0 } }
      : { start: { x: source.x, y: from.y }, end: { x: target.x + target.w, y: to.y }, normal: { x: -1, y: 0 } }
  }
  return dy >= 0
    ? { start: { x: from.x, y: source.y + source.h }, end: { x: to.x, y: target.y }, normal: { x: 0, y: 1 } }
    : { start: { x: from.x, y: source.y }, end: { x: to.x, y: target.y + target.h }, normal: { x: 0, y: -1 } }
}

/** The point on a cubic bezier at `t`. Used only at `t = 0.5`, for the label. */
function bezierPoint(p0: Vector, p1: Vector, p2: Vector, p3: Vector, t: number): Vector {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/**
 * The connector between two frames, or `null` when there is nothing to draw.
 *
 * `null` when the two boxes are the same box — a page that navigates to itself
 * with only one frame on the board. That IS a real fact about the code (a tab
 * bar's own entry, a filter that re-enters the same route), but it has no
 * two-frame geometry, and a loop drawn onto a frame's own edge says less than
 * the flows list does. The caller keeps the edge and shows it elsewhere rather
 * than pretending it does not exist.
 */
export function flowConnector(source: FlowRect, target: FlowRect): FlowConnector | null {
  if (source.x === target.x && source.y === target.y && source.w === target.w && source.h === target.h) {
    return null
  }

  const { start, end, normal } = edgePorts(source, target)
  const span = Math.hypot(end.x - start.x, end.y - start.y)
  if (span === 0) return null

  const bow = Math.min(BOW_MAX, Math.max(BOW_MIN, span * BOW_RATIO))
  const c1 = { x: start.x + normal.x * bow, y: start.y + normal.y * bow }
  const c2 = { x: end.x - normal.x * bow, y: end.y - normal.y * bow }

  // A cubic bezier never leaves the convex hull of its four control points, so
  // their bounding box (plus stroke slack) is a viewport the curve cannot be
  // clipped by — no sampling required.
  const xs = [start.x, c1.x, c2.x, end.x]
  const ys = [start.y, c1.y, c2.y, end.y]
  const left = Math.min(...xs) - VIEWPORT_PADDING
  const top = Math.min(...ys) - VIEWPORT_PADDING
  const width = Math.max(...xs) - Math.min(...xs) + VIEWPORT_PADDING * 2
  const height = Math.max(...ys) - Math.min(...ys) + VIEWPORT_PADDING * 2

  const local = (p: Vector): string => `${(p.x - left).toFixed(2)} ${(p.y - top).toFixed(2)}`
  const mid = bezierPoint(start, c1, c2, end, 0.5)

  return {
    left,
    top,
    width,
    height,
    path: `M ${local(start)} C ${local(c1)}, ${local(c2)}, ${local(end)}`,
    tipX: end.x,
    tipY: end.y,
    // The curve arrives along the entry normal by construction (`c2` sits one
    // bow BEHIND the endpoint on that axis), so the normal is the tangent —
    // no derivative to evaluate.
    tipAngle: (Math.atan2(normal.y, normal.x) * 180) / Math.PI,
    labelX: mid.x,
    labelY: mid.y,
  }
}
