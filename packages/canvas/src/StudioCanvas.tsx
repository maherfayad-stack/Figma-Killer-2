import * as React from 'react';
import { Tldraw, createShapeId, useValue, type Editor, type TLComponents, type TLUiOverrides } from 'tldraw';
import type { ComputedStyleResult } from '@ccs/bridge';
import type { ControlReply, DaemonEvent, FrameMeta, ProjectInfo } from '@ccs/protocol';
import { connectDaemon, type DaemonClient } from './daemon-client.js';
import {
  deriveFileFolderPath,
  frameNameFromPath,
  isCanvasJsonPath,
  isFrameSourcePath,
} from './daemon-protocol.js';
import { checkFrameSourceExists, originOf } from './canvas-json-client.js';
import {
  defaultGeometryForIndex,
  frameRecordId,
  removeFrameRecord,
  resyncFileFolderGeometry,
  upsertFrameRecord,
  wireProjectInfo,
  type CanvasFrameRecord,
} from './project-wiring.js';
import { createScreenshotCache } from './screenshot-cache.js';
import {
  CCS_FRAME_SHAPE_TYPE,
  CcsFrameShapeUtil,
  ScreenshotCacheContext,
  onFrameGeometryCommitted,
  type CcsFrameShape,
} from './frame-shape.js';
import { frameSourcePath, isValidFrameName } from './new-frame.js';
import {
  EditModeLayer,
  type CommitFreeDragRequest,
  type CommitTextRequest,
  type ReorderNodeRequest,
} from './edit-mode-layer.js';
import { emitUidRemap, useSelectionStore } from './selection-store.js';
import { shiftPanDelta } from './wheel-gesture.js';

/**
 * `StudioCanvas` — the package's public entry point (playbook §4/P1). All
 * tldraw specifics live behind this component: callers only ever see
 * `CanvasFrameRecord`-shaped data and the `CreateFrameFn` contract, never
 * a tldraw type (playbook §5.4 — keeps a future custom-camera fallback
 * possible without touching call sites).
 */

export interface CreateFrameRequest {
  fileFolder: string;
  name: string;
}

/**
 * Creates a new frame (`.tsx` + `src/frames.ts` registry entry +
 * `.studio/canvas.json` entry — playbook §4/P1 step 4). The default
 * implementation (see `defaultCreateFrame` inside `StudioCanvas`) sends a
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
 * shapes the reaper then deleted on the next sync). The default
 * implementation (see `defaultDuplicateFrame` inside `StudioCanvas`) sends
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
 * forward: "Layers-panel-originated frame selection doesn't drive tldraw's
 * own canvas selection"). Everything a caller needs to drive an EXTERNAL
 * (Layers-panel-originated) element selection onto the canvas — plain data,
 * no tldraw/bridge types (playbook §5.4): `dynamic`/`component`/`breadcrumb`
 * are already known to the caller from its own live tree (the SAME
 * `TreeNode` fields `Inspector.tsx`/`LayersPanel.tsx` already read), so
 * `StudioCanvas` never needs to re-derive them via an extra bridge round
 * trip — only the RECT is fetched fresh (via `report-rects`, once the
 * frame's bridge connection is available), same as `EditModeLayer`'s own
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
 * rule): the camera-control surface handed to `onReady` — plain, tldraw-
 * independent methods a caller (the studio's zoom widget + keymap) can
 * invoke without ever importing a tldraw `Editor` type. Backed by tldraw's
 * own `Editor.zoomIn`/`zoomOut`/`resetZoom`/`zoomToFit`/`zoomToSelection`
 * (verified present on the installed tldraw@5.2.4 `Editor` class) — see
 * `StudioCanvas`'s `onReady` effect for the mapping. Mirrors Penpot's own
 * zoom-widget action set 1:1 (`../penpot/frontend/src/app/main/ui/
 * workspace/right_header.cljs` `zoom-widget-workspace`: increase/decrease/
 * reset/fit-all/zoom-selected).
 */
