import * as React from 'react';
import { Tldraw, createShapeId, useValue, type Editor, type TLComponents, type TLUiOverrides } from 'tldraw';
import type { ComputedStyleResult } from '@ccs/bridge';
import { frameNameFromPath } from './daemon-protocol.js';
import {
  CCS_FRAME_SHAPE_TYPE,
  CcsFrameShapeUtil,
  ScreenshotCacheContext,
  onFrameGeometryCommitted,
  type CcsFrameShape,
} from './frame-shape.js';
import {
  EditModeLayer,
  type CanvasCameraHandle,
  type CommitFreeDragRequest,
  type CommitTextRequest,
  type ReorderNodeRequest,
} from './edit-mode-layer.js';
import { useSelectionStore } from './selection-store.js';
import { shiftPanDelta } from './wheel-gesture.js';
import { iframeRectToPageBox } from './bridge-geometry.js';
import type { Box, CameraState } from './geometry.js';
import type { CanvasFrameRecord } from './project-wiring.js';
import { useStudioCanvasDaemon } from './use-studio-canvas-daemon.js';
import { NewFrameForm } from './NewFrameForm.js';
import { ElementSelectionBridge } from './element-selection-bridge.js';
import {
  CONTAINER_STYLE,
  ZOOM_TO_NODE_INSET_PX,
  ZOOM_TO_NODE_MAX_ZOOM,
  ZOOM_TO_NODE_TIMEOUT_MS,
  type SelectNodeRequest,
  type StudioCanvasHandle,
  type StudioCanvasProps,
} from './studio-canvas-types.js';

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) —
 * `TldrawEngineCanvas` is the tldraw-specific half of what used to be one
 * monolithic `StudioCanvas.tsx`, extracted MECHANICALLY (not rewritten):
 * every tldraw call, effect, and JSX element below is byte-for-byte the
 * same code that lived directly in `StudioCanvas`'s function body before
 * this split — the only things that changed are (1) the engine-agnostic
 * daemon/frames/create-frame/duplicate-frame/setFrameGeometry/
 * requestComputedStyle plumbing now comes from `useStudioCanvasDaemon`
 * instead of being inlined here, and (2) the "+ New Frame" JSX is now the
 * shared `NewFrameForm` component instead of an inline `<form>`. Both of
 * those are pure relocations with the daemon-write bodies replicated
 * exactly (see `use-studio-canvas-daemon.ts`'s own doc for the
 * `commitFrameGeometry` equivalence argument). The tldraw-backed path's
 * BEHAVIOR is unchanged: same `<Tldraw>` mount, same shape sync, same
 * zoom-to-fit-on-open guard, same phantom-frame guard (ADR-0015), same
 * shift/ctrl+wheel capture-phase fix, same `EditModeLayerBridge`/
 * `ZoomReporter`/`FrameSelectionBridge` leaves.
 */

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

