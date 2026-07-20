# Canvas Engine Replacement — Design Note (Phase 1 of the tldraw-removal/perf track)

_Orchestrator-authored 2026-07-20, no worker needed — pure scoping/design, reviewed before Phase 2 dispatch. Companion to `.orchestrator/STATE.md`'s "NEW TRACK" section._

## Why

Two independent drivers (see STATE.md's new-track entry for the full audit):
1. **Licensing cost, not performance.** tldraw ≥4.0 needs a $6,000/yr Business License to remove the "made with tldraw" watermark (ADR-0005, currently unresolved for public launch).
2. tldraw's actual API surface used here is narrow — camera pan/zoom, one custom box shape, marquee/click selection, resize handles. None of its vector/shape-library richness. The package already enforces a strict abstraction boundary (`packages/canvas`'s public `index.ts` leaks zero tldraw types — re-verified almost every audit pass), built specifically so this swap stays cheap (playbook §5.4, "own camera ≈ 2-4 weeks if ever needed").

## What's already engine-agnostic (verified by direct read, zero tldraw imports)

These pure modules need **no changes** — the new engine reuses them verbatim:

| Module | What it does |
|---|---|
| `geometry.ts` | `Box`/`Point`/`CameraState` types + iframe↔frame↔page↔screen space transforms (`pagePointToScreenSpace`, `screenViewportToPageBounds`, `boxesIntersect`, etc.). `CameraState` is tldraw's camera shape *reproduced structurally*, not imported. |
| `bridge-geometry.ts` | iframe-space ↔ screen-space for bridge rects (hover/selection overlays, hit-test). |
| `drag-geometry.ts` | Reorder drop-index + drop-indicator-line math for the FP-4b drag-to-move flow. |
| `wheel-gesture.ts` | `shiftPanDelta` — the shift+wheel horizontal-pan remap (already a hand-rolled workaround for a tldraw gap; the new engine owns *all* wheel handling with this same helper, not just a pre-emptive patch). |
| `viewport-cull.ts` | `selectLiveFrames`/`decideRenderMode` — the 8-live-iframe budget + zoom-threshold screenshot fallback. Takes a plain `Box` map + `CameraState`, returns a `Set<Id>`. Zero engine dependency already. |
| `selection-store.ts` | zustand store for edit-mode/hover/selection state. The one field that mentions tldraw (`EditModeFrameRef.shapeId`) is a doc-comment convention ("tldraw shape id"), not a type import — the new engine just needs a stable string id per frame, which it already has (`CanvasFrameRecord.id`). |

## What must be replaced (the actual tldraw surface, per the earlier audit)

| tldraw feature in use today | Where | Replacement |
|---|---|---|
| `<Tldraw>` root + internal reactive store | `StudioCanvas.tsx` | New `camera-store.ts` (zustand): `{ frames: Map<id, CanvasFrameRecord>, camera: {x,y,z}, selectedIds: Set<id> }` |
| `BaseBoxShapeUtil` subclass (`CcsFrameShapeUtil`) | `frame-shape.tsx` | Plain `FrameShape.tsx` React component, absolutely positioned via CSS inside a transformed container — no ShapeUtil lifecycle needed since we own mount/unmount directly |
| `editor.getCamera/zoomIn/zoomOut/resetZoom/zoomToFit/zoomToBounds/zoomToSelection` | `StudioCanvas.tsx` (`StudioCanvasHandle` impl) | Plain functions over the new camera store, using `geometry.ts` math (already have `screenViewportToPageBounds`; need to add `computeFitZoom(frames, viewportSize)` — new, small) |
| `useValue` (tldraw signal→React bridge) for zoom%, selection, culling | `StudioCanvas.tsx`, `frame-shape.tsx` | Plain zustand selectors (`useCameraStore((s) => ...)`) — zustand's own subscription model replaces `useValue` 1:1 |
| `useEditor()` | `frame-shape.tsx` | Not needed — `FrameShape.tsx` reads camera/selection straight from the zustand store via hooks |
| `createShapeId` + reverse-mapping hack | `StudioCanvas.tsx`, `edit-mode-layer.tsx` | Deleted — `CanvasFrameRecord.id` is already the real id; no wrapping/unwrapping needed once we're not going through tldraw's `shape:<id>` convention |
| `editor.select`/`getSelectedShapeIds` | `StudioCanvas.tsx` | Plain `selectedIds: Set<id>` mutation on the camera store |
| Marquee + click/shift-click selection | New — tldraw provided this natively | New `selection-gestures.ts`: pointer-down/move/up on the canvas container computing a rubber-band box, hit-testing against `frames` via `boxesIntersect` (already have this) |
| Resize handles + `resizeBox` | `frame-shape.tsx`'s `onResize` | New `resize-gestures.ts`: corner/edge handle components + drag math (straightforward — new frame box = original box adjusted by handle-specific delta, clamped to a min size) |
| `onDoubleClick` → edit mode | `frame-shape.tsx`'s `CcsFrameShapeUtil.onDoubleClick` | Plain `onDoubleClick` prop on `FrameShape.tsx`, calling `useSelectionStore.getState().enterEditMode(...)` — **unchanged call**, just moved from a ShapeUtil method to a component handler |
| `editor.sideEffects.registerAfterCreateHandler` (ADR-0015 phantom-frame guard) | `StudioCanvas.tsx` | **Deleted entirely.** This only existed because tldraw's native duplicate/copy/paste could create untracked shapes. Owning creation fully (frames only ever come from the `CanvasFrameRecord[]` sync effect) removes the whole bug class — there's no "native duplicate" to guard against anymore. |
| `TLUiOverrides.actions.duplicate` intercept | `StudioCanvas.tsx` | **Deleted** — same reasoning. Cmd/Ctrl+D duplicate becomes a plain keyboard handler calling the existing `duplicateFrame` daemon flow directly, no interception needed. |
| `editor.dispatch({type:'wheel',...})` (synthetic wheel event) | `StudioCanvas.tsx`'s shift+wheel fix | **Deleted as a workaround** — the new engine's own wheel handler applies `shiftPanDelta` directly to the camera store; there's no second (tldraw-owned) wheel handler to route around |
| `tldraw/tldraw.css` import | `WorkspaceShell.tsx` | Deleted |
| `MINIMAL_COMPONENTS`/`TLComponents` chrome suppression | `StudioCanvas.tsx` | N/A — we never had tldraw chrome to suppress; deleted with the rest |

