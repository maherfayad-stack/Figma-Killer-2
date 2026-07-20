import * as React from 'react';
import { TldrawEngineCanvas } from './TldrawEngineCanvas.js';
import { CustomEngineCanvas } from './CustomEngineCanvas.js';
import type { StudioCanvasProps } from './studio-canvas-types.js';

/**
 * `StudioCanvas` — the package's public entry point (playbook §4/P1). All
 * engine specifics live behind THIS thin dispatcher: callers only ever see
 * `CanvasFrameRecord`-shaped data and the `CreateFrameFn` contract, never
 * an engine-specific type (playbook §5.4).
 *
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`): this file
 * used to BE the whole implementation (a ~1450-line component mixing
 * daemon/protocol wiring with the `<Tldraw>` mount). It's now split into:
 *  - `use-studio-canvas-daemon.ts` — the engine-agnostic daemon/`frames`/
 *    create-frame/duplicate-frame/setFrameGeometry/requestComputedStyle
 *    hook both engines below call.
 *  - `TldrawEngineCanvas.tsx` — the tldraw-backed path (today's real
 *    `apps/studio` behavior), a mechanical extraction of what used to live
 *    directly in this file's function body — BEHAVIOR UNCHANGED.
 *  - `CustomEngineCanvas.tsx` — the new tldraw-free assembly (`Canvas.tsx`
 *    + `camera-store.ts` + `selection-gestures.ts` + `resize-gestures.ts` +
 *    `frame-geometry-commit.ts` + a custom-engine `EditModeLayer` adapter),
 *    producing the identical `StudioCanvasHandle` surface.
 *  - `studio-canvas-types.ts` — the shared public contract
 *    (`StudioCanvasProps`/`StudioCanvasHandle`/etc.) both of the above (and
 *    this dispatcher) import, avoiding a three-way circular import.
 *
 * This component itself is now JUST the `CCS_CANVAS_ENGINE=tldraw|custom`
 * switch (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s "Rollout safety"
 * section) — read ONCE at module scope via Vite's `import.meta.env.
 * VITE_CCS_CANVAS_ENGINE` convention (the same convention every other Vite
 * consumer in this monorepo uses for build-time env vars), defaulting to
 * `'tldraw'` for anything other than the literal string `'custom'`
 * (unset, misspelled, or any other value — fail SAFE to the
 * production-proven path, never silently to the new one). `apps/studio`
 * never sets this var today, so its behavior is provably unchanged by this
 * split: `StudioCanvas`'s own props/exported type/import path are all
 * identical to before this sub-workstream.
 */
const rawCanvasEngine = import.meta.env.VITE_CCS_CANVAS_ENGINE as string | undefined;
const CCS_CANVAS_ENGINE: 'tldraw' | 'custom' = rawCanvasEngine === 'custom' ? 'custom' : 'tldraw';

export function StudioCanvas(props: StudioCanvasProps): React.ReactElement {
  return CCS_CANVAS_ENGINE === 'custom' ? <CustomEngineCanvas {...props} /> : <TldrawEngineCanvas {...props} />;
}

// Re-exported so `index.ts` (unchanged) keeps working exactly as before —
// every one of these types used to be DECLARED in this file; they now live
// in `studio-canvas-types.ts` (the shared contract both engines build
// against) but are re-exported here so `import type {...} from
// './StudioCanvas.js'` at `index.ts`'s own import site needs zero edits.
export type {
  StudioCanvasProps,
  StudioCanvasHandle,
  CreateFrameFn,
  CreateFrameRequest,
  DuplicateFrameFn,
  DuplicateFrameRequest,
  SelectNodeRequest,
  ElementSelection,
} from './studio-canvas-types.js';
