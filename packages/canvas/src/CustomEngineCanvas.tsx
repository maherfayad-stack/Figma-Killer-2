import * as React from 'react';
import { frameNameFromPath } from './daemon-protocol.js';
import { Canvas, type CanvasFrame } from './Canvas.js';
import { useCameraStore, MIN_ZOOM, MAX_ZOOM } from './camera-store.js';
import { onFrameGeometryCommitted } from './frame-geometry-commit.js';
import { EditModeLayer, type CanvasCameraHandle } from './edit-mode-layer.js';
import { getRegisteredFrameIframe, onFrameIframeRegistryChange } from './custom-frame-iframe-registry.js';
import { useSelectionStore } from './selection-store.js';
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
 * `CustomEngineCanvas` assembles the NEW tldraw-free engine built in 2a/2b/
 * 2c/2d-i (`camera-store.ts` + `camera-gestures.ts` [inside `Canvas.tsx`] +
 * `selection-gestures.ts`/`resize-gestures.ts` [also inside `Canvas.tsx`] +
 * `frame-geometry-commit.ts` + `FrameShape.tsx` + `edit-mode-layer.tsx`)
 * into the SAME public contract `TldrawEngineCanvas` produces — same
 * `StudioCanvasHandle` methods, same `StudioCanvasProps` callbacks, same
 * observable behavior for pan/zoom/select/marquee/move/resize/edit-mode/
 * duplicate. Every genuinely engine-agnostic concern (daemon connection,
 * `frames` state, create/duplicate-frame, `setFrameGeometry`,
 * `requestComputedStyle`, the "+ New Frame" panel, the canvas-originated
 * element-selection bridge) comes from the SAME `useStudioCanvasDaemon`
 * hook / `NewFrameForm` / `ElementSelectionBridge` components
 * `TldrawEngineCanvas` uses — nothing here re-implements daemon plumbing.
 *
 * ## Simplifications relative to the tldraw path (disclosed, not oversights)
 *
 * - **No phantom-frame guard (ADR-0015).** That guard exists ONLY because
 *   tldraw's own native duplicate/copy/paste/undo machinery could create an
 *   untracked `ccs-frame` shape out of band from this package's own sync
 *   effect. The custom engine has no such second creation path: frames are
 *   created in exactly one place (`camera-store.ts`'s `setFrames`, driven
 *   only by the `frames` prop sync effect below) — there is no "native"
 *   creation route to guard against, so this whole bug class doesn't exist
 *   here. Omitted entirely, per the design doc's own instruction.
 * - **No `ScreenshotCacheContext` provider.** `FrameShape.tsx` (2b)
 *   deliberately never implemented screenshot capture (confirmed by reading
 *   its imports — no `screenshot-capture.ts`/`ScreenshotCacheContext`
 *   anywhere in that file), so providing the context here would have no
 *   consumer. `useStudioCanvasDaemon` still constructs the cache
 *   unconditionally (harmless, inert bookkeeping — see that hook's own
 *   doc) so this is a `CustomEngineCanvas`-side omission only. Real
 *   cross-origin screenshot capture (culled-frame thumbnails) remains a
 *   separately-tracked, unresolved concern in BOTH engines
 *   (`bridge-rasterization`, per `STATE.md`'s FIX-W1 carry-forward) — not
 *   something this workstream fixes.
 * - **No camera-move ANIMATION.** `camera-store.ts`'s `zoomToBounds`/
 *   `zoomIn`/etc. (2a) are instant, synchronous camera assignments — 2a/2b
 *   never built easing/tweening, so `StudioCanvasHandle` methods that pass
 *   `{ animation: { duration } }` to tldraw have no equivalent option to
 *   pass here (`FitBoundsOptions` has no such field). A disclosed gap for a
 *   later polish pass, not something introduced by this assembly.
 * - **`dispatchWheel` is a direct camera-store call, not a DOM re-dispatch.**
 *   See {@link CustomEditModeLayerBridge}'s own doc for the full derivation
 *   — this resolves the 2d-i-flagged "does the overlay need to nest inside
 *   Canvas.tsx's own container" question: it does NOT, because this
 *   adapter never needs the event to reach `Canvas.tsx`'s own listener at
 *   all. `EditModeLayer`'s capture overlay stays a SIBLING of `<Canvas>`
 *   (identical DOM shape to the tldraw path, zero changes to `Canvas.tsx`
 *   or `edit-mode-layer.tsx` needed).
 */

/** Local mirror of `Canvas.tsx`'s own private `clampZoom` — kept here too
 * (not exported from `camera-store.ts`) since `dispatchWheel`'s zoom
 * branch needs the exact same absolute-bounds clamp `Canvas.tsx`'s own
 * wheel handler applies via `classifyWheelGesture` + `zoomAtPoint`, and
 * this adapter deliberately bypasses `classifyWheelGesture` itself (see
 * module doc) rather than duplicating a DOM wheel event to run through it. */
function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Sub-workstream 2c/2d-ii: the custom engine has no tldraw-style
 * `shape:<id>` convention — `EditModeFrameRef.shapeId` (`selection-store.
 * ts`) is just the plain `CanvasFrameRecord.id` directly here, exactly the
 * "future custom-engine caller can pass plain identity" case
 * `edit-mode-layer.tsx`'s own `frameIdToShapeId` doc anticipated. */
function identity(id: string): string {
  return id;
}

export function CustomEngineCanvas({
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
    createFrame,
    duplicateFrame,
    defaultFileFolder,
    setFrameGeometry,
    commitFrameGeometry,
    requestComputedStyle,
    handleBridgeConnectionChange,
  } = useStudioCanvasDaemon({ daemonUrl, onCreateFrame, onDuplicateFrame, onBridgeConnectionChange });

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  /** `Canvas.tsx` (2b) already measures its OWN container via its own
   * internal `ResizeObserver` for its internal wheel-zoom/viewport-cull
   * math — it doesn't expose that size upward (no callback prop for it),
   * and adding one would mean touching `Canvas.tsx` (off-limits beyond a
   * small, additive, justified gap). This component needs the SAME
   * viewport size independently anyway (for `StudioCanvasHandle`'s
   * `zoomIn`/`zoomOut`/`resetZoom`/`zoomToFit`/`zoomToSelection`, and the
   * zoom-to-fit-on-open effect below), so it measures its OWN wrapper div
   * — which `<Canvas>` fills exactly (`width:100%,height:100%`, no
   * border/padding on either), so the two measurements are always
   * identical — with a second, independent `ResizeObserver` rather than
   * threading a new prop through `Canvas.tsx`. A plain ref (not React
   * state): every consumer below reads it imperatively at call/gesture
   * time, never during render. */
  const viewportSizeRef = React.useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      viewportSizeRef.current = { w: el.clientWidth, h: el.clientHeight };
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- CanvasFrameRecord[] -> Canvas.tsx's CanvasFrame[] prop -----------
  // `Canvas.tsx` only needs `{id,x,y,w,h,name,devServerUrl}` — a narrowing
  // projection, same reasoning `camera-store.ts`'s own `CameraFrame` doc
  // gives for why it doesn't import the full `CanvasFrameRecord` either.
  const canvasFrames = React.useMemo<CanvasFrame[]>(
    () => frames.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, name: r.name, devServerUrl: r.devServerUrl })),
    [frames],
  );

  // --- §6 blocker #3 equivalent: camera zoom-to-fit on project open -----
  // Mirrors `TldrawEngineCanvas`'s own zoom-to-fit-on-open effect exactly:
  // fires exactly ONCE per mount, the first time `frames` becomes
  // non-empty, never again after (so a later frame create/geometry edit
  // never yanks the camera out from under a user who has since panned).
  const hasZoomedToFitRef = React.useRef(false);
  React.useEffect(() => {
    if (hasZoomedToFitRef.current) return;
    if (frames.length === 0) return; // nothing synced into the camera store's frames map yet
    hasZoomedToFitRef.current = true;
    useCameraStore.getState().zoomToFit(viewportSizeRef.current);
  }, [frames]);

  // FP-4a: `frames` mirror readable at CALL TIME by the handle methods
  // below — same "ref kept current independently, since the handle is only
  // (re)handed to the caller rarely" reasoning `TldrawEngineCanvas` uses.
  const framesRef = React.useRef<CanvasFrameRecord[]>(frames);
  React.useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  /** FP-4a `StudioCanvasHandle.selectFrame` — see its own doc. Calls
   * `camera-store.ts`'s `select` (2a) instead of `editor.select`. */
  const selectFrameOnCanvas = React.useCallback((fileFolder: string, framePath: string) => {
    const record = framesRef.current.find((r) => r.fileFolder === fileFolder && r.framePath === framePath);
    if (!record) return;
    useCameraStore.getState().select([record.id]);
  }, []);

  /** FP-4a `StudioCanvasHandle.selectNode` — see its own doc. Identical
   * structure to `TldrawEngineCanvas`'s `selectNodeOnCanvas`: reuses
   * `selection-store.ts`'s `enterEditMode`/`setSelection` verbatim (that
   * store is already engine-agnostic), swapping only `editor.select` for
   * `camera-store.ts`'s `select` and `editor.getCamera()` for
   * `useCameraStore.getState().camera`. */
  const selectNodeOnCanvas = React.useCallback((request: SelectNodeRequest) => {
    const record = framesRef.current.find(
      (r) => r.fileFolder === request.fileFolder && r.framePath === request.framePath,
    );
    if (!record) return;
    useCameraStore.getState().select([record.id]);

    const store = useSelectionStore.getState();
    if (store.editModeFrame?.shapeId !== record.id) {
      const camera = useCameraStore.getState().camera;
      store.enterEditMode(
        { shapeId: record.id, fileFolder: record.fileFolder, framePath: record.framePath },
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

  /**
   * Phase 3b `Canvas.tsx`'s `onFrameDoubleClick` adapter — the counterpart
   * to `frame-shape.tsx`'s tldraw `CcsFrameShapeUtil.onDoubleClick`. `Canvas.
   * tsx` itself already snapped the camera to the frame's bounds before
   * calling this (that half is a pure camera-store concern it owns
   * directly); this callback supplies the other half `onDoubleClick`
   * originally did — recording `selection-store.ts`'s `editModeFrame` with
   * the daemon-facing `fileFolder`/`framePath` `Canvas.tsx` deliberately
   * doesn't carry (see `CanvasFrame`'s own doc). Calls `select`/
   * `enterEditMode` directly (byte-for-byte the same shape
   * `CcsFrameShapeUtil.onDoubleClick` uses) rather than relying solely on
   * `CameraFrameSelectionSync`'s below "frictionless single-click
   * activation" to do it implicitly — the first of a double-click's two
   * clicks already triggers that path today, so this is belt-and-suspenders
   * (matches tldraw's own real behavior too: its `onDoubleClick` calls
   * `enterEditMode` unconditionally even though `FrameSelectionBridge`'s
   * single-click activation usually already did), not a new mechanism.
   *
   * `previousCamera` is `Canvas.tsx`'s PRE-zoom snapshot (see its own doc on
   * `CanvasProps.onFrameDoubleClick`) — used here instead of re-reading
   * `useCameraStore.getState().camera`, which by the time this callback
   * runs already reflects the just-applied `zoomToBounds`. Recording the
   * POST-zoom camera as the edit-mode-exit restore target would make Esc a
   * no-op zoom-wise, permanently ratcheting the camera in tighter on every
   * double-click instead of ever zooming back out — a real bug caught
   * empirically (it didn't fail this gesture, only a LATER test trying to
   * reach a far-away frame from a camera that never zoomed back out).
   */
  const handleFrameDoubleClick = React.useCallback((frameId: string, previousCamera: CameraState) => {
    const record = framesRef.current.find((r) => r.id === frameId);
    if (!record) return;
    useCameraStore.getState().select([record.id]);
    useSelectionStore.getState().enterEditMode(
      { shapeId: record.id, fileFolder: record.fileFolder, framePath: record.framePath },
      { x: previousCamera.x, y: previousCamera.y, z: previousCamera.z },
    );
  }, []);

  /** FIX 5 `StudioCanvasHandle.zoomToFrame` — see its own doc. Synchronous,
   * same as the tldraw path: a board's bounds are already fully known from
   * its `CanvasFrameRecord`, no bridge round trip needed. */
  const zoomToFrameOnCanvas = React.useCallback((fileFolder: string, framePath: string) => {
    const record = framesRef.current.find((r) => r.fileFolder === fileFolder && r.framePath === framePath);
    if (!record) return;
    useCameraStore.getState().select([record.id]);
    useCameraStore
      .getState()
      .zoomToBounds({ x: record.x, y: record.y, w: record.w, h: record.h }, viewportSizeRef.current);
  }, []);

  /** FIX 5 `StudioCanvasHandle.zoomToNode` — see its own doc. Byte-for-byte
   * the same race logic as `TldrawEngineCanvas`'s `zoomToNodeOnCanvas`
   * (same `ZOOM_TO_NODE_MAX_ZOOM`/`ZOOM_TO_NODE_INSET_PX`/
   * `ZOOM_TO_NODE_TIMEOUT_MS` constants, same "first rect wins, else
   * fall back to the frame's own bounds on timeout" resolution) — only the
   * final `editor.zoomToBounds(...)` call becomes
   * `camera-store.getState().zoomToBounds(...)`, exactly as the design
   * note anticipated. */
  const zoomToNodeOnCanvas = React.useCallback(
    (request: SelectNodeRequest) => {
      const record = framesRef.current.find(
        (r) => r.fileFolder === request.fileFolder && r.framePath === request.framePath,
      );
      if (!record) return;

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
        useCameraStore
          .getState()
          .zoomToBounds(iframeRectToPageBox(selection.rect, frameBox), viewportSizeRef.current, {
            targetZoom: ZOOM_TO_NODE_MAX_ZOOM,
            inset: ZOOM_TO_NODE_INSET_PX,
          });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        useCameraStore.getState().zoomToBounds(frameBox, viewportSizeRef.current, {
          targetZoom: ZOOM_TO_NODE_MAX_ZOOM,
          inset: ZOOM_TO_NODE_INSET_PX,
        });
      }, ZOOM_TO_NODE_TIMEOUT_MS);
    },
    [selectNodeOnCanvas],
  );

  // --- FP-1: hand the caller the SAME plain camera-control handle shape
  // `TldrawEngineCanvas` produces --------------------------------------
  React.useEffect(() => {
    if (!onReady) return;
    const handle: StudioCanvasHandle = {
      zoomIn: () => useCameraStore.getState().zoomIn(viewportSizeRef.current),
      zoomOut: () => useCameraStore.getState().zoomOut(viewportSizeRef.current),
      resetZoom: () => useCameraStore.getState().resetZoom(viewportSizeRef.current),
      zoomToFit: () => useCameraStore.getState().zoomToFit(viewportSizeRef.current),
      zoomToSelection: () => useCameraStore.getState().zoomToSelection(viewportSizeRef.current),
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
    onReady,
    createFrame,
    setFrameGeometry,
    selectFrameOnCanvas,
    selectNodeOnCanvas,
    zoomToNodeOnCanvas,
    zoomToFrameOnCanvas,
    requestComputedStyle,
  ]);

  // --- drag/resize -> debounced .studio/canvas.json write (ADR-0013) ---
  // The custom engine's own "gesture finished" pub-sub (`frame-geometry-
  // commit.ts`, 2c) fires `{id,x,y,w,h}` where `id` IS the plain
  // `CanvasFrameRecord.id` (no shape-id indirection to undo, unlike the
  // tldraw path) — one `frames.find` recovers `(fileFolder, framePath)` for
  // `commitFrameGeometry`'s shared signature.
  React.useEffect(() => {
    return onFrameGeometryCommitted((geometry) => {
      const record = framesRef.current.find((r) => r.id === geometry.id);
      if (!record) return;
      commitFrameGeometry(record.fileFolder, record.framePath, {
        x: geometry.x,
        y: geometry.y,
        w: geometry.w,
        h: geometry.h,
      });
    });
  }, [commitFrameGeometry]);

  // --- Cmd/Ctrl+D duplicate -------------------------------------------
  // ADR-0015's tldraw-specific problem (native duplicate/paste creating a
  // fileless phantom shape) doesn't exist here — the custom engine has no
  // native keyboard-shortcut subsystem to intercept at all (unlike
  // tldraw's `TLUiOverrides.actions.duplicate`), so this is just a plain
  // `keydown` listener that, for each currently-selected frame, issues the
  // same real `duplicate-frame` daemon request `TldrawEngineCanvas`'s
  // override does. `e.preventDefault()` unconditionally on Cmd/Ctrl+D
  // (even with an empty selection) mirrors tldraw's own keyboard-shortcuts
  // subsystem, which always intercepts that combination regardless of
  // whether anything is selected.
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      const selectedIds = Array.from(useCameraStore.getState().selectedIds);
      for (const id of selectedIds) {
        const record = framesRef.current.find((r) => r.id === id);
        if (!record) continue;
        const sourceName = frameNameFromPath(record.framePath);
        if (!sourceName) continue;
        duplicateFrame({ fileFolder: record.fileFolder, sourceName }).catch((err: unknown) => {
          // No toast system yet (matches TldrawEngineCanvas's own
          // console-only failure surfacing).
          console.error('@ccs/canvas: duplicate-frame failed', err);
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [duplicateFrame]);

  return (
    <div ref={containerRef} className={className} style={{ ...CONTAINER_STYLE, ...style }}>
      <Canvas
        frames={canvasFrames}
        onFrameDoubleClick={handleFrameDoubleClick}
        style={{ width: '100%', height: '100%' }}
      />
      <CustomEditModeLayerBridge
        frames={frames}
        containerRef={containerRef}
        viewportSizeRef={viewportSizeRef}
        onCommitText={onCommitText}
        onReorderNode={onReorderNode}
        onCommitFreeDrag={onCommitFreeDrag}
        onBridgeConnectionChange={handleBridgeConnectionChange}
      />
      {onZoomChange && <CameraZoomReporter onZoomChange={onZoomChange} />}
      <CameraFrameSelectionSync frames={frames} onFrameSelect={onFrameSelect} />
      {onElementSelect && <ElementSelectionBridge onElementSelect={onElementSelect} />}
      <NewFrameForm createFrame={createFrame} defaultFileFolder={defaultFileFolder} />
    </div>
  );
}

/**
 * Sub-workstream 2d-ii's custom-engine `EditModeLayer` adapter — the
 * counterpart to `TldrawEngineCanvas.tsx`'s `EditModeLayerBridge`, wrapping
 * `camera-store.ts`'s actions instead of a tldraw `Editor`. Same isolation
 * rationale (a separate render-tree leaf so the `camera` zustand
 * subscription only re-renders THIS leaf on every camera tick, not the
 * whole `CustomEngineCanvas` tree).
 *
 * ## Resolving the 2d-i `dispatchWheel`/overlay-nesting question
 * `edit-mode-layer.tsx`'s own doc flagged this open: does the custom
 * engine's overlay need to nest INSIDE `Canvas.tsx`'s own container (to let
 * a re-dispatched native wheel event bubble into `Canvas.tsx`'s listener),
 * or can `dispatchWheel` just call `camera-store.ts`'s pan/zoom actions
 * directly? This adapter takes the SECOND path — no DOM re-dispatch at
 * all, and the overlay STAYS A SIBLING of `<Canvas>` (identical DOM shape
 * to the tldraw path, zero changes to `Canvas.tsx`/`edit-mode-layer.tsx`
 * needed, the lower-risk choice per the task brief).
 *
 * The event `edit-mode-layer.tsx`'s `handleWheel` builds is NOT a raw wheel
 * event — it's already pre-computed into tldraw's `{point,delta}`
 * convention (see that file's own doc): `delta.z` carries the ctrl/alt/
 * meta-modified zoom amount (already negated once: `delta.z = -deltaZ`
 * where `deltaZ` is the SAME `clamp(deltaY,10)*sign(deltaY)/100` value
 * `camera-gestures.ts`'s `classifyWheelGesture` computes for its own
 * zoom branch), `delta.x`/`delta.y` carry the already-negated pan delta
 * otherwise. Algebraically inverting `classifyWheelGesture`'s own
 * `factor = 1 - deltaZ` with `deltaZ = -delta.z` gives `factor = 1 +
 * delta.z` — this adapter reproduces exactly that multiplicative zoom
 * (`camera.z * factor`, clamped to `[MIN_ZOOM,MAX_ZOOM]`, applied via
 * `zoomAtPoint`), and a direct `pan(delta.x, delta.y)` for the non-zoom
 * case (already in the right sign convention, no further negation needed).
 * `event.point` carries RAW `clientX/clientY` (tldraw's own convention,
 * verified from `edit-mode-layer.tsx`'s `handleWheel`) — converted to
 * THIS container-relative screen space via `containerRef`'s own bounding
 * rect before calling `zoomAtPoint`, matching `Canvas.tsx`'s own wheel
 * handler's identical rect-relative conversion.
 *
 * Disclosed, inherited simplification (NOT introduced by this adapter):
 * `camera-gestures.ts`'s own `classifyWheelGesture` already simplifies a
 * plain (no-modifier) wheel to VERTICAL-ONLY pan (flagged in its own doc as
 * a Phase-3 parity item, since tldraw's real fallthrough pans both axes on
 * a diagonal trackpad scroll) — `edit-mode-layer.tsx`'s `handleWheel`,
 * unchanged, forwards BOTH axes unconditionally, so a plain wheel INSIDE
 * edit mode pans diagonally while a plain wheel OUTSIDE edit mode (via
 * `Canvas.tsx`'s own listener) only pans vertically. This exact
 * inconsistency already exists (in the opposite direction) between
 * tldraw's real behavior and `classifyWheelGesture`'s simplification — not
 * a new gap this pass introduces, and out of scope to reconcile here (same
 * Phase-3 parity-verification bucket as the rest of `camera-gestures.ts`'s
 * disclosed assumptions).
 */
function CustomEditModeLayerBridge({
  frames,
  containerRef,
  viewportSizeRef,
  onCommitText,
  onReorderNode,
  onCommitFreeDrag,
  onBridgeConnectionChange,
}: {
  frames: CanvasFrameRecord[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewportSizeRef: React.RefObject<{ w: number; h: number }>;
  onCommitText: Parameters<typeof EditModeLayer>[0]['onCommitText'];
  onReorderNode: Parameters<typeof EditModeLayer>[0]['onReorderNode'];
  onCommitFreeDrag: Parameters<typeof EditModeLayer>[0]['onCommitFreeDrag'];
  onBridgeConnectionChange: Parameters<typeof EditModeLayer>[0]['onBridgeConnectionChange'];
}): React.ReactElement {
  const camera = useCameraStore((s) => s.camera);
  const cameraHandle = React.useMemo<CanvasCameraHandle>(
    () => ({
      setCamera: (nextCamera) => useCameraStore.getState().setCamera(nextCamera),
      // `CanvasCameraHandle.zoomToBounds`'s `opts` shape (`{animation?}`) is
      // tldraw's own vocabulary (see that interface's doc) — `camera-
      // store.ts`'s `zoomToBounds` takes `FitBoundsOptions`
      // (`{targetZoom?,inset?}`) instead, an unrelated shape (2a never
      // built camera-move animation — see this file's module doc's
      // disclosed-simplifications list), so `opts` is intentionally NOT
      // forwarded here; `EditModeLayer`'s own call sites only ever pass
      // `{animation:{duration}}`, nothing this adapter needs to read.
      zoomToBounds: (box) => useCameraStore.getState().zoomToBounds(box, viewportSizeRef.current),
      dispatchWheel: (event) => {
        const store = useCameraStore.getState();
        const hasZoomModifier = event.ctrlKey || event.altKey || event.metaKey;
        if (hasZoomModifier) {
          const rect = containerRef.current?.getBoundingClientRect();
          const screenPoint = rect
            ? { x: event.point.x - rect.left, y: event.point.y - rect.top }
            : { x: event.point.x, y: event.point.y };
          const factor = 1 + event.delta.z;
          const newZoom = clampZoom(store.camera.z * factor);
          store.zoomAtPoint(newZoom, screenPoint, viewportSizeRef.current);
        } else {
          store.pan(event.delta.x, event.delta.y);
        }
      },
    }),
    [containerRef, viewportSizeRef],
  );
  return (
    <EditModeLayer
      cameraHandle={cameraHandle}
      camera={camera}
      frameIdToShapeId={identity}
      frames={frames}
      onCommitText={onCommitText}
      onReorderNode={onReorderNode}
      onCommitFreeDrag={onCommitFreeDrag}
      onBridgeConnectionChange={onBridgeConnectionChange}
      // Phase 3b fix: without these, `EditModeLayer` falls back to its
      // default (the tldraw-only registry in `frame-shape.tsx`), which
      // `FrameShape.tsx` never populates — see `custom-frame-iframe-
      // registry.ts`'s own module doc for the full story.
      getFrameIframe={getRegisteredFrameIframe}
      onFrameIframeChange={onFrameIframeRegistryChange}
    />
  );
}

/** FP-1 custom-engine counterpart of `TldrawEngineCanvas.tsx`'s
 * `ZoomReporter` — reports `camera-store.ts`'s live zoom level to
 * `onZoomChange`, isolated into its own leaf so its zustand subscription
 * doesn't re-render the whole `CustomEngineCanvas` tree on every camera
 * tick. */
function CameraZoomReporter({ onZoomChange }: { onZoomChange: (percent: number) => void }): null {
  const zoom = useCameraStore((s) => s.camera.z);
  React.useEffect(() => {
    onZoomChange(Math.round(zoom * 100));
  }, [zoom, onZoomChange]);
  return null;
}

/**
 * FP-1/FP-4a custom-engine counterpart of `TldrawEngineCanvas.tsx`'s
 * `FrameSelectionBridge` — reports the currently-selected frame (resolved
 * to a record only when the selection is EXACTLY one frame, same
 * "unambiguous single-board select" contract) up to the caller, and drives
 * the SAME frictionless single-click edit-mode activation (`selection-
 * store.ts`'s `enterEditMode`/`exitEditMode`) the instant `camera-store.
 * ts`'s `selectedIds` resolves to one frame — no double-click required,
 * matching the tldraw path's behavior exactly (its own `FrameSelectionBridge`
 * already activates on a plain single click too; double-click is only a
 * secondary zoom/text-edit affordance inside `edit-mode-layer.tsx`, which is
 * unchanged and reused verbatim by both engines).
 */
function CameraFrameSelectionSync({
  frames,
  onFrameSelect,
}: {
  frames: CanvasFrameRecord[];
  onFrameSelect: ((record: CanvasFrameRecord | null) => void) | undefined;
}): null {
  const selectedIds = useCameraStore((s) => s.selectedIds);
  const lastReportedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const ids = Array.from(selectedIds);
    const record = ids.length === 1 ? frames.find((f) => f.id === ids[0]) ?? null : null;
    const key = record?.id ?? null;

    const store = useSelectionStore.getState();
    const activeId = store.editModeFrame?.shapeId ?? null;
    const nextId = record ? record.id : null;
    if (activeId !== nextId) {
      if (activeId) store.exitEditMode();
      if (record && nextId) {
        const camera = useCameraStore.getState().camera;
        store.enterEditMode(
          { shapeId: nextId, fileFolder: record.fileFolder, framePath: record.framePath },
          { x: camera.x, y: camera.y, z: camera.z },
        );
      }
    }

    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    onFrameSelect?.(record);
  }, [selectedIds, frames, onFrameSelect]);

  return null;
}
