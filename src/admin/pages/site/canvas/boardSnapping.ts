/**
 * boardSnapping — what a piece of board furniture (a frame, a sticky note, a
 * doc block) snaps TO. The resolver itself is `@core/studio-runtime`'s
 * `snapRules.ts`, shared with the element-level gestures; this module only
 * turns a `Board` into the flat `SnapRect[]` peer list it wants.
 *
 * `collectPeerRects` excludes whichever object is currently being dragged so
 * it never snaps to itself. Frames without a saved size fall back to
 * `FRAME_WIDTH`/`FRAME_HEIGHT` — the same fallback `BoardFramesLayer` itself
 * uses at render time.
 */
import { FRAME_WIDTH, FRAME_HEIGHT, type Board, type BoardGuide } from '@core/studio-board'
import type { SnapRect } from '@core/studio-runtime'

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
