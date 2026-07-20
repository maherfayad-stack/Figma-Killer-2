import { create } from 'zustand';
import {
  computeCameraToFitBounds,
  screenPointToPageSpace,
  type Box,
  type CameraState,
  type FitBoundsOptions,
  type Point,
} from './geometry.js';

/**
 * Sub-workstream 2a (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2
 * split) — the camera/frames/selection store that replaces tldraw's
 * internal reactive store + `Editor.getCamera/zoomIn/zoomOut/resetZoom/
 * zoomToFit/zoomToBounds/zoomToSelection`. Zustand (matching
 * `selection-store.ts`'s convention) so it's readable/writable from both
 * React components and plain event handlers (`camera-gestures.ts`) outside
 * any component tree, same reasoning as that store's own module doc.
 *
 * PURE LOGIC ONLY in this sub-workstream: nothing here is wired into
 * `StudioCanvas.tsx`/`frame-shape.tsx` yet (that's 2b/2d) — this store and
 * its actions are built and unit-tested in isolation so the next
 * sub-workstream has correct, ready-to-consume camera math.
 *
 * `frames` deliberately does NOT use the real `CanvasFrameRecord` from
 * `project-wiring.ts` (id, fileFolder, framePath, name, devServerUrl, x, y,
 * w, h). Every camera computation this store does (`zoomToFit`,
 * `zoomToSelection`, hit-testing a screen point against a frame, etc.) only
 * ever needs a frame's id + its box — pulling in the full record would
 * couple this package's lowest-level camera math to daemon/dev-server
 * fields it never reads, which is exactly the kind of coupling
 * `CANVAS-ENGINE-DESIGN.md` calls out `viewport-cull.ts` for already having
 * avoided (`ReadonlyMap<Id, Box>`). A future sub-workstream mapping
 * `CanvasFrameRecord[]` -> this store's `frames` is a trivial narrowing
 * projection (`{ id, x, y, w, h }`), not a real dependency.
 */
export interface CameraFrame extends Box {
  id: string;
}

/** Default step factor for {@link CameraStoreState.zoomIn}/{@link
 * CameraStoreState.zoomOut}. tldraw's exact installed factor isn't
 * discoverable anywhere in this repo (no constant like this exists in
 * `StudioCanvas.tsx` or elsewhere — `onReady`'s `zoomIn`/`zoomOut` just
 * delegate straight to `editor.zoomIn`/`zoomOut` with no factor argument,
 * i.e. tldraw's own internal default, not a value this codebase ever
 * pins down). 1.25x per step (and its exact reciprocal, 0.8x, for
 * zoom-out) is the commonly documented tldraw/Figma-class convention — a
 * disclosed, reasonable choice, same category as `drag-geometry.ts`'s
 * `DRAG_THRESHOLD_PX` doc comment. FLAG for a later parity-verification
 * pass against real tldraw behavior.
 */
export const ZOOM_STEP_FACTOR = 1.25;

/** Reasonable absolute zoom bounds for `zoomIn`/`zoomOut`/`zoomAtPoint` —
 * without SOME bound, repeated zoom-out steps drift towards 0 (approaching
 * an unusable, numerically unstable camera) and repeated zoom-in steps
 * grow unbounded. Not discoverable from this repo (tldraw's own min/max
 * zoom constants aren't read anywhere in this codebase); a disclosed,
 * reasonable choice — FLAG for parity verification. Deliberately NOT
 * applied to `zoomToBounds`/`zoomToFit`/`zoomToSelection`, which must be
 * able to fit an arbitrarily large or small selection exactly (matching
 * tldraw's own `zoomToBounds`, which only clamps via the caller-supplied
 * `targetZoom`, never an absolute floor/ceiling).
 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Axis-aligned union of one or more boxes — the bounding box that
 * contains all of them. `null` for an empty input (nothing to fit). Kept
 * private to this module (not `geometry.ts`) since it's `zoomToFit`/
 * `zoomToSelection`-specific, unlike {@link computeCameraToFitBounds} which
 * is generically useful and lives in `geometry.ts` per the module's own
 * doc convention.
 */
