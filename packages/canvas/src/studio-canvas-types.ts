import type * as React from 'react';
import type { ComputedStyleResult } from '@ccs/bridge';
import type { CanvasFrameRecord } from './project-wiring.js';
import type { CommitFreeDragRequest, CommitTextRequest, ReorderNodeRequest } from './edit-mode-layer.js';
import type { Box } from './geometry.js';

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — the
 * public contract shared by BOTH `TldrawEngineCanvas` and
 * `CustomEngineCanvas` (and the thin `StudioCanvas` dispatcher that renders
 * one of them). Split out of `StudioCanvas.tsx` into its own module so
 * neither engine implementation needs to import the OTHER engine's file (or
 * the dispatcher) just to see these shapes — avoids a three-way circular
 * import between `StudioCanvas.tsx` / `TldrawEngineCanvas.tsx` /
 * `CustomEngineCanvas.tsx`.
 *
 * NONE of these types/values change as part of this sub-workstream — this
 * is a verbatim relocation of what `StudioCanvas.tsx` already declared, so
 * `apps/studio` (which imports `StudioCanvas`/`StudioCanvasHandle` from
 * `@ccs/canvas`'s `index.ts`, which itself re-exports from
 * `StudioCanvas.js`) sees zero change to either the import path or the
 * type shapes.
 */

export interface CreateFrameRequest {
  fileFolder: string;
  name: string;
}

/**
 * Creates a new frame (`.tsx` + `src/frames.ts` registry entry +
 * `.studio/canvas.json` entry — playbook §4/P1 step 4). The default
 * implementation (`useStudioCanvasDaemon`'s `defaultCreateFrame`) sends a
 * `{kind:'create-frame', ...}` request over the real control-ws connection
 * (ADR-0014) and resolves once the resulting `file-changed` broadcast(s)
 * land the new frame in `frames` state, or rejects on a `control-error`
 * reply. Callers may still supply their own `onCreateFrame` (e.g. a
 * fs-backed test double, or a dev harness that wants to bypass the socket)
 * — it fully replaces the default, it does not layer on top of it.
 */
export type CreateFrameFn = (request: CreateFrameRequest) => Promise<void>;

export interface DuplicateFrameRequest {
  fileFolder: string;
  /** Filename (without extension) of the existing frame to duplicate — the
   * daemon reads its source, copies it to a uniquely-named new frame file,
   * patches the registry, and appends an offset `.studio/canvas.json`
   * entry (ADR-0015 — see `duplicate-frame.ts` in `packages/sync-daemon`
   * for the full three-artifact write). */
  sourceName: string;
}

/**
 * Duplicates an existing frame (ADR-0015 — the P1 defect fix: tldraw's
 * built-in duplicate/copy/paste created fileless "phantom" `ccs-frame`
 * shapes the reaper then deleted on the next sync — a tldraw-path-specific
 * bug this type's own doc still references since it's the historical reason
 * this method exists at all; the custom engine never had that bug class in
 * the first place, see `CustomEngineCanvas.tsx`'s own doc). The default
 * implementation (`useStudioCanvasDaemon`'s `defaultDuplicateFrame`) sends
 * a `{kind:'duplicate-frame', ...}` request over the real control-ws
 * connection and resolves once the dedicated `duplicate-frame-result`
 * reply lands (unlike `CreateFrameFn`, success here is NOT observed via
 * `frames` state — the caller doesn't know the daemon-picked `newName` in
 * advance), or rejects on a `control-error` reply. Callers may still
 * supply their own `onDuplicateFrame` (e.g. a test double) — it fully
 * replaces the default, it does not layer on top of it.
 */
export type DuplicateFrameFn = (request: DuplicateFrameRequest) => Promise<void>;

/**
 * FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4, "two-way selection
 * sync: canvas ↔ Layers ↔ Inspector" bullet — closes the AUDIT-FP1 carry-
 * forward: "Layers-panel-originated frame selection doesn't drive the
 * canvas's own selection"). Everything a caller needs to drive an EXTERNAL
 * (Layers-panel-originated) element selection onto the canvas — plain data,
 * no engine-specific types (playbook §5.4): `dynamic`/`component`/
 * `breadcrumb` are already known to the caller from its own live tree (the
 * SAME `TreeNode` fields `Inspector.tsx`/`LayersPanel.tsx` already read), so
 * neither engine ever needs to re-derive them via an extra bridge round trip
 * — only the RECT is fetched fresh (via `report-rects`, once the frame's
 * bridge connection is available), same as `EditModeLayer`'s own
 * `handleClick` does for a canvas-originated selection.
 */
