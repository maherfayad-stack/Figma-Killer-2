import { boxesIntersect, screenViewportToPageBounds, type Box, type CameraState } from './geometry.js';

/**
 * Perf gate (playbook §4/P1 Perf requirements, built in now not later):
 * frames outside the viewport get their `<iframe>` unmounted and replaced
 * by a cached screenshot; zoom below a threshold forces screenshots
 * unconditionally regardless of visibility. Pure decision function — no
 * DOM, no tldraw — so it's unit-testable and reusable if the §5.4
 * custom-camera fallback ever needs the same policy.
 *
 * Two entry points share one core (`decideRenderMode`):
 *  - `decideRenderMode` takes an already-computed page-space viewport
 *    rect + zoom directly — this is what `FrameShapeUtil.component` calls
 *    at runtime, using tldraw's own `editor.getViewportPageBounds()` /
 *    `editor.getZoomLevel()` (no need to re-derive page bounds from a
 *    camera struct when tldraw already computed them).
 *  - `computeFrameRenderMode` / `computeRenderModes` take a raw camera +
 *    screen size and derive the page bounds themselves via
 *    `screenViewportToPageBounds` — used by tests and by any future
 *    custom-camera fallback (§5.4) that has a camera but no tldraw
 *    `Editor` to ask.
 */

export type FrameRenderMode = 'live' | 'screenshot';

export interface ViewportCullOptions {
  /** Below this zoom level, every frame renders as a screenshot
   * regardless of visibility (playbook §4/P1: "Zoom < 30% → screenshots
   * only"). Default 0.3. */
  zoomScreenshotThreshold?: number;
  /** Extra page-space margin added around the viewport bounds before the
   * intersection test, so frames just outside the visible edge stay
   * mounted (avoids iframe mount/unmount thrashing during a slow pan).
   * Default 0 — callers needing hysteresis pass a positive margin. */
  cullMarginPage?: number;
}

const DEFAULT_ZOOM_SCREENSHOT_THRESHOLD = 0.3;

function expandBox(box: Box, margin: number): Box {
  if (margin === 0) return box;
  return { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 };
}

/** Core decision: given an already-known page-space viewport rect + zoom
 * level, decide one frame's render mode. */
export function decideRenderMode(
  viewportPageBounds: Box,
  zoom: number,
  frameBox: Box,
  options: ViewportCullOptions = {},
): FrameRenderMode {
  const zoomThreshold = options.zoomScreenshotThreshold ?? DEFAULT_ZOOM_SCREENSHOT_THRESHOLD;
  if (zoom < zoomThreshold) return 'screenshot';
  const expanded = expandBox(viewportPageBounds, options.cullMarginPage ?? 0);
  return boxesIntersect(expanded, frameBox) ? 'live' : 'screenshot';
}

/** Decide one frame's render mode given a raw camera + screen viewport
 * size (derives page bounds via `screenViewportToPageBounds`). */
export function computeFrameRenderMode(
  camera: CameraState,
  viewportScreenSize: { w: number; h: number },
  frameBox: Box,
  options: ViewportCullOptions = {},
): FrameRenderMode {
  return decideRenderMode(screenViewportToPageBounds(camera, viewportScreenSize), camera.z, frameBox, options);
}

/** Batch form — decides every frame's mode in one viewport-bounds
 * computation (avoids recomputing `screenViewportToPageBounds` per frame
 * when checking many frames, relevant at the 20-frame perf target). */
export function computeRenderModes<Id extends string>(
  camera: CameraState,
  viewportScreenSize: { w: number; h: number },
  frames: ReadonlyMap<Id, Box>,
  options: ViewportCullOptions = {},
): Map<Id, FrameRenderMode> {
  const viewportPageBounds = screenViewportToPageBounds(camera, viewportScreenSize);
  const result = new Map<Id, FrameRenderMode>();
  for (const [id, box] of frames) {
    result.set(id, decideRenderMode(viewportPageBounds, camera.z, box, options));
  }
  return result;
}
