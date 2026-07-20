import type { Box, Point } from './geometry.js';

/**
 * Sub-workstream 2c (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2
 * split) — corner/edge resize-handle math, replacing tldraw's
 * `BaseBoxShapeUtil.canResize`/`onResize` (`resizeBox`) +
 * `onResizeEnd`. PURE LOGIC ONLY (`computeResizedBox` takes/returns plain
 * `Box`es, zero DOM), same "pure factory + injected callbacks" shape as
 * `camera-gestures.ts`'s `createPanDragController` for the stateful part.
 *
 * ## Handle set
 * The full Figma/tldraw-standard set of 8: four corners (diagonal resize,
 * both axes) + four edge midpoints (single-axis resize) — the task brief
 * allows a corner-only 4-handle simplification, but the edge handles add
 * negligible extra math (`computeResizedBox` already treats "corner" and
 * "edge" uniformly via which edges a handle "touches") so all 8 are
 * implemented; no simplification taken here.
 *
 * ## Minimum size
 * `MIN_FRAME_SIZE = 40` (page-space px) — a frame can never be resized
 * below 40x40. Not discoverable from this repo (tldraw's own shape min-size
 * isn't a value read anywhere in this codebase); a disclosed, reasonable
 * choice matching this sub-workstream's brief ("e.g. 40x40px — pick
 * something reasonable, document it"). FLAG for a later parity-verification
 * pass, same category as `camera-store.ts`'s `ZOOM_STEP_FACTOR`/`MIN_ZOOM`.
 */

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** All 8 handles, in a stable clockwise-from-top-left order — convenient
 * for callers rendering one element per handle. */
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const MIN_FRAME_SIZE = 40;

const TOUCHES_WEST: ReadonlySet<ResizeHandle> = new Set(['nw', 'w', 'sw']);
const TOUCHES_EAST: ReadonlySet<ResizeHandle> = new Set(['ne', 'e', 'se']);
const TOUCHES_NORTH: ReadonlySet<ResizeHandle> = new Set(['nw', 'n', 'ne']);
const TOUCHES_SOUTH: ReadonlySet<ResizeHandle> = new Set(['sw', 's', 'se']);

/**
 * Standard rectangle-resize-from-handle math: dragging `handle` moves the
 * edge(s) it controls by `pointerPageDelta` (the pointer's page-space
 * displacement since the drag started), keeping every edge the handle does
 * NOT touch exactly fixed — e.g. `'se'` moves the right and bottom edges,
 * leaving the top-left corner fixed; `'n'` moves only the top edge, leaving
 * left/right/bottom fixed.
 *
 * Enforces `minSize` by pulling the MOVING edge back toward its fixed
 * opposite (never moves an edge the handle doesn't control) so the box can
 * never collapse to zero/negative size — e.g. dragging `'se'` far up-left
 * clamps the bottom-right corner so width/height never drop below
 * `minSize`, with the top-left corner staying exactly where it started.
 */
