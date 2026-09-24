/**
 * boardSnapping — the ONE pure snap-to-peer resolver on the canvas. Board
 * furniture (frames, sticky notes, doc blocks) uses it, and so do the
 * element-level gestures one layer down: a free move (`canvasFreeMove.ts`)
 * and an element resize (`elementResizeSnap.ts`, P2-E / IX-6e).
 *
 * `computeSnap` is the testable core (Phase 6B): given a dragged rect, its
 * peers, and a threshold, it finds the closest edge/center alignment on each
 * axis independently and returns the adjusted top-left position plus the
 * guide line(s) to draw. `computeEdgeSnap` is the same question for ONE
 * moving edge — what a resize handle moves. Pure — no React, no DOM —
 * mirroring `rectResize.ts` / `frameVirtualization.ts`.
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
 * `collectPeerRects` is the one non-pure-math helper: it turns a `Board`'s
 * frames/notes/docs into the flat `SnapRect[]` peer list `computeSnap` wants,
 * excluding whichever object is currently being dragged so it never snaps to
 * itself. Frames without a saved size fall back to `FRAME_WIDTH`/`FRAME_HEIGHT`
 * — the same fallback `BoardFramesLayer` itself uses at render time.
 */
import { FRAME_WIDTH, FRAME_HEIGHT, type Board, type BoardGuide } from '@core/studio-board'

/** A furniture rect in board-space units (top-left + size). */
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

/** Identifies which furniture is currently being dragged, so `collectPeerRects`
 * can exclude it from its own peer list. */
export type DraggedFurniture =
  | { kind: 'frame'; pageId: string }
  | { kind: 'note'; id: string }
  | { kind: 'doc'; id: string }
  // P5-G — a loose layer: every frame, note and doc is a peer. Other loose
  // layers are too, but their sizes are measured (`canvasLayerGeometry.ts`),
  // not stored on the board, so the caller adds them.
  | { kind: 'layer'; id: string }

/**
 * Every OTHER piece of furniture on `board` (frames, notes, docs) as a flat
 * `SnapRect[]`, excluding whichever one is being dragged. Frames without a
 * saved width/height fall back to `FRAME_WIDTH`/`FRAME_HEIGHT`, mirroring
 * `BoardFramesLayer`'s own render-time fallback.
 */
export function collectPeerRects(board: Board, dragged: DraggedFurniture): SnapRect[] {
  const peers: SnapRect[] = []

  for (const frame of board.frames) {
    if (dragged.kind === 'frame' && frame.pageId === dragged.pageId) continue
    peers.push({
      x: frame.x,
      y: frame.y,
      width: frame.width ?? FRAME_WIDTH,
      height: frame.height ?? FRAME_HEIGHT,
    })
  }

  for (const note of board.notes) {
    if (dragged.kind === 'note' && note.id === dragged.id) continue
    peers.push({ x: note.x, y: note.y, width: note.w, height: note.h })
  }

  for (const doc of board.docs) {
    if (dragged.kind === 'doc' && doc.id === dragged.id) continue
    peers.push({ x: doc.x, y: doc.y, width: doc.w, height: doc.h })
  }

  return peers
}

/**
 * D1 — persisted ruler guides (`@core/studio-board`'s `BoardGuide`, NOT this
 * file's own transient `SnapGuide`) as `computeSnap`-compatible peer rects,
 * so a dragged frame/note/doc can align to them the same way it aligns to
 * other furniture. A guide is a single-coordinate infinite line on ONE axis,
 * not a rect — represented as a zero-size point PLACED FAR OFF-SCREEN on the
 * OTHER axis (`OFF_AXIS_SENTINEL`), so `findClosestMatch`'s distance check on
 * that other axis can never spuriously fall within any real threshold.
 *
 * NOT YET called from `collectPeerRects` or wired into a live drag handler
 * (`BoardFrameView.tsx` etc.) — the caller is expected to concat this with
 * `collectPeerRects`'s own result once one exists. See `STATE.md`'s D1
 * handoff for why this stops at the pure-function level.
 */
const OFF_AXIS_SENTINEL = 1_000_000

export function guideSnapRects(guides: readonly BoardGuide[]): SnapRect[] {
  return guides.map((guide) =>
    guide.axis === 'x'
      ? { x: guide.position, y: OFF_AXIS_SENTINEL, width: 0, height: 0 }
      : { x: OFF_AXIS_SENTINEL, y: guide.position, width: 0, height: 0 },
  )
}
