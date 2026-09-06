/**
 * connectorGeometry — where a prototype connector starts, where it ends, and
 * the curve between them. Pure: no DOM, no store, no React.
 *
 * EVERYTHING HERE IS IN BOARD SPACE, and that is the load-bearing decision.
 * Board-space endpoints are pan/zoom INVARIANT — `CanvasTransformLayer` moves
 * the whole layer for free — so a pan or a zoom re-renders nothing and
 * re-measures nothing. Measurement only has to run when a frame moves, a frame
 * resizes, or a frame's content reflows. Doing this in screen space instead is
 * how the feature becomes a stutter machine: every wheel tick would remeasure
 * two iframes per connector.
 *
 * A connector also spans TWO iframes, which is why none of this can use the
 * trick the selection ring uses (portal the overlay INTO the frame's document
 * and let the browser do the coordinate math). There is no single document that
 * contains both ends.
 */

export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BoardPoint {
  x: number
  y: number
}

/** Which edge of a rect a connector leaves from or arrives at. */
export type ConnectorSide = 'left' | 'right' | 'top' | 'bottom'

export interface ConnectorRoute {
  from: BoardPoint
  to: BoardPoint
  fromSide: ConnectorSide
  toSide: ConnectorSide
  /** An SVG cubic-bezier `d`, in board coordinates. */
  path: string
}

function centre(rect: BoardRect): BoardPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function pointOnSide(rect: BoardRect, side: ConnectorSide): BoardPoint {
  const c = centre(rect)
  switch (side) {
    case 'left':
      return { x: rect.x, y: c.y }
    case 'right':
      return { x: rect.x + rect.width, y: c.y }
    case 'top':
      return { x: c.x, y: rect.y }
    case 'bottom':
      return { x: c.x, y: rect.y + rect.height }
  }
}

/**
 * The side of `from` that faces `to`.
 *
 * Horizontal wins ties and near-ties, because screens on a board are laid out
 * in rows: a connector that leaves the bottom of a button to reach a frame
 * sitting slightly lower and far to the right reads as pointing at the wrong
 * thing. The 1.0 factor makes "mostly sideways" mean sideways.
 */
export function facingSide(from: BoardRect, to: BoardRect): ConnectorSide {
  const a = centre(from)
  const b = centre(to)
  const dx = b.x - a.x
  const dy = b.y - a.y

  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** The opposite side — where the connector arrives. */
export function oppositeSide(side: ConnectorSide): ConnectorSide {
  switch (side) {
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
  }
}

/**
 * How far the curve pushes out perpendicular to its exit side before turning.
 *
 * Proportional to the gap, so a link between adjacent frames does not loop
 * halfway across the board and a link across a wide board does not look like a
 * straight line with a kink. Clamped at both ends: below the floor the curve
 * degenerates into a corner, above the ceiling it bows so far it crosses
 * unrelated frames.
 */
export function controlOffset(distance: number): number {
  const CURVE_FLOOR = 24
  const CURVE_CEILING = 220
  return Math.min(CURVE_CEILING, Math.max(CURVE_FLOOR, Math.abs(distance) * 0.4))
}

function pushOut(point: BoardPoint, side: ConnectorSide, amount: number): BoardPoint {
  switch (side) {
    case 'left':
      return { x: point.x - amount, y: point.y }
    case 'right':
      return { x: point.x + amount, y: point.y }
    case 'top':
      return { x: point.x, y: point.y - amount }
    case 'bottom':
      return { x: point.x, y: point.y + amount }
  }
}

/**
 * Route a connector from a source element's rect to a target frame's rect.
 *
 * Both ends leave perpendicular to their own edge, which is what makes a
 * connector readable as "out of here, into there" rather than a line that
 * happens to touch two boxes.
 */
export function routeConnector(source: BoardRect, target: BoardRect): ConnectorRoute {
  const fromSide = facingSide(source, target)
  const toSide = oppositeSide(fromSide)
  const from = pointOnSide(source, fromSide)
  const to = pointOnSide(target, toSide)

  const span = fromSide === 'left' || fromSide === 'right' ? to.x - from.x : to.y - from.y
  const offset = controlOffset(span)
  const c1 = pushOut(from, fromSide, offset)
  const c2 = pushOut(to, toSide, offset)

  return {
    from,
    to,
    fromSide,
    toSide,
    path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
  }
}

/**
 * The in-flight rubber band: a fixed source rect to a loose cursor point.
 *
 * Modelled as a zero-size rect at the cursor so it shares `routeConnector`'s
 * side-picking exactly. A drag that behaves differently from the connector it
 * is about to create is a drag that lies about what it will do.
 */
export function routeDraftConnector(source: BoardRect, cursor: BoardPoint): ConnectorRoute {
  return routeConnector(source, { x: cursor.x, y: cursor.y, width: 0, height: 0 })
}

/**
 * The point the `+` handle attaches to: the middle of the element's right edge.
 *
 * The visible gap between the element and the handle is deliberately NOT here.
 * Board space scales with zoom, so a gap expressed in board units collapses to
 * nothing when zoomed out and yawns open when zoomed in — while the handle
 * itself is drawn at a constant SCREEN size (see the module CSS). Chrome
 * spacing is a screen-space decision, so the stylesheet owns it and this
 * function answers only "where on the element".
 */
export function handlePoint(source: BoardRect): BoardPoint {
  return { x: source.x + source.width, y: source.y + source.height / 2 }
}

/** Which frame rect contains a board point, innermost-last wins. */
export function frameAtBoardPoint<T extends BoardRect>(frames: readonly T[], point: BoardPoint): T | null {
  let found: T | null = null
  for (const frame of frames) {
    if (
      point.x >= frame.x &&
      point.x <= frame.x + frame.width &&
      point.y >= frame.y &&
      point.y <= frame.y + frame.height
    ) {
      found = frame
    }
  }
  return found
}

/**
 * The bounding box of every point a set of routes touches, padded.
 *
 * The SVG needs a viewBox that covers the curves, and a curve bows OUTSIDE the
 * straight line between its endpoints — so a box around the endpoints alone
 * clips exactly the part of the connector that makes it readable.
 */
export function routesBounds(routes: readonly ConnectorRoute[], pad = 8): BoardRect | null {
  if (routes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const route of routes) {
    const span = route.fromSide === 'left' || route.fromSide === 'right'
      ? route.to.x - route.from.x
      : route.to.y - route.from.y
    const offset = controlOffset(span)
    for (const p of [route.from, route.to, pushOut(route.from, route.fromSide, offset), pushOut(route.to, route.toSide, offset)]) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }

  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
}
