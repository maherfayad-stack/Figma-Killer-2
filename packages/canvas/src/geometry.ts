import type { FrameEntry } from '@ccs/protocol';

/**
 * Pure geometry mapping: iframe space ↔ frame space ↔ canvas (page) space
 * ↔ screen space. Deliberately independent of tldraw's own `Mat`/`Vec`
 * classes (playbook §5.4 — the canvas package must not leak tldraw types,
 * and a future custom-camera fallback needs its own math anyway). tldraw's
 * `FrameShapeUtil` component converts to/from these plain-object shapes at
 * the boundary.
 *
 * Space definitions:
 *  - **iframe space**: pixels inside the frame's `<iframe>` document. In
 *    P1 the iframe is sized to exactly the frame's `w`×`h` with no internal
 *    CSS scaling, so iframe space and frame space are identical (identity
 *    mapping) — kept as an explicit named function anyway so P2's bridge/
 *    overlay work (which DOES need this seam once hit-test rects flow
 *    through it) has one place to change if that ever stops being true.
 *  - **frame space**: local coordinates within one frame's box, origin at
 *    the frame's top-left, `[0, w] x [0, h]`.
 *  - **canvas (page) space**: the infinite-canvas coordinate system that
 *    `.studio/canvas.json` (`FrameEntry.x/y/w/h`) and the tldraw `FrameShape`
 *    (`shape.x/y`, `shape.props.w/h`) both live in.
 *  - **screen space**: CSS pixels in the browser viewport, after applying
 *    the camera (pan `cx,cy` + zoom `z`).
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Height (px) of the frame chrome header strip a live frame's `<iframe>`
 * is offset by within its `ccs-frame` shape's local space (playbook §4/P2
 * — `frame-shape.tsx` renders this header above the iframe). Lives here
 * (not just in `frame-shape.tsx`) so the pure iframe<->frame/page/screen
 * transform helpers below (consumed by `bridge-geometry.ts`) don't need a
 * tldraw-shape import to account for it, and so `frame-shape.tsx` has a
 * single source of truth instead of a second hard-coded `24`. */
export const FRAME_CHROME_HEADER_HEIGHT = 24;

export interface Point {
  x: number;
  y: number;
}

/** tldraw's camera shape, reproduced structurally (not imported) so this
 * module has zero tldraw dependency — see module doc. */
export interface CameraState {
  x: number;
  y: number;
  z: number;
}

/** iframe space → frame space: identity in P1 (see module doc). */
export function iframePointToFrameSpace(point: Point): Point {
  return { x: point.x, y: point.y };
}

/** frame space → iframe space: identity in P1 (see module doc). */
export function framePointToIframeSpace(point: Point): Point {
  return { x: point.x, y: point.y };
}

/** frame-local point → canvas/page space, given the frame's box. */
export function framePointToPageSpace(frameBox: Box, point: Point): Point {
  return { x: frameBox.x + point.x, y: frameBox.y + point.y };
}

/** canvas/page-space point → frame-local space, given the frame's box. */
export function pagePointToFrameSpace(frameBox: Box, point: Point): Point {
  return { x: point.x - frameBox.x, y: point.y - frameBox.y };
}

/** canvas/page space → screen space, applying the camera transform.
 * Matches tldraw's convention: `screen = (page + camera) * zoom` (tldraw
 * stores the camera translation pre-zoom-division; see
 * `Editor.getViewportPageBounds` for the inverse this mirrors). */
export function pagePointToScreenSpace(camera: CameraState, point: Point): Point {
  return { x: (point.x + camera.x) * camera.z, y: (point.y + camera.y) * camera.z };
}

/** screen space → canvas/page space, applying the inverse camera transform. */
export function screenPointToPageSpace(camera: CameraState, point: Point): Point {
  return { x: point.x / camera.z - camera.x, y: point.y / camera.z - camera.y };
}

/** Page-space box (e.g. a frame's own `x/y/w/h`) -> screen space, applying
 * the camera transform (same convention as `pagePointToScreenSpace`).
 * FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4): used to size the
 * edit-mode capture overlay to exactly the ACTIVE frame's on-screen bounds
 * (rather than the whole canvas container) so clicking a DIFFERENT frame —
 * or empty canvas outside any frame — reaches tldraw's own shape hit-
 * testing/selection underneath instead of being swallowed by the overlay
 * (see `edit-mode-layer.tsx`'s module doc for why this matters for
 * frictionless multi-frame select). */
export function boxToScreenBox(camera: CameraState, box: Box): Box {
  const topLeft = pagePointToScreenSpace(camera, { x: box.x, y: box.y });
  return { x: topLeft.x, y: topLeft.y, w: box.w * camera.z, h: box.h * camera.z };
}

/** The page-space rectangle currently visible on screen, given the camera
 * and the viewport's screen-space size (used by viewport culling). */
export function screenViewportToPageBounds(camera: CameraState, screenSize: { w: number; h: number }): Box {
  const topLeft = screenPointToPageSpace(camera, { x: 0, y: 0 });
  const bottomRight = screenPointToPageSpace(camera, { x: screenSize.w, y: screenSize.h });
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: bottomRight.x - topLeft.x,
    h: bottomRight.y - topLeft.y,
  };
}

/** Axis-aligned rectangle intersection test, page or screen space (unit-
 * agnostic — both boxes must share the same space). */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** `.studio/canvas.json` `FrameEntry` → the plain `Box` this module deals
 * in (drops `framePath`; symmetric with {@link boxToFrameEntry}). */
export function frameEntryToBox(entry: FrameEntry): Box {
  return { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
}

/** Plain `Box` → a `.studio/canvas.json` `FrameEntry`, re-attaching the
 * file-folder-relative `framePath`. */
export function boxToFrameEntry(framePath: string, box: Box): FrameEntry {
  return { framePath, x: box.x, y: box.y, w: box.w, h: box.h };
}

/** Structural equality for two boxes (used to skip redundant writes/state
 * updates when a re-sync produces the same geometry). */
export function boxesEqual(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
