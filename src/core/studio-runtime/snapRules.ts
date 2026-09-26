/**
 * snapRules — the ONE pure snap-to-peer resolver on the canvas. Board
 * furniture (frames, sticky notes, doc blocks — `boardSnapping.ts` turns a
 * board into peers) uses it, and so do the element-level gestures one layer
 * down: a free move (`canvasFreeMove.ts`) and an element resize, in a portal
 * frame (`useElementResizeDrag.ts`) and inside a live frame's own runtime
 * (`resizeHandles.ts`, P2-E / IX-6e). It lives in `@core/studio-runtime` for
 * that last caller: the live frame's handles run in a cross-origin document
 * and can import no admin module, and a second copy of this math would drift.
 *
 * `computeSnap` is the testable core (Phase 6B): given a dragged rect, its
 * peers, and a threshold, it finds the closest edge/center alignment on each
 * axis independently and returns the adjusted top-left position plus the
 * guide line(s) to draw. `computeEdgeSnap` is the same question for ONE
 * moving edge — what a resize handle moves. Pure — no React, no DOM.
 *
 * ## The threshold is screen pixels (IX-5a)
 *
 * Every caller passes `snapThresholdAtZoom(zoom)`: {@link SNAP_THRESHOLD_SCREEN_PX}
 * divided by the canvas zoom, in whatever unit the rects are in (board units
 * or frame px — both are "one CSS px at 100%"). A fixed rect-space threshold
 * used to be 24 screen px of pull at 400% and 1.5 px at 25%, so snapping felt
 * sticky zoomed in and absent zoomed out. Penpot does the same division
 * (`main/snap.cljs`, `snap-accuracy / zoom`).
 *
 * ## Three kinds of snap, one answer per axis (P5-F)
 *
 * Per axis, the closest of three candidates within the threshold wins:
 *
 *  - **alignment** — a dragged edge or centre on a peer's edge or centre;
 *  - **a ruler guide** (IX-5c) — a dragged edge or centre on a persisted
 *    guide line ({@link SnapLine}), converted into the rects' own space by
 *    the caller;
 *  - **equal spacing** (IX-5d) — the same gap as one the row already has, or
 *    centred between two neighbours (`snapSpacingRules.ts`).
 *
 * The distance pills ({@link SnapResult.spacings}) describe the rect where it
 * ENDS UP, whichever candidate moved it. What is offered at all is the
 * user's choice (IX-5e): objects (peers and spacing) and ruler guides toggle
 * independently, and {@link snapSourcesFor} is the one place that applies the
 * toggles, so no gesture can forget one.
 */
import type { SnapRect } from './snapRectRules'
import { findSpacingSnap, spacingSegments, type SnapSpacing } from './snapSpacingRules'

export type { SnapRect } from './snapRectRules'
export type { SnapSpacing } from './snapSpacingRules'

/**
 * A guide line to draw at board-space `position` on `axis`, spanning
 * `start`..`end` on the OTHER axis (the union of the dragged rect's and the
 * matched peer's extents on that axis) — enough to draw a line touching both.
 */
export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
  start: number
  end: number
}

export interface SnapResult {
  x: number
  y: number
  guides: SnapGuide[]
  /** IX-5d — the equal gaps the snapped rect now has, drawn as distance pills. */
  spacings: SnapSpacing[]
}

/**
 * An infinite snap line on ONE axis — a ruler guide (IX-5c) in the rects' own
 * space. `axis: 'x'` is a vertical line at `x = position`.
 */
export interface SnapLine {
  axis: 'x' | 'y'
  position: number
}

/** What `computeSnap` may snap to beyond the peers, and how. */
export interface SnapOptions {
  /** Ruler guides, already in the rects' space. */
  lines?: readonly SnapLine[]
  /**
   * Equal-spacing snap and its pills (IX-5d). On unless the user turned
   * object snapping off ({@link snapSourcesFor}).
   */
  spacing?: boolean
  /**
   * ⇧ axis lock — the axis the drag is NOT moving on. It stays exactly where
   * the constraint put it: snapping it would pull the element off the line
   * the user is holding it to (Penpot's `snap-ignore-axis`,
   * `transforms.cljs:775-790`).
   */
  lockedAxis?: 'x' | 'y' | null
}

/**
 * Whether two guide lists would draw the same lines.
 *
 * D2 G8 — a furniture drag recomputes the snap on every `pointermove` and
 * hands the result to `setBoardSnapGuides`. On the overwhelming majority of
 * those events the answer is identical to the last one (usually: no guides at
 * all), and a store write of an equal value is still a full notification plus
 * a selector sweep across every board subscriber — per pointer event, for a
 * redraw of nothing. This is what lets that write be skipped. Kept beside the
 * type it compares (and pure) rather than inside the store action, so the
 * board-drag handlers, the annotation drag and any future furniture share one
 * definition of "the same guides".
 */
