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
export type {
  StudioCanvasProps,
  StudioCanvasHandle,
  CreateFrameFn,
  CreateFrameRequest,
  DuplicateFrameFn,
  DuplicateFrameRequest,
  SelectNodeRequest,
  ElementSelection,
} from './StudioCanvas.js';
// FP-4a: `CommitTextRequest` is defined in `edit-mode-layer.ts` (not
// `StudioCanvas.ts`) since that's the module that actually produces it —
// re-exported here so callers of `StudioCanvasProps.onCommitText` (an
// `EditModeLayer`-sourced type re-used verbatim by `StudioCanvas`) get it
// from this package's one public entry point, same as everything else.
export type { CommitTextRequest } from './edit-mode-layer.js';
// FP-4b (D-EDIT context-aware drag-to-move) — same pattern as
// `CommitTextRequest` above: defined in `edit-mode-layer.ts`, re-exported
// here for `StudioCanvasProps.onReorderNode`/`.onCommitFreeDrag` callers.
export type { ReorderNodeRequest, CommitFreeDragRequest } from './edit-mode-layer.js';

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
