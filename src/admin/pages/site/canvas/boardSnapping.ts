/**
 * boardSnapping — pure snap-to-peer alignment for studio board furniture
 * (frames, sticky notes, doc blocks).
 *
 * `computeSnap` is the testable core (Phase 6B): given a dragged rect, the
 * OTHER furniture on the active board, and a threshold (board units), it
 * finds the closest edge/center alignment on each axis independently and
 * returns the adjusted top-left position plus the guide line(s) to draw.
 * Pure — no React, no DOM — mirroring `rectResize.ts` / `frameVirtualization.ts`.
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

/** Default snap distance, in board units (not screen pixels — a fixed feel
 * regardless of zoom was simpler than dividing a screen-pixel constant by
 * zoom, and reads fine in practice since board furniture rarely sits near
 * the snap threshold at extreme zoom levels). */
export const SNAP_THRESHOLD_BOARD_UNITS = 8

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
 * Closest (dragged edge, peer edge) pair within `threshold`, checking every
 * combination of the dragged rect's start/center/end against every peer's
 * start/center/end (so e.g. the dragged left edge can snap to a peer's
 * center, not just its left edge) — "closest wins" across all peers and all
 * combinations.
 */
function findClosestMatch(
  draggedEdges: AxisEdges,
  peers: SnapRect[],
  edgesOf: (rect: SnapRect) => AxisEdges,
  threshold: number,
): AxisMatch | null {
  const draggedValues = [draggedEdges.start, draggedEdges.center, draggedEdges.end]
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
 * Snaps `dragged` to the closest aligned peer edge/center on each axis
 * independently (at most one snap per axis — "closest wins"), returning the
 * adjusted top-left position and the guide line(s) to draw. No peers, or no
 * match within `threshold` on an axis, leaves that axis's position untouched
 * and emits no guide for it.
 */
export function computeSnap(dragged: SnapRect, peers: SnapRect[], threshold: number): SnapResult {
  const guides: SnapGuide[] = []
  let x = dragged.x
  let y = dragged.y

  const xMatch = findClosestMatch(edgesX(dragged), peers, edgesX, threshold)
  if (xMatch) {
    x = dragged.x + (xMatch.peerValue - xMatch.draggedValue)
    guides.push({
      axis: 'x',
      position: xMatch.peerValue,
      start: Math.min(dragged.y, xMatch.peer.y),
      end: Math.max(dragged.y + dragged.height, xMatch.peer.y + xMatch.peer.height),
    })
  }

  const yMatch = findClosestMatch(edgesY(dragged), peers, edgesY, threshold)
  if (yMatch) {
    y = dragged.y + (yMatch.peerValue - yMatch.draggedValue)
    guides.push({
      axis: 'y',
      position: yMatch.peerValue,
      start: Math.min(dragged.x, yMatch.peer.x),
      end: Math.max(dragged.x + dragged.width, yMatch.peer.x + yMatch.peer.width),
    })
  }

  return { x, y, guides }
}

/** Identifies which furniture is currently being dragged, so `collectPeerRects`
 * can exclude it from its own peer list. */
export type DraggedFurniture =
  | { kind: 'frame'; pageId: string }
  | { kind: 'note'; id: string }
  | { kind: 'doc'; id: string }

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