export function snapGuidesEqual(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (
      left.axis !== right.axis ||
      left.position !== right.position ||
      left.start !== right.start ||
      left.end !== right.end
    ) {
      return false
    }
  }
  return true
}

/**
 * How close an edge must come to a peer's edge to snap, in SCREEN pixels —
 * the same pull at every zoom. Convert with {@link snapThresholdAtZoom}.
 */
export const SNAP_THRESHOLD_SCREEN_PX = 8

/**
 * The snap threshold in rect units (board units, or frame px) at `zoom`
 * (1 = 100%). An unreadable zoom is treated as 100% rather than producing an
 * infinite or negative threshold.
 */
export function snapThresholdAtZoom(zoom: number): number {
  return SNAP_THRESHOLD_SCREEN_PX / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
}

interface AxisEdges {
  start: number
  center: number
  end: number
}

function edgesX(rect: SnapRect): AxisEdges {
  return { start: rect.x, center: rect.x + rect.width / 2, end: rect.x + rect.width }
}

function edgesY(rect: SnapRect): AxisEdges {
  return { start: rect.y, center: rect.y + rect.height / 2, end: rect.y + rect.height }
}

interface AxisMatch {
  distance: number
  draggedValue: number
  peerValue: number
  peer: SnapRect
}

/**
 * Closest (dragged value, peer edge) pair within `threshold`, checking every
 * dragged value against every peer's start/center/end (so e.g. the dragged
 * left edge can snap to a peer's center, not just its left edge) — "closest
 * wins" across all peers and all combinations.
 */
function findClosestMatch(
  draggedValues: readonly number[],
  peers: readonly SnapRect[],
  edgesOf: (rect: SnapRect) => AxisEdges,
  threshold: number,
): AxisMatch | null {
  let best: AxisMatch | null = null

  for (const peer of peers) {
    const peerEdges = edgesOf(peer)
    const peerValues = [peerEdges.start, peerEdges.center, peerEdges.end]
    for (const draggedValue of draggedValues) {
      for (const peerValue of peerValues) {
        const distance = Math.abs(draggedValue - peerValue)
        if (distance > threshold) continue
        if (!best || distance < best.distance) {
          best = { distance, draggedValue, peerValue, peer }
        }
      }
    }
  }

  return best
}

/**
 * The guide for a match on `axis`: a line at the peer's edge, spanning the
 * union of the dragged extent and the peer's extent on the OTHER axis — long
 * enough to touch both.
 */
function guideFor(axis: 'x' | 'y', match: AxisMatch, span: { start: number; end: number }): SnapGuide {
  const peerStart = axis === 'x' ? match.peer.y : match.peer.x
  const peerEnd = axis === 'x' ? match.peer.y + match.peer.height : match.peer.x + match.peer.width
  return {
    axis,
    position: match.peerValue,
    start: Math.min(span.start, peerStart),
    end: Math.max(span.end, peerEnd),
  }
}

interface LineMatch {
  distance: number
  draggedValue: number
  position: number
}

/** The closest line on `axis` to any of the dragged values, within `threshold`. */
function findClosestLine(
  axis: 'x' | 'y',
  draggedValues: readonly number[],
  lines: readonly SnapLine[],
  threshold: number,
): LineMatch | null {
  let best: LineMatch | null = null
  for (const line of lines) {
    if (line.axis !== axis) continue
    for (const draggedValue of draggedValues) {
      const distance = Math.abs(draggedValue - line.position)
      if (distance > threshold) continue
      if (!best || distance < best.distance) best = { distance, draggedValue, position: line.position }
    }
  }
  return best
}

/** A ruler-guide snap draws its guide along the dragged extent only: the ruler line itself is already on screen. */
function lineGuide(axis: 'x' | 'y', position: number, span: { start: number; end: number }): SnapGuide {
  return { axis, position, start: span.start, end: span.end }
}

interface AxisCandidate {
  distance: number
  /** The dragged rect's new start on this axis. */
  start: number
  guide: SnapGuide | null
}

/**
 * One axis of `computeSnap`: the closest of an alignment match, a ruler-guide
 * match and an equal-spacing match, or `null` when none is within `threshold`.
 * A tie keeps the earlier kind — alignment, then the guide — because both draw
 * a line that explains the snap; a spacing snap explains itself with pills.
 */