export function computeResizedBox(
  originalBox: Box,
  handle: ResizeHandle,
  pointerPageDelta: Point,
  minSize: number = MIN_FRAME_SIZE,
): Box {
  const touchesWest = TOUCHES_WEST.has(handle);
  const touchesEast = TOUCHES_EAST.has(handle);
  const touchesNorth = TOUCHES_NORTH.has(handle);
  const touchesSouth = TOUCHES_SOUTH.has(handle);

  let left = originalBox.x;
  let top = originalBox.y;
  let right = originalBox.x + originalBox.w;
  let bottom = originalBox.y + originalBox.h;

  if (touchesWest) left += pointerPageDelta.x;
  if (touchesEast) right += pointerPageDelta.x;
  if (touchesNorth) top += pointerPageDelta.y;
  if (touchesSouth) bottom += pointerPageDelta.y;

  if (right - left < minSize) {
    if (touchesWest) left = right - minSize;
    else if (touchesEast) right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (touchesNorth) top = bottom - minSize;
    else if (touchesSouth) bottom = top + minSize;
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The screen-space point a resize-handle overlay element should be
 * centered on, given the SELECTED frame's box already converted to screen
 * space (`geometry.ts`'s `boxToScreenBox(camera, frameBox)`) — corners sit
 * exactly on the box's corners, edge handles sit at each edge's midpoint.
 * Pure arithmetic, kept here (not duplicated at each call site) so
 * `Canvas.tsx`'s handle-rendering loop and any future overlay component
 * share one implementation. */
export function resizeHandleScreenPoint(screenBox: Box, handle: ResizeHandle): Point {
  const cx = screenBox.x + screenBox.w / 2;
  const cy = screenBox.y + screenBox.h / 2;
  const left = screenBox.x;
  const top = screenBox.y;
  const right = screenBox.x + screenBox.w;
  const bottom = screenBox.y + screenBox.h;
  switch (handle) {
    case 'nw':
      return { x: left, y: top };
    case 'n':
      return { x: cx, y: top };
    case 'ne':
      return { x: right, y: top };
    case 'e':
      return { x: right, y: cy };
    case 'se':
      return { x: right, y: bottom };
    case 's':
      return { x: cx, y: bottom };
    case 'sw':
      return { x: left, y: bottom };
    case 'w':
      return { x: left, y: cy };
  }
}

/** CSS `cursor` value conventionally used for each handle's drag direction
 * (diagonal corners use `nwse-resize`/`nesw-resize`, edges use
 * `ns-resize`/`ew-resize`) — a small, purely-presentational helper so
 * `Canvas.tsx`'s handle overlay doesn't need its own switch statement. */
export function resizeHandleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
  }
}

// --- stateful drag controller ------------------------------------------

export interface ResizeGestureOptions {
  /** Called with the LIVE resized box on every pointer-move while a resize
   * is active — the caller passes this straight to `camera-store.ts`'s
   * `setFrameBox(frameId, box)`. */
  onResize: (frameId: string, box: Box) => void;
  /** Called once, on pointer-up, with the FINAL resized box — the caller
   * both commits it (`setFrameBox`) and fires the geometry-commit pub-sub
   * (`frame-geometry-commit.ts`'s `emitFrameGeometryCommitted`), mirroring
   * `frame-shape.tsx`'s `onResizeEnd` firing the identical event a
   * translate-end fires (a resize is just another "box changed" event). */
  onResizeEnd: (frameId: string, box: Box) => void;
  minSize?: number;
}

export interface ResizeGestureController {
  /** Starts a resize drag: `originalBox` is the frame's box AT THE MOMENT
   * the drag starts (captured once, never re-read — every subsequent
   * `computeResizedBox` call is relative to this fixed original, matching
   * `computeResizedBox`'s own "keep the opposite edge fixed" contract),
   * `startPagePoint` is the pointer's page-space position at that same
   * moment. */
  startResize(frameId: string, handle: ResizeHandle, originalBox: Box, startPagePoint: Point, pointerId: number): void;
  onPointerMove(pointerId: number, pagePoint: Point): void;
  onPointerUp(pointerId: number, pagePoint: Point): void;
  isResizing(): boolean;
}

interface ActiveResize {
  pointerId: number;
  frameId: string;
  handle: ResizeHandle;
  originalBox: Box;
  startPagePoint: Point;
}

export function createResizeGestureController(options: ResizeGestureOptions): ResizeGestureController {
  let active: ActiveResize | null = null;

  function startResize(
    frameId: string,
    handle: ResizeHandle,
    originalBox: Box,
    startPagePoint: Point,
    pointerId: number,
  ): void {
    active = { pointerId, frameId, handle, originalBox, startPagePoint };
  }

  function computeCurrent(pagePoint: Point): Box {
    // `active` is guaranteed non-null by both call sites below (checked
    // immediately before calling this).
    const a = active!;
    const delta: Point = { x: pagePoint.x - a.startPagePoint.x, y: pagePoint.y - a.startPagePoint.y };
    return computeResizedBox(a.originalBox, a.handle, delta, options.minSize);
  }

  function onPointerMove(pointerId: number, pagePoint: Point): void {
    if (!active || pointerId !== active.pointerId) return;
    options.onResize(active.frameId, computeCurrent(pagePoint));
  }

  function onPointerUp(pointerId: number, pagePoint: Point): void {
    if (!active || pointerId !== active.pointerId) return;
    options.onResizeEnd(active.frameId, computeCurrent(pagePoint));
    active = null;
  }

  function isResizing(): boolean {
    return active !== null;
  }

  return { startResize, onPointerMove, onPointerUp, isResizing };
}