export interface SelectNodeRequest {
  fileFolder: string;
  framePath: string;
  uid: string;
  dynamic: boolean;
  component: string | null;
  breadcrumb: { uid: string; name: string }[];
}

/** FP-4a: the canvas-originated counterpart of {@link SelectNodeRequest} —
 * reported UP to the caller (via `StudioCanvasProps.onElementSelect`)
 * whenever a real canvas click/hit-test resolves a selection, so the
 * studio's own `workspace-store` (Layers highlight + Inspector) can mirror
 * it. `null` when the canvas-side element selection is cleared (frame
 * deselected, or a click landed on empty frame background). */
export interface ElementSelection {
  fileFolder: string;
  framePath: string;
  uid: string;
}

/**
 * FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2, playbook §5.4 abstraction
 * rule): the camera-control surface handed to `onReady` — plain,
 * engine-independent methods a caller (the studio's zoom widget + keymap)
 * can invoke without ever importing an engine-specific type. Both
 * `TldrawEngineCanvas` (backed by tldraw's own `Editor.zoomIn`/`zoomOut`/
 * `resetZoom`/`zoomToFit`/`zoomToSelection`) and `CustomEngineCanvas`
 * (backed by `camera-store.ts`'s actions of the same name) produce an
 * IDENTICAL `StudioCanvasHandle` shape — this is the whole point of the
 * `CCS_CANVAS_ENGINE` flag being swappable with zero call-site changes.
 * Mirrors Penpot's own zoom-widget action set 1:1 (`../penpot/frontend/src/
 * app/main/ui/workspace/right_header.cljs` `zoom-widget-workspace`:
 * increase/decrease/reset/fit-all/zoom-selected).
 */
export interface StudioCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Resets to 100% (Penpot: `Shift+0`). */
  resetZoom(): void;
  /** Fits every frame in the viewport (Penpot: `Shift+1`). */
  zoomToFit(): void;
  /** Fits the current selection in the viewport; a no-op if nothing is
   * selected (Penpot: `Shift+2`). */
  zoomToSelection(): void;
  /** FP-3 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3): creates a new
   * frame through the EXACT SAME flow the "+ New Frame" form
   * (`NewFrameForm.tsx`) already uses (`CreateFrameFn`/`defaultCreateFrame`,
   * ADR-0014) — the studio's Frame toolbar tool calls this instead of
   * re-implementing frame creation, keeping create-frame a single code
   * path. Resolves once the daemon's resulting `file-changed` broadcast(s)
   * land the new frame in `frames` state (same completion signal
   * `defaultCreateFrame` already defines), or rejects on timeout/
   * `control-error` — see {@link CreateFrameFn}'s own doc. */
  createFrame: CreateFrameFn;
  /** FP-4a: selects a BOARD on the canvas (drives the active engine's own
   * frame selection only — no edit-mode activation, no bridge round trip)
   * given its `(fileFolder, framePath)`. A no-op if no matching frame is
   * currently known. This is the fix for the AUDIT-FP1 carry-forward: a
   * Layers-panel board-row click now ALSO selects the frame, so
   * `zoomToSelection` (⇧2) works after a Layers-originated selection, not
   * just a canvas-originated one. */
  selectFrame(fileFolder: string, framePath: string): void;
  /** FP-4a: selects a specific ELEMENT on the canvas from an EXTERNAL
   * (Layers-panel) origin — see {@link SelectNodeRequest}'s doc. Selects the
   * owning frame, activates it (same "frame becomes active, elements become
   * hit-testable" state a canvas single-click enters — see
   * `edit-mode-layer.tsx`), and drives the bridge highlight/selection
   * (`set-selection`, `subscribe-rects`) once that frame's bridge
   * connection is available. A no-op if no matching frame is known. */
  selectNode(request: SelectNodeRequest): void;
  /** FIX 5 (human dogfood: "when I click the icon in the side pane of any
   * layer I want it to get me directly to that element in the canvas" —
   * Penpot `layers.cljs`/`layer_item.cljs` parity: the layer row's TYPE
   * ICON is a distinct "zoom to this node" affordance, separate from a
   * plain row click which only selects). Selects/activates exactly like
   * {@link selectNode}, then frames the camera on the ELEMENT itself once
   * its rect resolves via the bridge (the same `report-rects` round trip
   * `selectNode`'s own doc describes) — falling back to framing the OWNING
   * FRAME's bounds if the rect never resolves in time (a `dynamic` node
   * whose bridge selection never streams a rect, a frame whose bridge
   * connection is still spinning up, etc.), so this always ends in
   * something visibly framed rather than leaving the camera untouched. A
   * no-op if no matching frame is currently known. */
  zoomToNode(request: SelectNodeRequest): void;
  /** FIX 5: the BOARD-row equivalent of {@link zoomToNode} — selects the
   * frame (like {@link selectFrame}) and immediately frames the camera on
   * its full bounds (no bridge round trip needed; a board's own geometry
   * is already known). A no-op if no matching frame is currently known. */
  zoomToFrame(fileFolder: string, framePath: string): void;
  /** FIX-W4b-3a (Inspector "Size & position" for a selected BOARD): writes
   * `(fileFolder, framePath)`'s geometry through the SAME `set-geometry`
   * daemon write (ADR-0013) the drag/resize commit path already sends —
   * `geometry` is a `Partial<Box>` because the Inspector only ever knows the
   * axis it's actually editing; any omitted field is filled in from the
   * frame's OWN current record, never reset to 0. A no-op if no matching
   * frame is currently known. */
  setFrameGeometry(fileFolder: string, framePath: string, geometry: Partial<Box>): void;
  /** FP-INS-b (Inspect / code tab): requests `uid`'s CURATED computed CSS
   * (see `@ccs/bridge`'s `computed-style.ts`) through whichever frame is
   * CURRENTLY the edit-mode frame's live bridge connection (the same
   * connection `EditModeLayer` uses for hit-test/selection — see that
   * file's `onBridgeConnectionChange` doc). Resolves `{ok:false,
   * reason:'not-found'}` if no bridge connection is currently live (no
   * frame active yet, or its iframe hasn't mounted/is still in screenshot
   * render mode) — the caller (Inspector's Inspect tab) treats this the
   * same as any other "couldn't resolve this uid" outcome, no special
   * handling needed. */
  requestComputedStyle(uid: string): Promise<ComputedStyleResult>;
}