export interface StudioCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Resets to 100% (Penpot: `Shift+0`). */
  resetZoom(): void;
  /** Fits every frame in the viewport (Penpot: `Shift+1`). */
  zoomToFit(): void;
  /** Fits the current tldraw selection in the viewport; a no-op if nothing
   * is selected (Penpot: `Shift+2`). */
  zoomToSelection(): void;
  /** FP-3 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3): creates a new
   * frame through the EXACT SAME flow the "+ New Frame" form below already
   * uses (`CreateFrameFn`/`defaultCreateFrame`, ADR-0014) — the studio's
   * Frame toolbar tool calls this instead of re-implementing frame
   * creation, keeping create-frame a single code path. Resolves once the
   * daemon's resulting `file-changed` broadcast(s) land the new frame in
   * `frames` state (same completion signal `defaultCreateFrame` already
   * defines), or rejects on timeout/`control-error` — see
   * {@link CreateFrameFn}'s own doc. */
  createFrame: CreateFrameFn;
  /** FP-4a: selects a BOARD on the canvas (drives tldraw's own shape
   * selection only — no edit-mode activation, no bridge round trip) given
   * its `(fileFolder, framePath)`. A no-op if no matching frame is
   * currently known. This is the fix for the AUDIT-FP1 carry-forward: a
   * Layers-panel board-row click now ALSO selects the tldraw shape, so
   * `zoomToSelection` (⇧2) works after a Layers-originated selection, not
   * just a canvas-originated one. */
  selectFrame(fileFolder: string, framePath: string): void;
  /** FP-4a: selects a specific ELEMENT on the canvas from an EXTERNAL
   * (Layers-panel) origin — see {@link SelectNodeRequest}'s doc. Selects the
   * owning frame's tldraw shape, activates it (same "frame becomes active,
   * elements become hit-testable" state a canvas single-click enters — see
   * `edit-mode-layer.tsx`), and drives the bridge highlight/selection
   * (`set-selection`, `subscribe-rects`) once that frame's bridge
   * connection is available. A no-op if no matching frame is known. */
  selectNode(request: SelectNodeRequest): void;
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
const CREATE_FRAME_TIMEOUT_MS = 10_000;

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
  /** FP-1: fired once the tldraw editor has mounted, with a plain
   * tldraw-independent camera-control handle (see {@link StudioCanvasHandle})
   * — the caller's zoom widget + keyboard map drive the camera through this,
   * never a tldraw `Editor` directly (playbook §5.4). */
  onReady?: (handle: StudioCanvasHandle) => void;
  /** FP-1: fires with the live zoom level as a rounded percentage (100 =
   * 100%) whenever tldraw's camera zoom changes — backs the zoom widget's
   * `%` readout (Penpot: `right_header.cljs`'s `zoom-widget-workspace`). */
  onZoomChange?: (percent: number) => void;
  /** FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 4): fires with the
   * currently-selected frame's record whenever tldraw's own selection
   * resolves to exactly one `ccs-frame` shape (a plain click, or a marquee
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
   * frame that only goes live AFTER selection (see `frame-shape.tsx`'s
   * edit-mode force-live) — this lets the caller re-run the fetch the moment
   * the bridge is actually up. Distinct from the per-frame `onFrameSelect`/
   * `onElementSelect`: this is specifically about the BRIDGE's readiness, the
   * one thing `requestComputedStyle` depends on. */
  onBridgeConnectionChange?: (connected: boolean) => void;
}

const CONTAINER_STYLE: React.CSSProperties = { position: 'relative', width: '100%', height: '100%' };

/** tldraw component overrides — P1 doesn't build studio chrome (that's
 * P5), so every stock tldraw UI panel not needed to demonstrate pan/zoom/
 * select/resize is hidden here (empty object = defaults kept only for the
 * shapes/handles/selection UI itself, per playbook BOUNDARIES: "do NOT
 * build the full studio chrome"). */
const MINIMAL_COMPONENTS: TLComponents = {
  MenuPanel: null,
  PageMenu: null,
  MainMenu: null,
  ActionsMenu: null,
  StylePanel: null,
  Toolbar: null,
  KeyboardShortcutsDialog: null,
  HelpMenu: null,
  DebugPanel: null,
  DebugMenu: null,
  ZoomMenu: null,
  QuickActions: null,
  NavigationPanel: null,
};

function shapeIdForRecordId(recordId: string) {
  return createShapeId(recordId);
}

/** `createShapeId(id)` deterministically produces `shape:<id>` (verified
 * against the installed tldraw@5.2.4 build) — recovering the original
 * record id is a plain prefix strip, not a public tldraw API, so it's
 * isolated to this one helper in case a future tldraw version changes
 * the format. */
function recordIdFromShapeId(shapeId: string): string {
  const prefix = 'shape:';
  return shapeId.startsWith(prefix) ? shapeId.slice(prefix.length) : shapeId;
}

/** Correlates an ADR-0014 `create-frame`/`get-canvas-json` request to its
 * `onControlReply`. Plain counter (not `crypto.randomUUID`) — this only
 * needs to be unique within one `StudioCanvas` instance's lifetime, not
 * globally, and stays dependency-free for the dev/e2e/browser targets
 * this module runs in. */
let requestIdCounter = 0;
function nextRequestId(prefix: string): string {
  requestIdCounter += 1;
  return `${prefix}-${requestIdCounter}`;
}