function snapAxis(
  axis: 'x' | 'y',
  dragged: SnapRect,
  peers: readonly SnapRect[],
  threshold: number,
  options: SnapOptions,
): AxisCandidate | null {
  const edges = axis === 'x' ? edgesX(dragged) : edgesY(dragged)
  const values = [edges.start, edges.center, edges.end]
  const span = axis === 'x'
    ? { start: dragged.y, end: dragged.y + dragged.height }
    : { start: dragged.x, end: dragged.x + dragged.width }
  const candidates: AxisCandidate[] = []

  const match = findClosestMatch(values, peers, axis === 'x' ? edgesX : edgesY, threshold)
  if (match) {
    candidates.push({
      distance: match.distance,
      start: edges.start + (match.peerValue - match.draggedValue),
      guide: guideFor(axis, match, span),
    })
  }

  const line = findClosestLine(axis, values, options.lines ?? [], threshold)
  if (line) {
    candidates.push({
      distance: line.distance,
      start: edges.start + (line.position - line.draggedValue),
      guide: lineGuide(axis, line.position, span),
    })
  }

  if (options.spacing !== false) {
    const spacing = findSpacingSnap(axis, dragged, peers, threshold)
    if (spacing) candidates.push({ distance: spacing.distance, start: spacing.start, guide: null })
  }

  let best: AxisCandidate | null = null
  for (const candidate of candidates) {
    if (!best || candidate.distance < best.distance) best = candidate
  }
  return best
}

/**
 * Snaps `dragged` on each axis independently to the closest alignment, ruler
 * guide or equal-spacing position (at most one snap per axis — "closest
 * wins"), returning the adjusted top-left position, the guide line(s) to draw
 * and the distance pills. No match within `threshold` on an axis leaves that
 * axis's position untouched and emits no guide for it.
 */
export function computeSnap(
  dragged: SnapRect,
  peers: readonly SnapRect[],
  threshold: number,
  options: SnapOptions = {},
): SnapResult {
  const guides: SnapGuide[] = []
  let x = dragged.x
  let y = dragged.y

  const xSnap = options.lockedAxis === 'x' ? null : snapAxis('x', dragged, peers, threshold, options)
  if (xSnap) {
    x = xSnap.start
    if (xSnap.guide) guides.push(xSnap.guide)
  }

  const ySnap = options.lockedAxis === 'y' ? null : snapAxis('y', dragged, peers, threshold, options)
  if (ySnap) {
    y = ySnap.start
    if (ySnap.guide) guides.push(ySnap.guide)
  }

  const spacings = options.spacing === false
    ? []
    : spacingSegments({ x, y, width: dragged.width, height: dragged.height }, peers)
  return { x, y, guides, spacings }
}

/** One moving edge's snap: how far to move it, and the guide to draw there. */
export interface EdgeSnap {
  delta: number
  guide: SnapGuide
}

/**
 * Snaps ONE moving edge — the edge a resize handle drags (IX-6e) — to the
 * closest peer start/center/end on the same axis, or to a ruler guide
 * (IX-5c). `value` is the edge's position on `axis` (an x for a vertical
 * edge); `span` is the element's extent on the OTHER axis, which only sizes
 * the guide. `null` when nothing is within `threshold`.
 */
export function computeEdgeSnap(
  axis: 'x' | 'y',
  value: number,
  span: { start: number; end: number },
  peers: readonly SnapRect[],
  threshold: number,
  lines: readonly SnapLine[] = [],
): EdgeSnap | null {
  const match = findClosestMatch([value], peers, axis === 'x' ? edgesX : edgesY, threshold)
  const line = findClosestLine(axis, [value], lines, threshold)
  if (line && (!match || line.distance < match.distance)) {
    return { delta: line.position - value, guide: lineGuide(axis, line.position, span) }
  }
  if (!match) return null
  return { delta: match.peerValue - value, guide: guideFor(axis, match, span) }
}

/**
 * The user's snap toggles (IX-5e) — the shape `snapSourcesFor` reads. The
 * editor persists them (`canvas/snapPreferences.ts`, TypeBox-validated); a
 * live frame's runtime, which has no toggles of its own yet, passes
 * {@link ALL_SNAP_SOURCES}.
 */
export interface SnapSourceToggles {
  objects: boolean
  guides: boolean
}

/** Both toggles on — the default, and what a caller without toggles snaps with. */
export const ALL_SNAP_SOURCES: SnapSourceToggles = { objects: true, guides: true }

/**
 * The snap toggles' effect on one gesture's sources — IX-5e, in one place so
 * no gesture can honour one toggle and forget the other. Object snapping off
 * drops the peers AND equal spacing (which is measured against the peers);
 * guide snapping off drops the ruler lines.
 */
export function snapSourcesFor(
  preferences: SnapSourceToggles,
  peers: readonly SnapRect[],
  lines: readonly SnapLine[],
): { peers: readonly SnapRect[]; options: SnapOptions } {
  return {
    peers: preferences.objects ? peers : [],
    options: { lines: preferences.guides ? lines : [], spacing: preferences.objects },
  }
}