export function TldrawEngineCanvas({
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
  const {
    frames,
    screenshotCache,
    createFrame,
    duplicateFrame,
    defaultFileFolder,
    setFrameGeometry,
    commitFrameGeometry,
    requestComputedStyle,
    handleBridgeConnectionChange,
  } = useStudioCanvasDaemon({ daemonUrl, onCreateFrame, onDuplicateFrame, onBridgeConnectionChange });

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

  const shapeUtils = React.useMemo(() => [CcsFrameShapeUtil], []);

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

  /** FIX 5 `StudioCanvasHandle.zoomToFrame` — see its own doc. Synchronous:
   * a board's bounds are already fully known from its `CanvasFrameRecord`,
   * no bridge round trip needed. */
  const zoomToFrameOnCanvas = React.useCallback((fileFolder: string, framePath: string) => {
    const editor = editorRef.current;
    const record = framesRef.current.find((r) => r.fileFolder === fileFolder && r.framePath === framePath);
    if (!editor || !record) return;
    editor.select(shapeIdForRecordId(record.id));
    editor.zoomToBounds({ x: record.x, y: record.y, w: record.w, h: record.h }, { animation: { duration: 200 } });
  }, []);

  /** FIX 5 `StudioCanvasHandle.zoomToNode` — see its own doc. Reuses
   * `selectNodeOnCanvas` verbatim for the select/activate half, then waits
   * (bounded by `ZOOM_TO_NODE_TIMEOUT_MS`) for `edit-mode-layer.tsx`'s own
   * selection-sync effect to backfill `selections[uid].rect` via its
   * `report-rects` bridge round trip (see that effect's doc) — the FIRST
   * fresh rect for this exact uid resolves the camera move; whichever
   * happens first (a rect arrives, or the timeout elapses) settles it
   * exactly once, never both. */
  const zoomToNodeOnCanvas = React.useCallback(
    (request: SelectNodeRequest) => {
      const editor = editorRef.current;
      const record = framesRef.current.find(
        (r) => r.fileFolder === request.fileFolder && r.framePath === request.framePath,
      );
      if (!editor || !record) return;

      selectNodeOnCanvas(request);

      const frameBox: Box = { x: record.x, y: record.y, w: record.w, h: record.h };
      let settled = false;
      const unsubscribe = useSelectionStore.subscribe((state) => {
        if (settled) return;
        const selection = state.selections[request.uid];
        if (!selection?.rect) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        // FIX 5 (AUDIT-FIXW1): clamp to `ZOOM_TO_NODE_MAX_ZOOM` + pad, so a
        // tiny element frames at a sane zoom instead of 800%+ (which also
        // kept the edit-mode overlay from ballooning over the panels).
        editor.zoomToBounds(iframeRectToPageBox(selection.rect, frameBox), {
          targetZoom: ZOOM_TO_NODE_MAX_ZOOM,
          inset: ZOOM_TO_NODE_INSET_PX,
          animation: { duration: 200 },
        });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        editor.zoomToBounds(frameBox, {
          targetZoom: ZOOM_TO_NODE_MAX_ZOOM,
          inset: ZOOM_TO_NODE_INSET_PX,
          animation: { duration: 200 },
        });
      }, ZOOM_TO_NODE_TIMEOUT_MS);
    },
    [selectNodeOnCanvas],
  );

  // --- FP-1: hand the caller a plain camera-control handle ---------------
  // (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 item 3 — the zoom widget +
  // keymap drive the camera through this, never a tldraw `Editor` directly,
  // per the §5.4 abstraction rule). Fires once editor mounts; `onReady`
  // itself is expected to be a stable callback (e.g. a `useState` setter) —
  // this effect intentionally does NOT re-fire on every render.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady || !onReady) return;
    const handle: StudioCanvasHandle = {
      zoomIn: () => editor.zoomIn(undefined, { animation: { duration: 120 } }),
      zoomOut: () => editor.zoomOut(undefined, { animation: { duration: 120 } }),
      resetZoom: () => editor.resetZoom(undefined, { animation: { duration: 200 } }),
      zoomToFit: () => editor.zoomToFit({ animation: { duration: 200 } }),
      zoomToSelection: () => editor.zoomToSelection({ animation: { duration: 200 } }),
      createFrame,
      selectFrame: selectFrameOnCanvas,
      selectNode: selectNodeOnCanvas,
      zoomToNode: zoomToNodeOnCanvas,
      zoomToFrame: zoomToFrameOnCanvas,
      setFrameGeometry,
      requestComputedStyle,
    };
    onReady(handle);
  }, [
    editorReady,
    onReady,
    createFrame,
    setFrameGeometry,
    selectFrameOnCanvas,
    selectNodeOnCanvas,
    zoomToNodeOnCanvas,
    zoomToFrameOnCanvas,
    requestComputedStyle,
  ]);

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
  //
  // FIX 4 (`.orchestrator/PENPOT-FIDELITY-SPEC.md` §5.9 canvas dogfood):
  // ctrl/meta+wheel over the canvas is the browser's OWN "zoom the whole
  // page" gesture — the browser only skips its native zoom when SOME
  // listener in the event's path calls `preventDefault()` on a
  // non-passive wheel listener. tldraw's own wheel handling does that for
  // ITS bubble-phase listener when it's actually reached, but this
  // package's capture-phase listener (registered on `containerRef`, an
  // ANCESTOR of tldraw's own container) runs first and — before this fix
  // — only ever called `preventDefault()` for the shift-pan case, leaving
  // a ctrl/meta+wheel event free to reach the browser's native zoom
  // handling in the gap before tldraw's own listener runs (and in any
  // case where tldraw's own handling doesn't end up owning the event,
  // e.g. while the edit-mode overlay in `edit-mode-layer.tsx` is the
  // actual event target — see that module's `handleWheel` doc). Fixed by
  // preventing the browser default HERE, unconditionally, for any
  // ctrl/meta-held wheel — WITHOUT `stopPropagation()`, so the event still
  // bubbles down to tldraw's (or the edit-mode overlay's) own zoom-at-
  // cursor handling, which is left completely untouched by this branch.
  React.useEffect(() => {
    const container = containerRef.current;
    const editor = editorRef.current;
    if (!container || !editor || !editorReady) return;

    function onWheelCapture(e: WheelEvent): void {
      if (e.ctrlKey || e.metaKey) {
        // Block ONLY the browser's native page-zoom default; let the event
        // keep propagating so tldraw's own zoom-at-cursor handling (or the
        // edit-mode overlay's `handleWheel`) still runs normally.
        e.preventDefault();
        return;
      }
      if (!e.shiftKey || e.altKey || e.deltaX !== 0) return;
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
  // Delegates the actual daemon write + `frames` update to
  // `useStudioCanvasDaemon`'s `commitFrameGeometry` — see that function's
  // own doc for why addressing it by `(fileFolder, framePath)` (both
  // already carried on the shape's own props) is exactly equivalent to the
  // original inline `sendSetGeometry`/`setFrames` pair this replaced.
  React.useEffect(() => {
    return onFrameGeometryCommitted((shape) => {
      commitFrameGeometry(shape.props.fileFolder, shape.props.framePath, {
        x: shape.x,
        y: shape.y,
        w: shape.props.w,
        h: shape.props.h,
      });
    });
  }, [commitFrameGeometry]);

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

  return (
    <div ref={containerRef} className={className} style={{ ...CONTAINER_STYLE, ...style }}>
      <ScreenshotCacheContext.Provider value={screenshotCache}>
        <Tldraw shapeUtils={shapeUtils} components={MINIMAL_COMPONENTS} overrides={overrides} onMount={handleMount} />
      </ScreenshotCacheContext.Provider>
      {mountedEditor && (
        <EditModeLayerBridge
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
      <NewFrameForm createFrame={createFrame} defaultFileFolder={defaultFileFolder} />
    </div>
  );
}

/**
 * Sub-workstream 2d-i adapter (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) —
 * `EditModeLayer` was narrowed from taking tldraw's `Editor` directly to a
 * small explicit `CanvasCameraHandle` interface (plus a plain `camera`
 * value prop and a `frameIdToShapeId` mapper), so it can eventually accept
 * either engine. This component is the tldraw-backed glue that makes that
 * narrowing a NO-OP for the current tldraw path: it wraps the real `Editor`
 * into `CanvasCameraHandle` (forwarding `setCamera`/`zoomToBounds`/
 * `dispatch({type:'wheel',...})` byte-identically to what `EditModeLayer`
 * used to call directly), supplies `camera` via `useValue` (tldraw's
 * signal->React bridge — `EditModeLayer` itself can no longer import this,
 * since it has zero tldraw imports now), and passes tldraw's own
 * `createShapeId` as `frameIdToShapeId` (matching `EditModeFrameRef.
 * shapeId`'s current "tldraw shape id" convention exactly, per
 * `selection-store.ts`'s doc).
 *
 * A separate render-tree leaf (same pattern `ZoomReporter`/
 * `FrameSelectionBridge` below already use) rather than inlined into
 * `TldrawEngineCanvas`'s own JSX, so `useValue`'s reactivity only
 * re-renders THIS leaf on every camera tick, not the whole canvas tree —
 * identical isolation rationale, identical mechanism (`useValue` was
 * previously called inside `EditModeLayer` itself, which already lived at
 * this same tree depth, so re-render scope is unchanged by moving it here).
 *
 * `CustomEngineCanvas.tsx` mounts an EQUIVALENT adapter (its own
 * `CustomEditModeLayerBridge`) wrapping `camera-store.ts`'s actions instead
 * — `EditModeLayer` itself needs no further changes for that swap.
 */
function EditModeLayerBridge({
  editor,
  frames,
  onCommitText,
  onReorderNode,
  onCommitFreeDrag,
  onBridgeConnectionChange,
}: {
  editor: Editor;
  frames: CanvasFrameRecord[];
  onCommitText: ((request: CommitTextRequest) => void) | undefined;
  onReorderNode: ((request: ReorderNodeRequest) => void) | undefined;
  onCommitFreeDrag: ((request: CommitFreeDragRequest) => void) | undefined;
  onBridgeConnectionChange:
    | ((requestComputedStyle: ((uid: string) => Promise<ComputedStyleResult>) | null) => void)
    | undefined;
}): React.ReactElement {
  const camera = useValue<CameraState>('ccs-edit-mode-camera', () => editor.getCamera(), [editor]);
  const cameraHandle = React.useMemo<CanvasCameraHandle>(
    () => ({
      setCamera: (nextCamera, opts) => editor.setCamera(nextCamera, opts),
      zoomToBounds: (box, opts) => editor.zoomToBounds(box, opts),
      dispatchWheel: (event) => editor.dispatch({ type: 'wheel', name: 'wheel', ...event }),
    }),
    [editor],
  );
  return (
    <EditModeLayer
      cameraHandle={cameraHandle}
      camera={camera}
      frameIdToShapeId={createShapeId}
      frames={frames}
      onCommitText={onCommitText}
      onReorderNode={onReorderNode}
      onCommitFreeDrag={onCommitFreeDrag}
      onBridgeConnectionChange={onBridgeConnectionChange}
    />
  );
}

/**
 * FP-1: reports tldraw's live zoom level to `onZoomChange` as a rounded
 * percentage, backing the zoom widget's `%` readout. A separate render-tree
 * leaf (sibling of `<Tldraw>`, same pattern `EditModeLayer` already uses)
 * rather than inline in `TldrawEngineCanvas` so `useValue`'s reactivity only
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