export function StudioCanvas({
  daemonUrl,
  onCreateFrame,
  onDuplicateFrame,
  className,
  style,
  onReady,
  onZoomChange,
  onFrameSelect,
  onElementSelect,
  onCommitText,
  onReorderNode,
  onCommitFreeDrag,
  onBridgeConnectionChange,
}: StudioCanvasProps): React.ReactElement {
  const [frames, setFrames] = React.useState<CanvasFrameRecord[]>([]);
  const [editorReady, setEditorReady] = React.useState(false);
  const editorRef = React.useRef<Editor | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // P2/WS-B: `EditModeLayer` needs the `Editor` instance as a render-time
  // value (it's JSX-conditional below), and `react-hooks/refs` correctly
  // flags reading `editorRef.current` during render (refs are an escape
  // hatch for effects/handlers, not render). `editorReady`/`editorRef`
  // above are untouched (still used the same way by the existing
  // effects further down) — this is purely an additional render-safe
  // mirror of the same value, set in the same `handleMount` callback.
  const [mountedEditor, setMountedEditor] = React.useState<Editor | null>(null);
  const clientRef = React.useRef<DaemonClient | null>(null);
  const originByFileFolderRef = React.useRef<Map<string, string>>(new Map());
  const [screenshotCache] = React.useState(() => createScreenshotCache());
  const [newFrameOpen, setNewFrameOpen] = React.useState(false);
  const [newFrameName, setNewFrameName] = React.useState('');
  const [newFrameError, setNewFrameError] = React.useState<string | null>(null);
  const [newFrameBusy, setNewFrameBusy] = React.useState(false);
  /** ADR-0015 phantom-frame guard: `true` for the duration of the
   * `CanvasFrameRecord[] -> tldraw shape` sync effect's own
   * `createShape`/`updateShape`/`deleteShapes` calls below, `false`
   * otherwise. The `registerAfterCreateHandler('shape', ...)` effect
   * (further down) uses this to tell "the sync effect just created a
   * real, record-backed frame shape" apart from "tldraw's native
   * duplicate/copy/paste/undo just created a `ccs-frame` shape out of
   * nowhere" — only the latter gets deleted right back out. A plain ref
   * (not React state) because it must be read synchronously inside a
   * tldraw store callback that can fire outside React's render cycle. */
  const isSyncingRef = React.useRef(false);
  /** §6 blocker #3 / playbook §5.9 "Shift+1 fit-all" equivalent on open:
   * guards the zoom-to-fit effect below so it fires exactly ONCE per
   * `StudioCanvas` mount (project load), never again after — see that
   * effect's doc for why. */
  const hasZoomedToFitRef = React.useRef(false);

  // --- ADR-0014/0015 control-request/reply correlation -----------------
  // `get-canvas-json` resolves by `requestId` alone (direct reply carries
  // the `FrameMeta`). `create-frame` has no dedicated success reply (see
  // `daemon-client.ts`'s module doc): a `control-error` reply still
  // correlates by `requestId`, but success is only observable once the
  // resulting `file-changed` broadcast(s) land the new record in `frames`
  // state — hence tracking `fileFolder`/`framePath` per pending request too
  // (resolved by the `frames`-watching effect below, not by a reply).
  // `duplicate-frame` (ADR-0015) DOES get a dedicated success reply
  // (`duplicate-frame-result`) — the caller can't know the daemon-picked
  // `newName` in advance, so it resolves directly from that reply instead.
  const pendingGetCanvasJsonRef = React.useRef<Map<string, (meta: FrameMeta | null) => void>>(new Map());
  const pendingCreateFrameRef = React.useRef<
    Map<string, { fileFolder: string; framePath: string; resolve: () => void; reject: (err: Error) => void }>
  >(new Map());
  const pendingDuplicateFrameRef = React.useRef<
    Map<string, { resolve: () => void; reject: (err: Error) => void }>
  >(new Map());

  // FP-INS-b: the CURRENT edit-mode frame's `requestComputedStyle`, kept in
  // a ref (not React state) so `StudioCanvasHandle.requestComputedStyle`
  // (below) always reads whichever bridge connection is live AT CALL TIME —
  // same "ref mirrors a value the onReady handle reaches for lazily"
  // reasoning as `framesRef` uses for `selectFrameOnCanvas`/
  // `selectNodeOnCanvas`. `EditModeLayer` is the sole owner of the actual
  // bridge connection (one per edit-mode iframe); this is populated/cleared
  // via its `onBridgeConnectionChange` callback.
  const computedStyleRequesterRef = React.useRef<((uid: string) => Promise<ComputedStyleResult>) | null>(null);
  // `onBridgeConnectionChange` is expected to be a stable callback (the
  // studio passes a `useCallback`-wrapped setter, same discipline as
  // `onReady`); read via a ref so `handleBridgeConnectionChange` itself stays
  // stable (empty dep array) and doesn't churn `EditModeLayer`'s effect.
  const onBridgeConnectionChangeRef = React.useRef(onBridgeConnectionChange);
  React.useEffect(() => {
    onBridgeConnectionChangeRef.current = onBridgeConnectionChange;
  }, [onBridgeConnectionChange]);
  const handleBridgeConnectionChange = React.useCallback(
    (fn: ((uid: string) => Promise<ComputedStyleResult>) | null) => {
      computedStyleRequesterRef.current = fn;
      // FP-INS-b (AUDIT-FPINSb): surface the (re)connect/teardown to the
      // studio so the Inspect tab can re-run its computed-CSS fetch once the
      // bridge is actually live (a one-shot mount-time fetch otherwise races
      // a frame that only goes live after selection).
      onBridgeConnectionChangeRef.current?.(fn !== null);
    },
    [],
  );

  const shapeUtils = React.useMemo(() => [CcsFrameShapeUtil], []);

  /** ADR-0014 default `onCreateFrame`: sends `create-frame` over the real
   * control-ws connection and lets the pending-request bookkeeping above
   * settle the promise (success via the `frames`-watching effect, failure
   * via `handleControlReply`'s `control-error` branch inside the
   * daemon-connection effect). */
  const defaultCreateFrame = React.useCallback<CreateFrameFn>((request) => {
    const client = clientRef.current;
    if (!client) {
      return Promise.reject(new Error('@ccs/canvas: not connected to the daemon yet'));
    }
    const requestId = nextRequestId('create-frame');
    const framePath = frameSourcePath(request.name);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCreateFrameRef.current.delete(requestId);
        reject(
          new Error(
            `@ccs/canvas: create-frame "${request.name}" in "${request.fileFolder}" timed out waiting for the daemon`,
          ),
        );
      }, CREATE_FRAME_TIMEOUT_MS);
      pendingCreateFrameRef.current.set(requestId, {
        fileFolder: request.fileFolder,
        framePath,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      client.sendCreateFrame(request.fileFolder, request.name, requestId);
    });
  }, []);

  const createFrame = onCreateFrame ?? defaultCreateFrame;

  /** ADR-0015 default `onDuplicateFrame`: sends `duplicate-frame` over the
   * real control-ws connection. Unlike `defaultCreateFrame`, this resolves
   * directly from the dedicated `duplicate-frame-result` reply (handled in
   * `handleControlReply` below) rather than by watching `frames` state —
   * the caller doesn't know the daemon-picked `newName` in advance, so
   * there's no known `framePath` to watch for. */
  const defaultDuplicateFrame = React.useCallback<DuplicateFrameFn>((request) => {
    const client = clientRef.current;
    if (!client) {
      return Promise.reject(new Error('@ccs/canvas: not connected to the daemon yet'));
    }
    const requestId = nextRequestId('duplicate-frame');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDuplicateFrameRef.current.delete(requestId);
        reject(
          new Error(
            `@ccs/canvas: duplicate-frame for "${request.sourceName}" in "${request.fileFolder}" timed out waiting for the daemon`,
          ),
        );
      }, CREATE_FRAME_TIMEOUT_MS);
      pendingDuplicateFrameRef.current.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      client.sendDuplicateFrame(request.fileFolder, request.sourceName, requestId);
    });
  }, []);

  const duplicateFrame = onDuplicateFrame ?? defaultDuplicateFrame;

  // Resolves pending `defaultCreateFrame` promises once the new frame's
  // `file-changed` broadcast(s) have propagated through `handleFileChanged`
  // into `frames` state — `create-frame` has no direct success reply
  // (ADR-0014), so this is the only success signal available.
  React.useEffect(() => {
    if (pendingCreateFrameRef.current.size === 0) return;
    for (const [requestId, pending] of pendingCreateFrameRef.current) {
      const created = frames.some((r) => r.fileFolder === pending.fileFolder && r.framePath === pending.framePath);
      if (created) {
        pendingCreateFrameRef.current.delete(requestId);
        pending.resolve();
      }
    }
  }, [frames]);

  // --- daemon connection + event wiring (ADR-0012/0013/0014) ----------
  React.useEffect(() => {
    let cancelled = false;

    /** Fetches a file-folder's `.studio/canvas.json` via the real
     * control-ws `get-canvas-json` request (ADR-0014) — replies come back
     * through `handleControlReply` below, correlated by `requestId`.
     * Returns `null` on any failure (unknown file-folder, not-yet-connected
     * client, `control-error` reply), mirroring how the daemon's own
     * `readCanvasJson` treats a missing file as "no geometry yet". */
    function requestCanvasJson(fileFolder: string): Promise<FrameMeta | null> {
      const client = clientRef.current;
      if (!client) return Promise.resolve(null);
      const requestId = nextRequestId('get-canvas-json');
      return new Promise<FrameMeta | null>((resolve) => {
        pendingGetCanvasJsonRef.current.set(requestId, resolve);
        client.sendGetCanvasJson(fileFolder, requestId);
      });
    }

    function handleControlReply(reply: ControlReply): void {
      if (reply.kind === 'get-canvas-json-result') {
        const resolve = pendingGetCanvasJsonRef.current.get(reply.requestId);
        if (!resolve) return; // stale/unmatched reply (e.g. after unmount) — ignore
        pendingGetCanvasJsonRef.current.delete(reply.requestId);
        resolve(reply.meta);
        return;
      }

      if (reply.kind === 'duplicate-frame-result') {
        // ADR-0015: unlike create-frame, duplicate-frame has a dedicated
        // success reply — resolve directly, no `frames`-watching effect
        // needed (the new frame still arrives via the ordinary
        // `file-changed` -> `get-canvas-json` -> `setFrames` path; this
        // reply is purely about settling the caller's promise).
        const pendingDuplicate = pendingDuplicateFrameRef.current.get(reply.requestId);
        if (!pendingDuplicate) return; // stale/unmatched reply — ignore
        pendingDuplicateFrameRef.current.delete(reply.requestId);
        pendingDuplicate.resolve();
        return;
      }

      if (reply.kind === 'read-source-result') {
        // FP-INS-b: `read-source`/`read-source-result` is sent/consumed over
        // `apps/studio`'s OWN (separate) daemon-ops connection (`daemon-
        // connection.tsx`), never over THIS package's internal control-ws —
        // `@ccs/canvas` never issues a `read-source` request itself. Ignored
        // here purely so this reply kind (which carries no `reason` field)
        // narrows out of the remaining `.reason`-bearing union below; a
        // stray reply of this kind reaching this socket is otherwise
        // harmless and unreachable in practice.
        return;
      }

      // reply.kind === 'control-error' — could be a `get-canvas-json`,
      // `create-frame`, or `duplicate-frame` failure; each tracks pending
      // requests by `requestId` in its own map, so check each.
      const pendingJson = pendingGetCanvasJsonRef.current.get(reply.requestId);
      if (pendingJson) {
        pendingGetCanvasJsonRef.current.delete(reply.requestId);
        pendingJson(null);
        return;
      }
      const pendingCreate = pendingCreateFrameRef.current.get(reply.requestId);
      if (pendingCreate) {
        pendingCreateFrameRef.current.delete(reply.requestId);
        pendingCreate.reject(new Error(reply.reason));
        return;
      }
      const pendingDuplicate = pendingDuplicateFrameRef.current.get(reply.requestId);
      if (pendingDuplicate) {
        pendingDuplicateFrameRef.current.delete(reply.requestId);
        pendingDuplicate.reject(new Error(reply.reason));
      }
    }

    async function handleProjectInfo(info: ProjectInfo): Promise<void> {
      for (const frame of info.frames) {
        const derived = deriveFileFolderPath(frame.framePath);
        if (!derived) continue;
        if (!originByFileFolderRef.current.has(derived.fileFolder)) {
          originByFileFolderRef.current.set(derived.fileFolder, originOf(frame.devServerUrl));
        }
      }

      const metaByFileFolder = new Map<string, FrameMeta>();
      await Promise.all(
        [...originByFileFolderRef.current.keys()].map(async (fileFolder) => {
          const meta = await requestCanvasJson(fileFolder);
          if (meta) metaByFileFolder.set(fileFolder, meta);
        }),
      );
      if (cancelled) return;
      setFrames(wireProjectInfo(info, metaByFileFolder));
    }

    async function handleFileChanged(projectRelativePath: string): Promise<void> {
      const derived = deriveFileFolderPath(projectRelativePath);
      if (!derived) return;
      const origin = originByFileFolderRef.current.get(derived.fileFolder);
      if (!origin) return; // unknown file-folder — see CHANGE-REQUEST (no origin learned yet)

      if (isCanvasJsonPath(derived.relPath)) {
        const meta = await requestCanvasJson(derived.fileFolder);
        if (!meta || cancelled) return;
        setFrames((prev) => resyncFileFolderGeometry(prev, derived.fileFolder, meta));
        return;
      }

      if (isFrameSourcePath(derived.relPath)) {
        const name = frameNameFromPath(derived.relPath);
        if (!name) return;
        const exists = await checkFrameSourceExists(origin, derived.relPath);
        if (cancelled) return;
        const id = frameRecordId(derived.fileFolder, derived.relPath);

        if (!exists) {
          setFrames((prev) => removeFrameRecord(prev, id));
          return;
        }

        const meta = await requestCanvasJson(derived.fileFolder);
        if (cancelled) return;
        setFrames((prev) => {
          const entry = meta?.frames.find((f) => f.framePath === derived.relPath);
          const sameFolderCount = prev.filter((r) => r.fileFolder === derived.fileFolder).length;
          const box = entry ?? { ...defaultGeometryForIndex(sameFolderCount), framePath: derived.relPath };
          const record: CanvasFrameRecord = {
            id,
            fileFolder: derived.fileFolder,
            framePath: derived.relPath,
            name,
            devServerUrl: `${origin}/?frame=${encodeURIComponent(name)}`,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
          };
          return upsertFrameRecord(prev, record);
        });
      }
    }

    function handleEvent(event: DaemonEvent): void {
      if (event.t === 'file-changed') {
        void handleFileChanged(event.file);
      } else if (event.t === 'hmr-update') {
        const derived = deriveFileFolderPath(event.file);
        if (!derived) return;
        screenshotCache.bumpGeneration(frameRecordId(derived.fileFolder, derived.relPath));
      } else if (event.t === 'uid-remap') {
        // P2/WS-B (playbook §4/P2, ADR-0016): forwarded to
        // `edit-mode-layer.tsx`'s subscriber via the module-level bus in
        // `selection-store.ts` — this daemon connection effect is the one
        // place `DaemonEvent`s are classified, but the re-resolution logic
        // needs the active edit-mode frame's bridge connection, which lives
        // in that component, not here.
        emitUidRemap(event);
      }
    }

    const client = connectDaemon(daemonUrl, {
      onProjectInfo: (info) => void handleProjectInfo(info),
      onEvent: handleEvent,
      onControlReply: handleControlReply,
    });
    clientRef.current = client;

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
    };
  }, [daemonUrl, screenshotCache]);

  // --- CanvasFrameRecord[] -> tldraw FrameShape sync -------------------
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;

    // ADR-0015: everything this effect does to the store is "the file
    // system is the truth, catching the canvas up" — never a user gesture
    // — so the phantom-frame guard (registered below) must let it through
    // unconditionally. Set for the duration of this synchronous block only
    // (tldraw's create/update/delete calls run synchronously; there's no
    // await in between), then always cleared via `finally`.
    isSyncingRef.current = true;
    try {
      const currentShapeIds = new Set<string>();
      for (const record of frames) {
        const shapeId = shapeIdForRecordId(record.id);
        currentShapeIds.add(shapeId);
        const existing = editor.getShape<CcsFrameShape>(shapeId);
        const props = {
          fileFolder: record.fileFolder,
          framePath: record.framePath,
          name: record.name,
          devServerUrl: record.devServerUrl,
          w: record.w,
          h: record.h,
        };
        if (!existing) {
          editor.createShape<CcsFrameShape>({
            id: shapeId,
            type: CCS_FRAME_SHAPE_TYPE,
            x: record.x,
            y: record.y,
            props,
          });
        } else if (
          existing.x !== record.x ||
          existing.y !== record.y ||
          existing.props.w !== record.w ||
          existing.props.h !== record.h ||
          existing.props.devServerUrl !== record.devServerUrl ||
          existing.props.name !== record.name
        ) {
          editor.updateShape<CcsFrameShape>({ id: shapeId, type: CCS_FRAME_SHAPE_TYPE, x: record.x, y: record.y, props });
        }
      }

      const staleShapeIds = editor
        .getCurrentPageShapesSorted()
        .filter((s) => s.type === CCS_FRAME_SHAPE_TYPE && !currentShapeIds.has(s.id))
        .map((s) => s.id);
      if (staleShapeIds.length > 0) editor.deleteShapes(staleShapeIds);
    } finally {
      isSyncingRef.current = false;
    }
  }, [frames, editorReady]);

  // --- §6 blocker #3: camera zoom-to-fit on project open ----------------
  // Frames used to render fully off-screen (tldraw's default camera sits at
  // the origin; real frame geometry from `.studio/canvas.json` is
  // elsewhere), which read to a user as "pan doesn't work" — it wasn't pan,
  // there was simply nothing on-screen to pan TO. This effect is declared
  // AFTER the frames->shape sync effect above, so React runs it later in
  // the same commit: by the time this runs, `editor.createShape` calls from
  // that effect have already landed in the store, and `zoomToFit` sees the
  // real content bounds. Fires exactly once per mount, gated by
  // `hasZoomedToFitRef` — deliberately NOT re-triggered on every `frames`
  // change (e.g. a later frame create/geometry edit), which would yank the
  // camera out from under a user who has since panned/zoomed manually.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady || hasZoomedToFitRef.current) return;
    if (frames.length === 0) return; // nothing synced into shapes yet
    hasZoomedToFitRef.current = true;
    editor.zoomToFit({ animation: { duration: 200 } });
  }, [frames, editorReady]);

  // FP-4a: `frames` mirror readable at CALL TIME (not closure-creation time)
  // by `selectFrameOnCanvas`/`selectNodeOnCanvas` below. Those two functions
  // are handed to the caller ONCE via the `onReady` effect right after this
  // one (which deliberately does NOT re-fire on every `frames` change — see
  // its own doc) — a plain destructured `frames` closure would go stale the
  // moment a frame that didn't exist yet at `onReady`-time needs to be
  // selected, so this ref is kept current independently instead.
  const framesRef = React.useRef<CanvasFrameRecord[]>(frames);
  React.useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  /** FP-4a `StudioCanvasHandle.selectFrame` — see its own doc. */
  const selectFrameOnCanvas = React.useCallback((fileFolder: string, framePath: string) => {
    const editor = editorRef.current;
    const record = framesRef.current.find((r) => r.fileFolder === fileFolder && r.framePath === framePath);
    if (!editor || !record) return;
    editor.select(shapeIdForRecordId(record.id));
  }, []);

  /** FP-4a `StudioCanvasHandle.selectNode` — see its own doc. Reuses the
   * exact same `selection-store` entry points (`enterEditMode`/
   * `setSelection`) a canvas-originated click already goes through
   * (`edit-mode-layer.tsx`'s `handleClick`) — the only difference is the
   * rect starts `null` here (no hit-test ever ran); `EditModeLayer`'s own
   * selection-sync effect backfills it via `report-rects` once that
   * frame's bridge connection is available (see that file's doc). */
  const selectNodeOnCanvas = React.useCallback((request: SelectNodeRequest) => {
    const editor = editorRef.current;
    const record = framesRef.current.find(
      (r) => r.fileFolder === request.fileFolder && r.framePath === request.framePath,
    );
    if (!editor || !record) return;
    const shapeId = shapeIdForRecordId(record.id);
    editor.select(shapeId);

    const store = useSelectionStore.getState();
    if (store.editModeFrame?.shapeId !== shapeId) {
      const camera = editor.getCamera();
      store.enterEditMode(
        { shapeId, fileFolder: record.fileFolder, framePath: record.framePath },
        { x: camera.x, y: camera.y, z: camera.z },
      );
    }
    useSelectionStore.getState().setSelection({
      uid: request.uid,
      rect: null,
      dynamic: request.dynamic,
      component: request.component,
      breadcrumb: request.breadcrumb,
    });
  }, []);

  // --- FP-1: hand the caller a plain camera-control handle ---------------
  // (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 3 — the zoom widget +
  // keymap drive the camera through this, never a tldraw `Editor` directly,
  // per the §5.4 abstraction rule). Fires once editor mounts; `onReady`
  // itself is expected to be a stable callback (e.g. a `useState` setter) —
  // this effect intentionally does NOT re-fire on every render.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady || !onReady) return;
    onReady({
      zoomIn: () => editor.zoomIn(undefined, { animation: { duration: 120 } }),
      zoomOut: () => editor.zoomOut(undefined, { animation: { duration: 120 } }),
      resetZoom: () => editor.resetZoom(undefined, { animation: { duration: 200 } }),
      zoomToFit: () => editor.zoomToFit({ animation: { duration: 200 } }),
      zoomToSelection: () => editor.zoomToSelection({ animation: { duration: 200 } }),
      createFrame,
      selectFrame: selectFrameOnCanvas,
      selectNode: selectNodeOnCanvas,
      requestComputedStyle: (uid: string) => {
        const fn = computedStyleRequesterRef.current;
        if (!fn) return Promise.resolve({ ok: false, reason: 'not-found' } as ComputedStyleResult);
        return fn(uid);
      },
    });
  }, [editorReady, onReady, createFrame, selectFrameOnCanvas, selectNodeOnCanvas]);

  // --- FP-1: shift+wheel horizontal-pan gap fix ---------------------------
  // See `wheel-gesture.ts`'s module doc for the full "why": tldraw's own
  // wheel dispatch never swaps a shift-held wheel gesture's axis (Windows/
  // Linux keep reporting the motion on `deltaY`, only macOS's browser/OS
  // layer already reports `deltaX` for that gesture) — Penpot hits the same
  // gap and hand-rolls the same remap. Attached on the OUTER wrapper with
  // `capture: true` so it runs before tldraw's own bubble-phase listener
  // (attached lower in the same DOM subtree, on tldraw's own container) and
  // can `stopPropagation()` to fully replace tldraw's handling for just this
  // one case — every other wheel gesture (plain wheel, ctrl/meta-wheel zoom,
  // a platform that already reports a real `deltaX`) is left untouched and
  // falls through to tldraw's native handling unchanged.
  React.useEffect(() => {
    const container = containerRef.current;
    const editor = editorRef.current;
    if (!container || !editor || !editorReady) return;

    function onWheelCapture(e: WheelEvent): void {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.deltaX !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = shiftPanDelta(e.deltaX, e.deltaY);
      editorRef.current?.dispatch({
        type: 'wheel',
        name: 'wheel',
        point: { x: e.clientX, y: e.clientY, z: 0 },
        delta: { x: -delta.x, y: -delta.y, z: 0 },
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        accelKey: false,
      });
    }

    container.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
    return () => container.removeEventListener('wheel', onWheelCapture, { capture: true });
  }, [editorReady]);

  // --- ADR-0015 phantom-frame guard ------------------------------------
  // tldraw's `registerBeforeCreateHandler` can only TRANSFORM a record
  // about to be created, not cancel its creation (verified against the
  // installed tldraw@5.2.4 `@tldraw/store` build — `StoreSideEffects`
  // has no "return false to block" affordance for creates, only for
  // deletes). `registerAfterCreateHandler` runs synchronously right after
  // the record lands in the store, in the SAME atomic operation, before
  // React ever re-renders — calling `editor.deleteShape` there removes it
  // before the user perceives it existing at all. This is the safety net
  // behind the `overrides.actions.duplicate` override below: it catches
  // ANY route to a fileless `ccs-frame` shape (native duplicate, copy/
  // paste, cut+undo, a future stray codepath), not just Cmd/Ctrl+D.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    return editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
      if (shape.type === CCS_FRAME_SHAPE_TYPE && !isSyncingRef.current) {
        editor.deleteShape(shape.id);
      }
    });
  }, [editorReady]);

  // --- drag/resize -> debounced .studio/canvas.json write (ADR-0013) ---
  React.useEffect(() => {
    return onFrameGeometryCommitted((shape) => {
      clientRef.current?.sendSetGeometry(shape.props.fileFolder, shape.props.framePath, {
        x: shape.x,
        y: shape.y,
        w: shape.props.w,
        h: shape.props.h,
      });
      setFrames((prev) =>
        prev.map((r) =>
          r.id === recordIdFromShapeId(shape.id) ? { ...r, x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h } : r,
        ),
      );
    });
  }, []);

  const handleMount = React.useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorReady(true);
    setMountedEditor(editor);
  }, []);

  /**
   * ADR-0015: replaces tldraw's native "duplicate" action (Cmd/Ctrl+D, and
   * the tool exposed via `overrides` — bound regardless of `MINIMAL_COMPONENTS`
   * hiding every UI panel, since `useKeyboardShortcuts` mounts unconditionally
   * inside `<Tldraw>`'s own UI provider) for `ccs-frame` shapes: instead of
   * tldraw's built-in record-copy (which the phantom-frame guard above would
   * immediately delete again), issue one real `duplicate-frame` daemon
   * request per selected frame. A selection with no frame shapes falls
   * through to the original action unchanged (harmless today — no other
   * shape type is ever intentionally created in this P1 UI — but keeps this
   * override honest about only touching what it means to).
   */
  const overrides = React.useMemo<TLUiOverrides>(
    () => ({
      actions(editor, actions) {
        const original = actions.duplicate;
        if (!original) return actions;
        return {
          ...actions,
          duplicate: {
            ...original,
            onSelect(source) {
              const frameShapes = editor
                .getSelectedShapes()
                .filter((shape): shape is CcsFrameShape => shape.type === CCS_FRAME_SHAPE_TYPE);
              if (frameShapes.length === 0) {
                original.onSelect(source);
                return;
              }
              for (const shape of frameShapes) {
                const sourceName = frameNameFromPath(shape.props.framePath);
                if (!sourceName) continue;
                duplicateFrame({ fileFolder: shape.props.fileFolder, sourceName }).catch((err: unknown) => {
                  // No toast system in P1 chrome (that's P5) — surface to
                  // the console rather than fail silently.
                  console.error('@ccs/canvas: duplicate-frame failed', err);
                });
              }
            },
          },
        };
      },
    }),
    [duplicateFrame],
  );

  const defaultFileFolder = frames[0]?.fileFolder;

  const submitNewFrame = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!defaultFileFolder) {
        setNewFrameError('no file-folder known yet');
        return;
      }
      if (!isValidFrameName(newFrameName)) {
        setNewFrameError('name must be PascalCase, e.g. "Testimonials"');
        return;
      }
      setNewFrameBusy(true);
      setNewFrameError(null);
      createFrame({ fileFolder: defaultFileFolder, name: newFrameName })
        .then(() => {
          setNewFrameOpen(false);
          setNewFrameName('');
        })
        .catch((err: unknown) => {
          setNewFrameError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setNewFrameBusy(false);
        });
    },
    [createFrame, defaultFileFolder, newFrameName],
  );

  return (
    <div ref={containerRef} className={className} style={{ ...CONTAINER_STYLE, ...style }}>
      <ScreenshotCacheContext.Provider value={screenshotCache}>
        <Tldraw shapeUtils={shapeUtils} components={MINIMAL_COMPONENTS} overrides={overrides} onMount={handleMount} />
      </ScreenshotCacheContext.Provider>
      {mountedEditor && (
        <EditModeLayer
          editor={mountedEditor}
          frames={frames}
          onCommitText={onCommitText}
          onReorderNode={onReorderNode}
          onCommitFreeDrag={onCommitFreeDrag}
          onBridgeConnectionChange={handleBridgeConnectionChange}
        />
      )}
      {mountedEditor && onZoomChange && <ZoomReporter editor={mountedEditor} onZoomChange={onZoomChange} />}
      {mountedEditor && (
        // FP-4a: this bridge now ALSO drives frictionless frame activation
        // (see its own doc) — mounted whenever the editor is up, not just
        // when the caller wants `onFrameSelect` reports.
        <FrameSelectionBridge editor={mountedEditor} frames={frames} onFrameSelect={onFrameSelect} />
      )}
      {onElementSelect && <ElementSelectionBridge onElementSelect={onElementSelect} />}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, fontFamily: 'system-ui, sans-serif' }}>
        {newFrameOpen ? (
          <form
            onSubmit={submitNewFrame}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: '#fff',
              border: '1px solid #d4d4d8',
              borderRadius: 6,
              padding: 10,
              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            }}
          >
            <input
              aria-label="New frame name"
              placeholder="Testimonials"
              value={newFrameName}
              onChange={(e) => setNewFrameName(e.target.value)}
              autoFocus
              style={{ fontSize: 13, padding: '4px 6px', border: '1px solid #d4d4d8', borderRadius: 4 }}
            />
            {newFrameError && <span style={{ fontSize: 12, color: '#dc2626' }}>{newFrameError}</span>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="submit" disabled={newFrameBusy} style={{ fontSize: 13 }}>
                {newFrameBusy ? 'Creating…' : 'Create'}
              </button>
              <button type="button" onClick={() => setNewFrameOpen(false)} style={{ fontSize: 13 }}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNewFrameOpen(true)}
            style={{
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid #d4d4d8',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            + New Frame
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * FP-1: reports tldraw's live zoom level to `onZoomChange` as a rounded
 * percentage, backing the zoom widget's `%` readout. A separate render-tree
 * leaf (sibling of `<Tldraw>`, same pattern `EditModeLayer` already uses)
 * rather than inline in `StudioCanvas` so `useValue`'s reactivity only
 * re-renders this tiny leaf on every camera tick, not the whole canvas.
 */
function ZoomReporter({
  editor,
  onZoomChange,
}: {
  editor: Editor;
  onZoomChange: (percent: number) => void;
}): null {
  const zoom = useValue('ccs-zoom-level', () => editor.getZoomLevel(), [editor]);
  React.useEffect(() => {
    onZoomChange(Math.round(zoom * 100));
  }, [zoom, onZoomChange]);
  return null;
}

/**
 * FP-1 (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 4): reports the
 * currently-selected frame (tldraw's native select tool + marquee already
 * do the actual selecting — see `StudioCanvasProps.onFrameSelect`'s doc) up
 * to the caller. Resolves to a record only when the selection is EXACTLY
 * one `ccs-frame` shape — an empty selection or a multi-frame marquee both
 * report `null`, matching "select one board" as the unambiguous case the
 * studio's Layers/Inspector can reflect.
 *
 * FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4, "frictionless
 * element select" bullet): this is ALSO where a frame becomes "active" —
 * hit-testable via the bridge, per the task brief — the MOMENT it's
 * selected, with NO prior double-click required. `CcsFrameShapeUtil.
 * onDoubleClick` (unchanged, still zooms + activates) remains the ONLY way
 * to enter edit mode with a camera snapshot for Esc-restore; a plain
 * single-click activation captures the CURRENT camera as `previousCamera`
 * too (so Esc still restores sensibly) but never animates a zoom — see
 * `edit-mode-layer.tsx`'s module doc for how the capture overlay itself
 * stays confined to just the active frame's screen box, which is what
 * makes clicking a DIFFERENT frame (or empty canvas) "just work" again
 * instead of being swallowed by an edit-mode overlay meant for another
 * frame entirely.
 */
function FrameSelectionBridge({
  editor,
  frames,
  onFrameSelect,
}: {
  editor: Editor;
  frames: CanvasFrameRecord[];
  onFrameSelect?: ((record: CanvasFrameRecord | null) => void) | undefined;
}): null {
  const selectedShapeIds = useValue('ccs-selected-shape-ids', () => editor.getSelectedShapeIds(), [editor]);
  const lastReportedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const frameShapeIds = selectedShapeIds.filter((id) => editor.getShape(id)?.type === CCS_FRAME_SHAPE_TYPE);
    const record =
      frameShapeIds.length === 1 ? (frames.find((f) => shapeIdForRecordId(f.id) === frameShapeIds[0]) ?? null) : null;
    const key = record?.id ?? null;

    // --- FP-4a frictionless activation (runs even if the caller doesn't
    // care about `onFrameSelect` reports) -------------------------------
    const store = useSelectionStore.getState();
    const activeShapeId = store.editModeFrame?.shapeId ?? null;
    const nextShapeId = record ? shapeIdForRecordId(record.id) : null;
    if (activeShapeId !== nextShapeId) {
      if (activeShapeId) store.exitEditMode();
      if (record && nextShapeId) {
        const camera = editor.getCamera();
        store.enterEditMode(
          { shapeId: nextShapeId, fileFolder: record.fileFolder, framePath: record.framePath },
          { x: camera.x, y: camera.y, z: camera.z },
        );
      }
    }

    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    onFrameSelect?.(record);
  }, [selectedShapeIds, frames, editor, onFrameSelect]);

  return null;
}

