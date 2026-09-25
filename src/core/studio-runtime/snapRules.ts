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
 */

/** A rect in board units or frame px (top-left + size) — whichever space the caller snaps in. */
export interface SnapRect {
  x: number
  y: number
  width: number
  height: number
}

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

/**
 * Snaps `dragged` to the closest aligned peer edge/center on each axis
 * independently (at most one snap per axis — "closest wins"), returning the
 * adjusted top-left position and the guide line(s) to draw. No peers, or no
 * match within `threshold` on an axis, leaves that axis's position untouched
 * and emits no guide for it.
 */
export function computeSnap(dragged: SnapRect, peers: readonly SnapRect[], threshold: number): SnapResult {
  const guides: SnapGuide[] = []
  let x = dragged.x
  let y = dragged.y

  const draggedX = edgesX(dragged)
  const xMatch = findClosestMatch([draggedX.start, draggedX.center, draggedX.end], peers, edgesX, threshold)
  if (xMatch) {
    x = dragged.x + (xMatch.peerValue - xMatch.draggedValue)
    guides.push(guideFor('x', xMatch, { start: dragged.y, end: dragged.y + dragged.height }))
  }

  const draggedY = edgesY(dragged)
  const yMatch = findClosestMatch([draggedY.start, draggedY.center, draggedY.end], peers, edgesY, threshold)
  if (yMatch) {
    y = dragged.y + (yMatch.peerValue - yMatch.draggedValue)
    guides.push(guideFor('y', yMatch, { start: dragged.x, end: dragged.x + dragged.width }))
  }

  return { x, y, guides }
}

/** One moving edge's snap: how far to move it, and the guide to draw there. */
export interface EdgeSnap {
  delta: number
  guide: SnapGuide
}

/**
 * Snaps ONE moving edge — the edge a resize handle drags (IX-6e) — to the
 * closest peer start/center/end on the same axis. `value` is the edge's
 * position on `axis` (an x for a vertical edge); `span` is the element's
 * extent on the OTHER axis, which only sizes the guide. `null` when no peer
 * edge is within `threshold`.
 */
export function computeEdgeSnap(
  axis: 'x' | 'y',
  value: number,
  span: { start: number; end: number },
  peers: readonly SnapRect[],
  threshold: number,
): EdgeSnap | null {
  const match = findClosestMatch([value], peers, axis === 'x' ? edgesX : edgesY, threshold)
  if (!match) return null
  return { delta: match.peerValue - value, guide: guideFor(axis, match, span) }
}

