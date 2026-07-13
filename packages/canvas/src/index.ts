/**
 * packages/canvas — public API (playbook §4/P1, §5.4 abstraction).
 *
 * Everything tldraw-specific (`BaseBoxShapeUtil`, `TLBaseShape`, the
 * `Editor` type, etc.) is confined to `frame-shape.tsx`/`StudioCanvas.tsx`
 * and never re-exported here. A caller of this package only ever sees
 * `StudioCanvas`, `CanvasFrameRecord`, and `CreateFrameFn` — plain,
 * tldraw-independent shapes — so a future custom-camera fallback
 * (playbook §5.4) could replace the internals without touching call
 * sites.
 */

export const CANVAS_PACKAGE_PHASE = 'P1' as const;

export { StudioCanvas } from './StudioCanvas.js';
export type { StudioCanvasProps, CreateFrameFn, CreateFrameRequest } from './StudioCanvas.js';

export type { CanvasFrameRecord } from './project-wiring.js';
export type { Box, CameraState, Point } from './geometry.js';
export type { FrameRenderMode } from './viewport-cull.js';

// New-frame tool builders (playbook §4/P1 step 4) — pure, IO-free, reused
// by both a future daemon-backed `onCreateFrame` and any dev-harness /
// tooling that needs to construct the same three artifacts (source,
// registry patch, canvas.json entry) without pulling in React/tldraw.
export {
  buildFrameSource,
  buildNewCanvasJsonEntry,
  frameSourcePath,
  isValidFrameName,
  patchFramesRegistry,
} from './new-frame.js';