/**
 * FP-4a: reports the currently-selected ELEMENT (canvas-originated: a real
 * hit-test click, or a `text-edit`-adjacent selection set inside
 * `edit-mode-layer.tsx`) up to the caller — see
 * `StudioCanvasProps.onElementSelect`'s doc. Reads `useSelectionStore`
 * directly (module-level zustand, no React-context boundary needed) rather
 * than requiring `edit-mode-layer.tsx` to accept yet another prop; dedupes
 * on a composite key so it only fires when the reported selection actually
 * changes, mirroring `FrameSelectionBridge`'s own dedupe pattern.
 */
function ElementSelectionBridge({
  onElementSelect,
}: {
  onElementSelect: (selection: ElementSelection | null) => void;
}): null {
  const editModeFrame = useSelectionStore((s) => s.editModeFrame);
  const selectedUid = useSelectionStore((s) => s.selectedUids[0] ?? null);
  const lastReportedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const selection: ElementSelection | null =
      editModeFrame && selectedUid
        ? { fileFolder: editModeFrame.fileFolder, framePath: editModeFrame.framePath, uid: selectedUid }
        : null;
    const key = selection ? `${selection.fileFolder}::${selection.framePath}::${selection.uid}` : null;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    onElementSelect(selection);
  }, [editModeFrame, selectedUid, onElementSelect]);

  return null;
}