function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface CameraStoreState {
  camera: CameraState;
  frames: Map<string, CameraFrame>;
  selectedIds: Set<string>;

  /** Replaces the entire frames map (e.g. from a fresh `CanvasFrameRecord[]`
   * sync, once a future sub-workstream wires that up). */
  setFrames(frames: CameraFrame[]): void;
  /** Direct camera assignment — for programmatic moves (e.g. restoring a
   * `previousCamera` snapshot on edit-mode exit, mirroring
   * `selection-store.ts`'s `previousCamera` field). */
  setCamera(camera: CameraState): void;
  /** Screen-space delta pan: dragging the canvas by `(dx, dy)` screen
   * pixels should move the content WITH the pointer by that same screen
   * distance regardless of zoom, which means the underlying page-space
   * camera offset must move by `(dx, dy) / z` (at 2x zoom, a 10px screen
   * drag is only a 5px page-space camera shift). Matches this module's
   * `pagePointToScreenSpace` convention: `screen = (page + camera) * z` =>
   * to keep a screen delta of `(dx,dy)` for the same page point, `camera`
   * must shift by `(dx,dy)/z`. */
  pan(dx: number, dy: number): void;
  /** Zoom to `newZoom` while keeping the page-space point currently under
   * `screenPoint` fixed at that same screen position (the standard
   * "zoom at cursor" gesture). `viewportSize` is accepted for API symmetry
   * with the other viewport-aware actions below (and so callers driving
   * this from a wheel/pinch gesture never need a different call shape
   * depending on WHERE the fixed point is) but isn't needed by the math
   * itself — the fixed-point computation only depends on the CURRENT
   * camera, `screenPoint`, and `newZoom`. */
  zoomAtPoint(newZoom: number, screenPoint: Point, viewportSize: { w: number; h: number }): void;
  /** Steps zoom in by {@link ZOOM_STEP_FACTOR}, anchored at the viewport
   * center (not the cursor — there is no cursor position for a
   * button/keyboard-triggered zoom step). */
  zoomIn(viewportSize: { w: number; h: number }): void;
  /** Steps zoom out by `1 / ZOOM_STEP_FACTOR`, anchored at the viewport
   * center. */
  zoomOut(viewportSize: { w: number; h: number }): void;
  /** Resets to `z = 1`, keeping whatever page-space point is CURRENTLY at
   * the viewport center still centered afterwards (tldraw's own
   * `resetZoom` semantics — it's a recenter-preserving zoom reset, not a
   * jump back to the origin). Implemented as `zoomAtPoint(1, center, ...)`
   * since "keep the point currently at X fixed at X while changing zoom"
   * is exactly what `zoomAtPoint` already does, with `X` = the viewport
   * center. */
  resetZoom(viewportSize: { w: number; h: number }): void;
  /** Fits `box` into the viewport (see {@link computeCameraToFitBounds} for
   * the exact inset/targetZoom-clamp math this replicates from tldraw's
   * `editor.zoomToBounds`), then centers the camera on `box`. */
  zoomToBounds(box: Box, viewportSize: { w: number; h: number }, opts?: FitBoundsOptions): void;
  /** Fits the union of every frame in `frames` into the viewport, no
   * `targetZoom` clamp (fit exactly). No-op if there are no frames (
   * nothing to fit — mirrors {@link zoomToSelection}'s empty-selection
   * no-op for the same reason: there's no meaningful box to compute). */
  zoomToFit(viewportSize: { w: number; h: number }): void;
  /** Fits the union of the currently-selected frames into the viewport, no
   * `targetZoom` clamp. No-op if `selectedIds` is empty — mirrors tldraw's
   * documented `zoomToSelection` behavior (`StudioCanvasHandle.
   * zoomToSelection`'s doc comment: "a no-op if nothing is selected"). */
  zoomToSelection(viewportSize: { w: number; h: number }): void;
  /** Replaces the current selection with exactly `ids` (unknown ids are
   * kept as-is — this store doesn't validate against `frames`, same
   * latitude `selection-store.ts`'s `setSelection` takes with uids). */
  select(ids: string[]): void;
  clearSelection(): void;
  /** Sub-workstream 2c (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — additive
   * action, does not alter any existing action's signature/behavior.
   * Replaces one frame's box (x/y/w/h) in place, keeping its `id` and
   * position in the map unchanged otherwise. Used by both drag-to-move
   * (only `x`/`y` actually change) and resize (all four fields may change)
   * to write LIVE geometry during an interactive gesture, and again with
   * the final box on gesture-end — `selection-gestures.ts`/
   * `resize-gestures.ts` are pure logic with zero store coupling, so
   * `Canvas.tsx` is the caller that turns their computed boxes into this
   * action. A no-op if `id` isn't a known frame (mirrors `select()`'s own
   * latitude above — this store never validates ids against anything
   * external). Immutable update (clones the map) so `useCameraStore((s) =>
   * s.frames)` subscribers (i.e. `Canvas.tsx`'s own render) see a new
   * reference and re-render with the live position, same reactivity
   * convention `setFrames` already establishes. */
  setFrameBox(id: string, box: Box): void;
}

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set();