`edit-mode-layer.tsx` also imports `createShapeId`/`useValue`/`Editor` (type only) — needs the same treatment: drop `createShapeId` (use `CanvasFrameRecord.id` directly), replace `useValue` with a zustand selector, drop the `Editor` type import (the new engine has no equivalent central object — pass the camera store's getters/setters directly where `Editor` was threaded through).

## Rendering approach: CSS-transform DOM camera

Every "shape" here is an iframe or a placeholder div — never a vector path. A single `transform: translate3d(x, y, 0) scale(z)` on one container div (GPU-composited) is the natural fit, cheaper than a canvas-drawn approach and requires zero new dependency. Frames are absolutely positioned children of that container, in page-space coordinates (matching what `viewport-cull.ts`/`geometry.ts` already assume).

## New module list (all inside `packages/canvas/src/`)

- `camera-store.ts` — zustand: camera `{x,y,z}`, `frames: Map<id, CanvasFrameRecord>`, `selectedIds: Set<id>`. Actions: `pan`, `zoomBy`, `zoomTo`, `setFrames`, `select`, `zoomToFit`, `zoomToBounds`, `zoomToSelection` (all plain math over `geometry.ts`).
- `camera-gestures.ts` — wheel (zoom-at-cursor via ctrl/meta, shift-pan via `shiftPanDelta`, plain-wheel vertical pan), space+drag pan, middle-drag pan, pinch/trackpad zoom.
- `selection-gestures.ts` — click, shift-click, marquee rubber-band, hit-testing via `boxesIntersect`.
- `resize-gestures.ts` — corner/edge drag handles, reusing `distance`/`DRAG_THRESHOLD_PX` from `drag-geometry.ts` for the click-vs-drag threshold.
- `FrameShape.tsx` (replaces `frame-shape.tsx`'s `CcsFrameShapeUtil`) — same render logic as today (iframe/placeholder/screenshot switch, `content-visibility`/`contain`, `pointer-events` toggle, `viewport-cull.ts` plugged in unchanged) as a plain component.
- `Canvas.tsx` (replaces the `<Tldraw>` mount in `StudioCanvas.tsx`) — container div, transform application, gesture wiring, `CanvasFrameRecord[] → camera-store` sync effect (same shape as today's `editor.createShape/updateShape/deleteShapes` sync effect, just against the new store).

`StudioCanvasHandle`'s public interface (`zoomIn/zoomOut/resetZoom/zoomToFit/zoomToSelection/createFrame/selectFrame/selectNode/zoomToNode/zoomToFrame/setFrameGeometry/requestComputedStyle`) **does not change** — `apps/studio` (`WorkspaceShell.tsx`, `Toolbar.tsx`, `ZoomWidget.tsx`) needs zero edits. This is the whole point of the existing §5.4 abstraction boundary.

## Rollout safety

Keep the tldraw-backed path alive behind `CCS_CANVAS_ENGINE=tldraw|custom` (env var, read once at `StudioCanvas.tsx`'s module scope) during the build. Default stays `tldraw` until Phase 3 parity-verification passes, then flips in Phase 4's cutover. This lets each Phase-2 sub-workstream ship independently without a big-bang risk, and lets us A/B the fps numbers directly against the current ~117fps baseline once the harness's zoomToFit/viewport-cull e2e bug (found in Phase 0, see STATE.md) is also fixed here.

## Phase 2 sub-workstream split (sequential, one Sonnet 5 worker at a time per this track's standing rules)

1. **2a — camera store + gesture handlers.** Pure logic + unit tests (mirroring `viewport-cull.test.ts`'s style — no rendering, no DOM). Deliverable: `camera-store.ts`, `camera-gestures.ts`, unit tests. No wiring into `StudioCanvas.tsx` yet.
2. **2b — FrameShape + Canvas.tsx rendering**, behind the `CCS_CANVAS_ENGINE` flag, wired into a throwaway dev harness page first (not yet swapped into `StudioCanvas.tsx` itself) so it's checkable in isolation.
3. **2c — selection (marquee/click/shift-click) + resize handles.**
4. **2d — `StudioCanvasHandle` rewiring**: swap `StudioCanvas.tsx`'s internals to the new engine when the flag is set to `custom`, preserving the exact public interface. Also fixes the Phase-0-discovered zoomToFit/viewport-cull e2e bug as part of this rewiring (same code being touched anyway).

Each sub-workstream gets its own git-reconcile + orchestrator verification before the next is dispatched, same discipline as Phase 0.
