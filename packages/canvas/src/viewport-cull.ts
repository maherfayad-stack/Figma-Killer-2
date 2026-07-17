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

/**
 * FIX 6 (AUDIT-FIXW1 blocker remediation) — the PERF-SAFE, cross-origin-
 * honest live-set selector. `decideRenderMode` above (unchanged, still
 * frozen + tested) makes an independent per-frame yes/no call, which — with
 * the widened thresholds the first FIX 6 attempt used, and no working
 * cross-origin screenshot to fall back to — let an unbounded number of
 * frames render live at once (breaking the 20-frame 60fps gate). This
 * function instead makes ONE decision over ALL frames and hands back the
 * bounded set that may be live: at most `maxLive` frames, chosen as the ones
 * NEAREST the viewport CENTER among those intersecting the (optionally
 * margin-expanded) viewport. Everything else renders a lightweight labeled
 * placeholder (see `frame-shape.tsx`), never a live iframe.
 *
 * Why center-distance (not just "intersects viewport"): when the camera is
 * zoomed out far enough that MORE than `maxLive` frames are visible at once,
 * we must still pick a bounded subset — the ones under the cursor/centre are
 * the ones a user is most likely looking at, so they win the live budget.
 *
 * `alwaysLive` (the single FP-INS-b edit-mode frame) is forced into the set
 * and COUNTS toward `maxLive`, so the total live iframe count is hard-capped
 * at `maxLive` no matter what — that cap is what keeps the perf gate green.
 *
 * NOTE: real screenshots for the culled frames are a SEPARATE follow-up
 * workstream (bridge-side rasterization, which also delivers FP-6 export) —
 * a cross-origin `iframe.contentDocument` read (`screenshot-capture.ts`)
 * is always `null` between the studio origin and a frame's dev-server
 * origin, so no screenshot can be produced here today. Until then the
 * non-live frames show the labeled placeholder.
 */
export const DEFAULT_MAX_LIVE_FRAMES = 8;

export interface SelectLiveFramesOptions<Id> {
  /** Hard cap on simultaneously-live frames (default
   * {@link DEFAULT_MAX_LIVE_FRAMES}). `alwaysLive` counts toward it. */
  maxLive?: number;
  /** The one frame that must always be live regardless of viewport/cap
   * (the FP-INS-b edit-mode frame). Included even if it doesn't intersect
   * the viewport; still counts toward `maxLive`. */
  alwaysLive?: Id | null;
  /** Page-space margin added around the viewport before the intersection
   * test, so a frame just past the edge can still be a live candidate
   * (smooth panning). Default 0. */
  cullMarginPage?: number;
}

export function selectLiveFrames<Id>(
  viewportPageBounds: Box,
  frames: ReadonlyMap<Id, Box>,
  options: SelectLiveFramesOptions<Id> = {},
): Set<Id> {
  const maxLive = options.maxLive ?? DEFAULT_MAX_LIVE_FRAMES;
  const alwaysLive = options.alwaysLive ?? null;
  const expanded = expandBox(viewportPageBounds, options.cullMarginPage ?? 0);
  const centerX = viewportPageBounds.x + viewportPageBounds.w / 2;
  const centerY = viewportPageBounds.y + viewportPageBounds.h / 2;

  const live = new Set<Id>();
  let budget = maxLive;
  if (alwaysLive !== null && frames.has(alwaysLive)) {
    live.add(alwaysLive);
    budget -= 1;
  }
  if (budget <= 0) return live;

  const candidates: { id: Id; dist: number }[] = [];
  for (const [id, box] of frames) {
    if (id === alwaysLive) continue; // already counted
    if (!boxesIntersect(expanded, box)) continue;
    const fx = box.x + box.w / 2;
    const fy = box.y + box.h / 2;
    // Squared distance — monotonic, avoids a sqrt per frame.
    candidates.push({ id, dist: (fx - centerX) ** 2 + (fy - centerY) ** 2 });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const { id } of candidates) {
    if (budget <= 0) break;
    live.add(id);
    budget -= 1;
  }
  return live;
}