/** Bound on how long a `defaultCreateFrame`/`defaultDuplicateFrame` promise
 * waits for a daemon reply before giving up — a stuck daemon/connection
 * should surface as a UI error, not hang forever. */
export const CREATE_FRAME_TIMEOUT_MS = 10_000;

/** FIX 5: bound on how long `zoomToNode` waits for the bridge to resolve a
 * fresh rect for the requested uid before giving up and framing the OWNING
 * FRAME's bounds instead — a dynamic node (bridge never streams a rect for
 * it) or a frame whose bridge connection is still spinning up must still
 * end in something visibly framed rather than leaving the camera
 * untouched forever. */
export const ZOOM_TO_NODE_TIMEOUT_MS = 1_500;

/** FIX 5 (AUDIT-FIXW1 major remediation): hard cap on the zoom level
 * `zoomToNode` will drive the camera to. Without this, a tiny nested
 * element (e.g. a small icon or a one-word `<span>`) would zoom to 800%+
 * to "fill" the viewport — disorienting, and it balloons the active
 * frame's on-screen box far past the viewport (which is what let the
 * edit-mode capture overlay grow to cover everything). tldraw's
 * `zoomToBounds` takes `zoom = Math.min(opts.targetZoom, fitZoom)`
 * (verified against the installed 5.2.4 `Editor.zoomToBounds`); the custom
 * engine's `computeCameraToFitBounds`/`camera-store.ts`'s `zoomToBounds`
 * (2a) replicates that exact clamp semantics — so passing this as
 * `targetZoom` clamps a would-be huge zoom down to 200% for BOTH engines
 * while still zooming OUT to fit a large element that doesn't fit at 200%. */
export const ZOOM_TO_NODE_MAX_ZOOM = 2;
/** FIX 5: screen-space padding (tldraw's `zoomToBounds` `inset`, total
 * across both edges; `computeCameraToFitBounds`'s `FitBoundsOptions.inset`
 * for the custom engine) so a framed element has breathing room rather than
 * sitting edge-to-edge. */
export const ZOOM_TO_NODE_INSET_PX = 160;