export const useCameraStore = create<CameraStoreState>((set, get) => ({
  camera: { x: 0, y: 0, z: 1 },
  frames: new Map(),
  selectedIds: EMPTY_SELECTED_IDS as Set<string>,

  setFrames(frames) {
    const map = new Map<string, CameraFrame>();
    for (const frame of frames) map.set(frame.id, frame);
    set({ frames: map });
  },

  setCamera(camera) {
    set({ camera });
  },

  pan(dx, dy) {
    const { camera } = get();
    set({ camera: { x: camera.x + dx / camera.z, y: camera.y + dy / camera.z, z: camera.z } });
  },

  zoomAtPoint(newZoom, screenPoint) {
    const { camera } = get();
    const pagePoint = screenPointToPageSpace(camera, screenPoint);
    set({
      camera: {
        x: screenPoint.x / newZoom - pagePoint.x,
        y: screenPoint.y / newZoom - pagePoint.y,
        z: newZoom,
      },
    });
  },

  zoomIn(viewportSize) {
    const { camera, zoomAtPoint } = get();
    const center = { x: viewportSize.w / 2, y: viewportSize.h / 2 };
    zoomAtPoint(clampZoom(camera.z * ZOOM_STEP_FACTOR), center, viewportSize);
  },

  zoomOut(viewportSize) {
    const { camera, zoomAtPoint } = get();
    const center = { x: viewportSize.w / 2, y: viewportSize.h / 2 };
    zoomAtPoint(clampZoom(camera.z / ZOOM_STEP_FACTOR), center, viewportSize);
  },

  resetZoom(viewportSize) {
    const { zoomAtPoint } = get();
    const center = { x: viewportSize.w / 2, y: viewportSize.h / 2 };
    zoomAtPoint(1, center, viewportSize);
  },

  zoomToBounds(box, viewportSize, opts) {
    set({ camera: computeCameraToFitBounds(box, viewportSize, opts) });
  },

  zoomToFit(viewportSize) {
    const { frames, zoomToBounds } = get();
    const bounds = unionBoxes(Array.from(frames.values()));
    if (!bounds) return; // nothing to fit — leave the camera untouched.
    zoomToBounds(bounds, viewportSize);
  },

  zoomToSelection(viewportSize) {
    const { frames, selectedIds, zoomToBounds } = get();
    if (selectedIds.size === 0) return; // mirrors tldraw's documented no-op.
    const boxes: Box[] = [];
    for (const id of selectedIds) {
      const frame = frames.get(id);
      if (frame) boxes.push(frame);
    }
    const bounds = unionBoxes(boxes);
    if (!bounds) return; // selected ids don't (or no longer) resolve to any known frame.
    zoomToBounds(bounds, viewportSize);
  },

  select(ids) {
    set({ selectedIds: new Set(ids) });
  },

  clearSelection() {
    set({ selectedIds: EMPTY_SELECTED_IDS as Set<string> });
  },

  setFrameBox(id, box) {
    const { frames } = get();
    if (!frames.has(id)) return;
    const next = new Map(frames);
    next.set(id, { id, x: box.x, y: box.y, w: box.w, h: box.h });
    set({ frames: next });
  },
}));
