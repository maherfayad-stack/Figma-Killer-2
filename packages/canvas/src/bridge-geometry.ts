import type { Rect as BridgeRect } from '@ccs/bridge';
import {
  FRAME_CHROME_HEADER_HEIGHT,
  pagePointToFrameSpace,
  pagePointToScreenSpace,
  screenPointToPageSpace,
  type Box,
  type CameraState,
  type Point,
} from './geometry.js';

/**
 * Pure iframe-space <-> screen-space transform (playbook §4/P2 pitfall:
 * "Rect coordinates: iframe -> frame-shape space -> canvas space; test at
 * multiple zooms"). Bridge rects/hit-test coordinates are always iframe
 * CSS-pixel space (ADR-0016, `@ccs/bridge`'s `protocol.ts`); this module is
 * the ONE place that composes `geometry.ts`'s generic Box/Point/camera math
 * with the bridge's `{x,y,width,height}` `Rect` shape (deliberately kept
 * out of `geometry.ts` itself, which has zero knowledge of `@ccs/bridge` —
 * see that module's own doc comment: "P2's bridge/overlay work ... has one
 * place to change").
 *
 * No tldraw types anywhere here (§5.4) — `CameraState`/`Box`/`Point` are
 * `geometry.ts`'s plain structural shapes; callers pass tldraw's
 * `editor.getCamera()` result in structurally (it satisfies `CameraState`).
 */

export function bridgeRectToBox(rect: BridgeRect): Box {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

export function boxToBridgeRect(box: Box): BridgeRect {
  return { x: box.x, y: box.y, width: box.w, height: box.h };
}

/** Bridge-reported iframe-space rect -> canvas/page space, given the owning
 * frame's box (the `CanvasFrameRecord`/tldraw-shape's x/y/w/h, already in
 * page space per `geometry.ts`). Accounts for the frame chrome header strip
 * the iframe is vertically offset by (`FRAME_CHROME_HEADER_HEIGHT`). */
export function iframeRectToPageBox(rect: BridgeRect, frameBox: Box): Box {
  const local = bridgeRectToBox(rect);
  return {
    x: frameBox.x + local.x,
    y: frameBox.y + FRAME_CHROME_HEADER_HEIGHT + local.y,
    w: local.w,
    h: local.h,
  };
}

/** Bridge-reported iframe-space rect -> screen space (applies the tldraw
 * camera's pan+zoom transform, `geometry.ts`'s `pagePointToScreenSpace`
 * convention: `screen = (page + camera) * zoom`). This is the function the
 * overlay renders hover/selection boxes with — MUST be correct at any zoom
 * level (verified by this module's unit tests at multiple zooms, not just
 * z=1). */
export function iframeRectToScreenBox(camera: CameraState, frameBox: Box, rect: BridgeRect): Box {
  const page = iframeRectToPageBox(rect, frameBox);
  const topLeft = pagePointToScreenSpace(camera, { x: page.x, y: page.y });
  return { x: topLeft.x, y: topLeft.y, w: page.w * camera.z, h: page.h * camera.z };
}

/** Screen-space point (a mouse event's coordinates, already relative to the
 * tldraw container's own top-left origin — see `edit-mode-layer.tsx`) -> the
 * iframe-space point to send in a `hit-test` request. Exact inverse of
 * `iframeRectToScreenBox`'s point half (verified by round-trip tests). */
export function screenPointToIframePoint(camera: CameraState, frameBox: Box, point: Point): Point {
  const page = screenPointToPageSpace(camera, point);
  const frameLocal = pagePointToFrameSpace(frameBox, page);
  return { x: frameLocal.x, y: frameLocal.y - FRAME_CHROME_HEADER_HEIGHT };
}
