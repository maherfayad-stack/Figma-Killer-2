import type { Box } from './geometry.js';

/**
 * Sub-workstream 2c (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2
 * split) — drag-to-move / resize "gesture finished, here's the final box"
 * pub-sub. Mirrors `frame-shape.tsx`'s existing `onFrameGeometryCommitted`/
 * `emitFrameGeometryCommitted` module-level `Set`-of-listeners pattern
 * exactly (same reasoning: there's exactly one `Canvas` per page in this
 * architecture, so a module-level singleton is equivalent to a React
 * context in practice with far less plumbing) — a small standalone module
 * rather than living inside `Canvas.tsx` itself so a future subscriber
 * (sub-workstream 2d, wiring this to the daemon's `set-geometry` call) can
 * import just this one file without pulling in the whole `Canvas`
 * component.
 *
 * Fired exactly once per completed drag-to-move or resize gesture (on
 * pointer-up), with the frame's FINAL box — never on every intermediate
 * pointer-move, and never for the live-preview updates `Canvas.tsx` also
 * writes to `camera-store.ts`'s `setFrameBox` while the gesture is still in
 * progress. A move and a resize both fire the identical event shape (a
 * resize is just another kind of "this frame's box changed, here's the
 * final value" event) — matching `frame-shape.tsx`'s own `onResizeEnd`/
 * `onTranslateEnd`, which both call the identical
 * `emitFrameGeometryCommitted`, no need to distinguish the two here either.
 *
 * NOT wired to the daemon in this pass — sub-workstream 2c is only
 * responsible for the LOCAL interaction + firing this event for a future
 * subscriber; sending `set-geometry` over a daemon connection is 2d's job.
 */
export interface CommittedFrameGeometry extends Box {
  id: string;
}

type GeometryCommitListener = (geometry: CommittedFrameGeometry) => void;

const listeners = new Set<GeometryCommitListener>();

export function onFrameGeometryCommitted(listener: GeometryCommitListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitFrameGeometryCommitted(geometry: CommittedFrameGeometry): void {
  for (const listener of listeners) listener(geometry);
}