export interface StudioCanvasProps {
  /** Control-ws URL, e.g. `ws://127.0.0.1:4700` (ADR-0012/0013). */
  daemonUrl: string;
  /** See {@link CreateFrameFn}. Defaults to a real daemon-backed
   * implementation (ADR-0014's `create-frame` control request) — pass this
   * prop only to override that default (e.g. in tests). */
  onCreateFrame?: CreateFrameFn;
  /** See {@link DuplicateFrameFn}. Defaults to a real daemon-backed
   * implementation (ADR-0015's `duplicate-frame` control request) — pass
   * this prop only to override that default (e.g. in tests). */
  onDuplicateFrame?: DuplicateFrameFn;
  className?: string;
  style?: React.CSSProperties;
  /** FP-1: fired once the active engine has mounted, with a plain
   * engine-independent camera-control handle (see {@link StudioCanvasHandle})
   * — the caller's zoom widget + keyboard map drive the camera through this,
   * never an engine-specific object directly (playbook §5.4). */
  onReady?: (handle: StudioCanvasHandle) => void;
  /** FP-1: fires with the live zoom level as a rounded percentage (100 =
   * 100%) whenever the camera zoom changes — backs the zoom widget's `%`
   * readout (Penpot: `right_header.cljs`'s `zoom-widget-workspace`). */
  onZoomChange?: (percent: number) => void;
  /** FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 4): fires with the
   * currently-selected frame's record whenever the active engine's own
   * selection resolves to exactly one frame (a plain click, or a marquee
   * that nets exactly one frame) — `null` when the selection is empty or
   * spans more than one frame. The caller wires this into the studio's own
   * selection store so Layers/Inspector reflect a canvas click, mirroring
   * what `LayersPanel`'s own board-row click already does. */
  onFrameSelect?: (record: CanvasFrameRecord | null) => void;
  /** FP-4a: fires with the currently-selected ELEMENT whenever a real
   * canvas click/hit-test resolves one (or `null` when it's cleared) — see
   * {@link ElementSelection}'s doc. The caller wires this into
   * `workspace-store`'s `selectFrame`/`selectNode` so Layers/Inspector
   * mirror a canvas-originated element selection, symmetric with
   * `onFrameSelect` for boards. */
  onElementSelect?: (selection: ElementSelection | null) => void;
  /** FP-4a: fires once an in-place text edit COMMITS (never for a
   * cancelled/Esc'd one — see `edit-mode-layer.tsx`'s `CommitTextRequest`
   * doc). The caller (studio chrome) owns emitting the actual `set-text`
   * `CanvasOp` over ITS OWN daemon-ops connection — this package never
   * sends `CanvasOp`s itself. */
  onCommitText?: (request: CommitTextRequest) => void;
  /** FP-4b (D-EDIT context-aware drag-to-move) — fires once per completed
   * REORDER drop (flex/grid parent). The caller emits the existing
   * `move-node` `CanvasOp` — see `edit-mode-layer.tsx`'s
   * `ReorderNodeRequest` doc. This package never sends ops itself. */
  onReorderNode?: (request: ReorderNodeRequest) => void;
  /** FP-4b — fires once per completed FREE-DRAG drop (non-layout parent).
   * The caller emits the existing `set-classes` `CanvasOp`(s) — see
   * `edit-mode-layer.tsx`'s `CommitFreeDragRequest` doc. */
  onCommitFreeDrag?: (request: CommitFreeDragRequest) => void;
  /** FP-INS-b (AUDIT-FPINSb major fix): fires whenever the edit-mode frame's
   * live bridge connection (re)connects (`true`) or tears down (`false`) —
   * the studio-facing surfacing of `EditModeLayer`'s own
   * `onBridgeConnectionChange`. The Inspect tab uses this as a "bridge
   * generation" trigger: `requestComputedStyle` resolves `not-found` while no
   * bridge is live, so a one-shot mount-time fetch loses the race against a
   * frame that only goes live AFTER selection (see `FrameShape`'s/
   * `frame-shape.tsx`'s edit-mode force-live) — this lets the caller re-run
   * the fetch the moment the bridge is actually up. Distinct from the
   * per-frame `onFrameSelect`/`onElementSelect`: this is specifically about
   * the BRIDGE's readiness, the one thing `requestComputedStyle` depends
   * on. */
  onBridgeConnectionChange?: (connected: boolean) => void;
}

export const CONTAINER_STYLE: React.CSSProperties = { position: 'relative', width: '100%', height: '100%' };
