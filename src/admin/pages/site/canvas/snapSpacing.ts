/**
 * snapSpacing — equal-spacing snap and its distance pills (P5-F, IX-5d).
 *
 * Alignment snapping (`computeSnap`'s edge/centre match) answers "is this edge
 * on that edge". A designer laying out a row of cards asks a second question
 * just as often: "is this gap the same as that gap". Penpot answers it in
 * `ui/workspace/viewport/snap_distances.cljs` (the pink distance segments) and
 * `main/snap.cljs:145-250`; Figma draws the same pink pills. This is the same
 * segment algorithm, over the same flat `SnapRect[]` peer list alignment uses,
 * so board furniture, a free move inside a frame and a loose layer on the
 * empty board (P5-G) all get it from one place.
 *
 * ## The model, per axis (x shown; y is the transpose)
 *
 *  - The ROW is every peer that overlaps the dragged rect on the OTHER axis —
 *    the things a horizontal gap can be measured against.
 *  - The row's own GAPS are the distances between each peer and its nearest
 *    row neighbour to the right that it also overlaps. Those are the gaps the
 *    user already made, and the only ones worth matching.
 *  - The dragged rect's nearest neighbour on each side (`before`, `after`) is
 *    what it would be spaced from.
 *
 * Three kinds of candidate position, closest within the threshold wins:
 *
 *  1. `before.end + gap` — the same gap after the left neighbour;
 *  2. `after.start - gap - width` — the same gap before the right neighbour;
 *  3. centred between `before` and `after` — equal gaps on both sides.
 *
 * ## Pills describe the RESULT, not the snap
 *
 * {@link spacingSegments} runs on the final rect, whichever snap moved it
 * there (or none did). A pill says "these gaps are equal", and that is either
 * true of the rect the user sees or it is not — an alignment snap that happens
 * to land on an equal gap shows its pills too, and a spacing snap that lost to
 * a closer alignment shows none.
 *
 * Pure: no React, no DOM, no store.
 */
import type { SnapRect } from './snapRect'

type Axis = 'x' | 'y'

/**
 * One measured gap to draw: a segment on `axis` from `from` to `to`, drawn at
 * `at` on the other axis, labelled `value` (= `to - from`). All in the same
 * space as the rects it was measured from.
 */
export interface SnapSpacing {
  axis: Axis
  from: number
  to: number
  at: number
  value: number
}

/** A spacing snap on one axis: where the rect's start edge goes, and how far that is. */
export interface SpacingSnapMatch {
  /** The dragged rect's new start coordinate on the axis. */
  start: number
  /** `|start - current start|` — compared against the alignment match by the caller. */
  distance: number
}

/** Two gaps closer than this are the same gap — sub-pixel layout noise, not a difference. */
const EQUAL_GAP_EPSILON = 0.5

interface Span {
  start: number
  end: number
}

function spanOn(axis: Axis, rect: SnapRect): Span {
  return axis === 'x' ? { start: rect.x, end: rect.x + rect.width } : { start: rect.y, end: rect.y + rect.height }
}

function other(axis: Axis): Axis {
  return axis === 'x' ? 'y' : 'x'
}

/** Strictly positive overlap — two rects that only touch share no row. */
function overlapsOn(axis: Axis, a: SnapRect, b: SnapRect): boolean {
  const sa = spanOn(axis, a)
  const sb = spanOn(axis, b)
  return Math.min(sa.end, sb.end) - Math.max(sa.start, sb.start) > 0
}

/** The middle of two rects' shared extent on `axis` — where a gap segment between them is drawn. */
function sharedMiddle(axis: Axis, a: SnapRect, b: SnapRect): number {
  const sa = spanOn(axis, a)
  const sb = spanOn(axis, b)
  return (Math.max(sa.start, sb.start) + Math.min(sa.end, sb.end)) / 2
}

/** Peers that share a row (x) or a column (y) with `rect`. */
function rowOf(axis: Axis, rect: SnapRect, peers: readonly SnapRect[]): SnapRect[] {
  return peers.filter((peer) => overlapsOn(other(axis), peer, rect))
}

interface Gap {
  value: number
  segment: SnapSpacing
}

/**
 * The gaps the row already has: each peer to its nearest following neighbour
 * that it also overlaps. Zero and negative gaps (touching, overlapping) are
 * not spacing anyone chose.
 */
function rowGaps(axis: Axis, row: readonly SnapRect[]): Gap[] {
  const gaps: Gap[] = []
  for (const a of row) {
    const aSpan = spanOn(axis, a)
    let nearest: SnapRect | null = null
    let nearestStart = Infinity
    for (const b of row) {
      if (b === a) continue
      const bStart = spanOn(axis, b).start
      if (bStart < aSpan.end || bStart >= nearestStart) continue
      if (!overlapsOn(other(axis), a, b)) continue
      nearest = b
      nearestStart = bStart
    }
    if (!nearest) continue
    const value = nearestStart - aSpan.end
    if (value <= 0) continue
    gaps.push({
      value,
      segment: { axis, from: aSpan.end, to: nearestStart, at: sharedMiddle(other(axis), a, nearest), value },
    })
  }
  return gaps
}

interface Neighbours {
  before: SnapRect | null
  after: SnapRect | null
}

/**
 * The nearest row peer wholly before and wholly after `rect` on `axis`. A peer
 * may overlap the rect by up to `slack` and still count — without it, a rect
 * dragged a pixel INTO its neighbour would lose the neighbour it is about to
 * be snapped back away from.
 */
function neighbours(axis: Axis, rect: SnapRect, row: readonly SnapRect[], slack: number): Neighbours {
  const span = spanOn(axis, rect)
  let before: SnapRect | null = null
  let beforeEnd = -Infinity
  let after: SnapRect | null = null
  let afterStart = Infinity
  for (const peer of row) {
    const peerSpan = spanOn(axis, peer)
    if (peerSpan.end <= span.start + slack && peerSpan.start < span.start && peerSpan.end > beforeEnd) {
      before = peer
      beforeEnd = peerSpan.end
    }
    if (peerSpan.start >= span.end - slack && peerSpan.end > span.end && peerSpan.start < afterStart) {
      after = peer
      afterStart = peerSpan.start
    }
  }
  return { before, after }
}

/**
 * The closest equal-spacing position for `rect` on `axis` within `threshold`,
 * or `null`. See the module doc for the three candidate kinds.
 */
export function findSpacingSnap(
  axis: Axis,
  rect: SnapRect,
  peers: readonly SnapRect[],
  threshold: number,
): SpacingSnapMatch | null {
  const row = rowOf(axis, rect, peers)
  if (row.length === 0) return null
  const span = spanOn(axis, rect)
  const size = span.end - span.start
  const { before, after } = neighbours(axis, rect, row, threshold)
  if (!before && !after) return null

  let best: SpacingSnapMatch | null = null
  const consider = (start: number) => {
    const distance = Math.abs(start - span.start)
    if (distance > threshold) return
    if (!best || distance < best.distance) best = { start, distance }
  }

  // The rect's own gaps are not references for themselves: measure the row
  // WITHOUT the rect (it is not in `peers` — the caller excludes the dragged
  // object — so every gap here is between two peers).
  // The gap the rect is being dropped INTO (before → after, with the rect
  // not in the row) is not a gap anyone will see once it lands.
  const split = (gap: Gap) =>
    before !== null && after !== null &&
    gap.segment.from === spanOn(axis, before).end && gap.segment.to === spanOn(axis, after).start
  for (const gap of rowGaps(axis, row)) {
    if (split(gap)) continue
    if (before) consider(spanOn(axis, before).end + gap.value)
    if (after) consider(spanOn(axis, after).start - gap.value - size)
  }
  if (before && after) {
    const room = spanOn(axis, after).start - spanOn(axis, before).end
    if (room >= size) consider(spanOn(axis, before).end + (room - size) / 2)
  }
  return best
}

/**
 * The pills to draw for `rect` where it now sits: every gap in its row and
 * column that equals one of the rect's own gaps to its neighbours, and those
 * gaps themselves. Empty when the rect is not equally spaced with anything.
 */
export function spacingSegments(rect: SnapRect, peers: readonly SnapRect[]): SnapSpacing[] {
  return [...axisSegments('x', rect, peers), ...axisSegments('y', rect, peers)]
}

function axisSegments(axis: Axis, rect: SnapRect, peers: readonly SnapRect[]): SnapSpacing[] {
  const row = rowOf(axis, rect, peers)
  if (row.length === 0) return []
  const span = spanOn(axis, rect)
  const { before, after } = neighbours(axis, rect, row, 0)

  const own: SnapSpacing[] = []
  if (before) {
    const from = spanOn(axis, before).end
    if (span.start - from > 0) {
      own.push({ axis, from, to: span.start, at: sharedMiddle(other(axis), before, rect), value: span.start - from })
    }
  }
  if (after) {
    const to = spanOn(axis, after).start
    if (to - span.end > 0) {
      own.push({ axis, from: span.end, to, at: sharedMiddle(other(axis), rect, after), value: to - span.end })
    }
  }
  if (own.length === 0) return []

  // A peer gap the rect sits inside is not a gap on screen — the rect splits it.
  const gaps = rowGaps(axis, row).filter((gap) => gap.segment.to <= span.start || gap.segment.from >= span.end)
  const matched = new Set<SnapSpacing>()
  for (const segment of own) {
    const equalPeers = gaps.filter((gap) => Math.abs(gap.value - segment.value) < EQUAL_GAP_EPSILON)
    const equalOwn = own.filter((o) => o !== segment && Math.abs(o.value - segment.value) < EQUAL_GAP_EPSILON)
    if (equalPeers.length === 0 && equalOwn.length === 0) continue
    matched.add(segment)
    for (const gap of equalPeers) matched.add(gap.segment)
  }
  return [...matched]
}

/** Whether two pill lists would draw the same thing — the store-write skip `snapGuidesEqual` gives guides. */
export function snapSpacingsEqual(a: readonly SnapSpacing[], b: readonly SnapSpacing[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (
      left.axis !== right.axis ||
      left.from !== right.from ||
      left.to !== right.to ||
      left.at !== right.at ||
      left.value !== right.value
    ) {
      return false
    }
  }
  return true
}

/** A gap as its pill shows it: whole px when it is one, one decimal otherwise. */
export function formatSpacing(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
