import * as React from 'react';
import { createShapeId, useValue, type Editor } from 'tldraw';
import type { HitInfo, TextEditExit } from '@ccs/bridge';
import type { CanvasFrameRecord } from './project-wiring.js';
import { getRegisteredFrameIframe, onFrameIframeRegistryChange } from './frame-shape.js';
import { useSelectionStore, onUidRemap, type HoverState, type SelectionState } from './selection-store.js';
import { connectBridge, type BridgeConnection } from './bridge-client.js';
import { iframeRectToScreenBox, screenPointToIframePoint } from './bridge-geometry.js';
import { boxToScreenBox, type Box, type CameraState } from './geometry.js';

/** FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4): reported up to
 * `StudioCanvas`/the caller when an in-place text edit commits (Enter or
 * blur with real text; Esc-cancel never reaches this — the bridge restores
 * the original text itself and reports `committed:false`, which this layer
 * simply discards, see `handleTextEditExit` below). The CALLER (studio
 * chrome) owns emitting the actual `set-text` `CanvasOp` — this package
 * never sends ops itself (it has no `sendOp`/daemon-ops connection; only
 * `@ccs/canvas`'s own geometry/create-frame control-ws, per
 * `StudioCanvas.tsx`'s module doc), matching this task's brief: "the bridge
 * reports the committed text back to the parent, which sends the existing
 * `set-text` op over the daemon control-ws". */
export interface CommitTextRequest {
  fileFolder: string;
  framePath: string;
  uid: string;
  text: string;
}

/** Display name for a hit-test result — see `HoverState.name`'s doc for
 * why this can't be derived from `uid` alone. */
function nameFromHit(hit: HitInfo): string {
  return hit.component ?? hit.breadcrumb.at(-1)?.name ?? hit.uid;
}

/**
 * `EditModeLayer` — the P2/WS-B selection overlay + edit-mode input capture
 * (playbook §4/P2, ADR-0016 WS-B split). Mounted ONCE at the top of
 * `StudioCanvas`, as a sibling of `<Tldraw>` (not nested inside any one
 * `ccs-frame` shape's own transformed DOM subtree) so its hover/selection
 * boxes are positioned with the EXPLICIT, unit-tested `bridge-geometry.ts`
 * transform (iframe -> page -> screen, camera-aware) rather than by relying
 * on tldraw's own per-shape CSS transform — this is what makes "draw
 * overlay in screen space" (playbook wording) independently testable and
 * keeps the math in one pure, non-React module.
 *
 * ## Why a capture div, not the iframe itself, drives hit-testing
 * The playbook prompt says the edit-mode frame's iframe gets
 * `pointer-events: auto` (implemented in `frame-shape.tsx`) and mouse-move
 * "over frame" triggers `hit-test`. In a real browser this can't literally
 * mean "the studio's own `mousemove` listener fires while the cursor is
 * over the iframe": the file-app dev server is a DIFFERENT origin
 * (different port) than the studio, so once the pointer is over the
 * iframe, the browser dispatches native input events to THAT document, not
 * this one — no amount of `pointer-events` CSS on the parent changes that,
 * and `sandbox="allow-same-origin"` does not grant the PARENT synchronous
 * access to a genuinely cross-origin iframe's DOM (only postMessage
 * crosses that boundary, which is exactly what the FROZEN bridge protocol
 * is for). So the only way for the studio to know the pointer's (x,y) at
 * all is to capture the mouse event on the STUDIO side. This component does
 * that with one transparent, `pointer-events:auto` div, converts the
 * event's own `offsetX`/`offsetY` through `screenPointToIframePoint`, and
 * sends the resulting iframe-space point as a `hit-test` request.
 *
 * FP-4a UPDATE (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4): P2 sized
 * this div `inset:0` of the whole canvas container. FP-4a resizes/positions
 * it to exactly the ACTIVE frame's own on-screen box instead (`geometry.ts`'s
 * `boxToScreenBox`) — a P2 whole-canvas overlay would swallow a click meant
 * to select a DIFFERENT frame (or empty canvas) the instant one frame
 * became active, which is fatal to "frictionless" multi-frame select
 * (`StudioCanvas.tsx`'s `FrameSelectionBridge` now activates a frame on a
 * plain single click, no double-click gate — see that file's doc): a click
 * outside the active frame's box now falls straight through to tldraw's own
 * shape hit-testing underneath, exactly like before any frame was ever
 * activated. The FROZEN bridge protocol/geometry math is unchanged; only
 * this div's CSS position/size and the resulting `offsetX/offsetY` ->
 * container-relative-screen-point translation moved.
 *
 * P2's iframe `pointer-events:auto`-while-inert reservation (flagged in the
 * original worker report as "wired and ready for a future phase that needs
 * the iframe to receive events directly, e.g. in-place text editing") is
 * FP-4a's `editingUid` state below: while a text edit is in progress this
 * overlay drops to `pointer-events:none` so the iframe (already `auto`
 * whenever it's the edit-mode frame) receives real clicks/keystrokes
 * directly — the only way `contentEditable` can actually work cross-origin.
 */

export interface EditModeLayerProps {
  editor: Editor;
  frames: CanvasFrameRecord[];
  /** FP-4a: called once per committed in-place text edit (never for a
   * cancelled one) — see {@link CommitTextRequest}'s doc. Optional so
   * existing callers/tests that don't care about text-editing keep
   * compiling unchanged (additive prop). */
  onCommitText?: ((request: CommitTextRequest) => void) | undefined;
}

function exitEditModeAndRestoreCamera(editor: Editor): void {
  // `setCameraOptions({isLocked:false})` is deliberately NOT called here —
  // entry never locks the camera (see `CcsFrameShapeUtil.onDoubleClick`'s
  // doc comment for why); this only restores whatever camera was active
  // before edit mode was entered.
  const result = useSelectionStore.getState().exitEditMode();
  if (result?.previousCamera) {
    editor.setCamera(result.previousCamera, { animation: { duration: 200 } });
  }
}

function frameBoxOf(record: CanvasFrameRecord): Box {
  return { x: record.x, y: record.y, w: record.w, h: record.h };
}

export function EditModeLayer({ editor, frames, onCommitText }: EditModeLayerProps): React.ReactElement {
  const editModeFrame = useSelectionStore((s) => s.editModeFrame);
  const hover = useSelectionStore((s) => s.hover);
  const selectedUids = useSelectionStore((s) => s.selectedUids);
  const selections = useSelectionStore((s) => s.selections);
  const breadcrumb = useSelectionStore((s) => s.breadcrumb);

  const camera = useValue<CameraState>('ccs-edit-mode-camera', () => editor.getCamera(), [editor]);

  // FP-4a: `uid` of the node currently being in-place-edited (contentEditable
  // inside the iframe), or `null`. While non-null the capture overlay stops
  // intercepting pointer events (see the overlay's `pointerEvents` below) so
  // the REAL click/keyboard input the browser dispatches to the (cross-
  // origin) iframe reaches its own document directly — this is the "iframe
  // pointer-events:auto wired-but-inert, reserved for P3/in-place text edit"
  // reservation AUDIT-5 flagged, now actually used: the iframe already has
  // `pointer-events:auto` while it's the edit-mode frame (`frame-shape.tsx`);
  // this layer just needs to get OUT OF THE WAY of it during an edit.
  const [editingUid, setEditingUid] = React.useState<string | null>(null);

  // Re-render whenever a frame's iframe (re)registers/unregisters (e.g. the
  // edit-mode frame flips live<->screenshot, or first mounts its iframe
  // after entering edit mode before the iframe has painted) so this layer
  // picks up the DOM node to open a bridge connection on.
  const [, bumpRegistryTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => onFrameIframeRegistryChange(bumpRegistryTick), []);

  const editModeRecord = React.useMemo(() => {
    if (!editModeFrame) return null;
    return frames.find((r) => createShapeId(r.id) === editModeFrame.shapeId) ?? null;
  }, [frames, editModeFrame]);

  const frameBox = editModeRecord ? frameBoxOf(editModeRecord) : null;
  const iframeEl = editModeFrame ? getRegisteredFrameIframe(editModeFrame.shapeId) : null;

  // FP-4a: the capture overlay is now sized/positioned to exactly the
  // active frame's on-screen box (see the render return's doc for why) —
  // computed once per render here so both the pointer handlers below (which
  // must translate the overlay-local `offsetX/offsetY` back to
  // container-relative screen coordinates before calling
  // `screenPointToIframePoint`) and the JSX use the exact same value.
  const overlayScreenBox = frameBox ? boxToScreenBox(camera, frameBox) : null;

  // FP-4a: the bridge's autonomous exit report (Enter/blur commit, or Esc
  // cancel — see `text-edit.ts`'s doc). Reads `editModeFrame` fresh via
  // `.getState()` (not the outer closure) so this is correct even if it
  // fires from a connection opened several renders ago (same defensive
  // pattern the pre-existing `onReady`/uid-remap handlers already use).
  const handleTextEditExit = React.useCallback(
    (exit: TextEditExit) => {
      setEditingUid((current) => (current === exit.uid ? null : current));
      if (!exit.committed || exit.text === null) return; // Esc-cancel — bridge already restored the DOM; no op.
      const frame = useSelectionStore.getState().editModeFrame;
      if (!frame) return;
      onCommitText?.({ fileFolder: frame.fileFolder, framePath: frame.framePath, uid: exit.uid, text: exit.text });
    },
    [onCommitText],
  );

  // --- bridge connection lifecycle: one connection per edit-mode iframe ---
  const connectionRef = React.useRef<BridgeConnection | null>(null);
  const connectedWindowRef = React.useRef<Window | null>(null);

  React.useEffect(() => {
    const win = iframeEl?.contentWindow ?? null;
    if (connectedWindowRef.current === win) return;
    connectionRef.current?.dispose();
    connectionRef.current = null;
    connectedWindowRef.current = win;
    // A reconnect (new/reloaded iframe) invalidates any in-progress edit's
    // DOM state — drop back to hit-test-capture mode rather than leaving
    // the overlay permanently pointer-events:none.
    setEditingUid(null);
    if (!win) return;

    const connection = connectBridge({
      iframeWindow: win,
      onRectsUpdate: (rects) => {
        for (const [uid, rect] of Object.entries(rects)) {
          useSelectionStore.getState().updateSelectionRect(uid, rect);
        }
      },
      onReady: () => {
        // Bridge (re)installed (initial load, or a full iframe reload that
        // dropped the previous subscription) — re-subscribe to whatever's
        // currently selected so selection survives a hard HMR reload, not
        // just the in-place-module-swap case (playbook §4/P2 pitfall).
        const currentSelection = useSelectionStore.getState().selectedUids;
        if (currentSelection.length > 0) {
          connectionRef.current?.subscribeRects(currentSelection);
          connectionRef.current?.setSelection(currentSelection);
        }
      },
      onTextEditExit: handleTextEditExit,
    });
    connectionRef.current = connection;

    return () => {
      connection.dispose();
      if (connectedWindowRef.current === win) connectedWindowRef.current = null;
    };
  }, [iframeEl, handleTextEditExit]);

  // FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4, two-way sync
  // bullet): keeps the bridge's live-rect subscription + in-iframe
  // highlight in sync with `selectedUids`, regardless of WHERE the
  // selection came from. A canvas-originated click (`handleClick`/
  // `handleDoubleClick` above) already sends `subscribeRects`/`setSelection`
  // inline — redundant-but-harmless here for that case. What this effect
  // makes possible is an EXTERNALLY-driven selection (`StudioCanvas.tsx`'s
  // `selectNode` handle method, called from a Layers-panel row click): it
  // starts with `rect:null` (no hit-test ever ran for it) and no inline
  // bridge call — this is the only place that subscribes/backfills its rect
  // via `report-rects`, closing the AUDIT-FP1 carry-forward's sibling gap
  // (Layers -> canvas highlight, not just Layers -> tldraw selection).
  React.useEffect(() => {
    const connection = connectionRef.current;
    if (!connection || selectedUids.length === 0) return;
    connection.subscribeRects(selectedUids);
    connection.setSelection(selectedUids);
    const uidsMissingRect = selectedUids.filter((uid) => !selections[uid]?.rect);
    if (uidsMissingRect.length === 0) return;
    void connection.reportRects(uidsMissingRect).then((rects) => {
      for (const uid of uidsMissingRect) {
        const rect = rects[uid];
        if (rect !== undefined) useSelectionStore.getState().updateSelectionRect(uid, rect);
      }
    });
  }, [selectedUids, selections, iframeEl]);

  // --- Esc exits edit mode (camera unlocks + restores) --------------------
  React.useEffect(() => {
    if (!editModeFrame) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') exitEditModeAndRestoreCamera(editor);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editModeFrame, editor]);

  // --- robustness: if the edit-mode frame's shape vanishes from under us
  // (e.g. deleted while editing), don't get stuck in a locked-camera limbo.
  React.useEffect(() => {
    if (editModeFrame && !editModeRecord) exitEditModeAndRestoreCamera(editor);
  }, [editModeFrame, editModeRecord, editor]);

  // --- FROZEN uid-remap DaemonEvent handler (playbook §4/P2 pitfall,
  // ADR-0016: "unmapped-but-present uid -> keep; absent -> mark detached").
  // The daemon computing/emitting REAL remaps on structural edits is P3's
  // job (no producer exists yet in this tree) — this wires the consumer
  // side end-to-end and is exercised in e2e via `daemon.broadcast(...)`
  // synthesizing the frozen event shape directly. See worker report for
  // this exact boundary.
  React.useEffect(() => {
    return onUidRemap((event) => {
      const before = useSelectionStore.getState();
      if (!before.editModeFrame || before.editModeFrame.framePath !== event.file) return;
      before.applyUidRemap(event.map);

      const after = useSelectionStore.getState();
      const uidsToVerify = after.selectedUids;
      const connection = connectionRef.current;
      if (uidsToVerify.length === 0 || !connection) return;

      connection.subscribeRects(uidsToVerify);
      void connection.reportRects(uidsToVerify).then((rects) => {
        for (const uid of uidsToVerify) {
          const rect = rects[uid];
          if (rect === undefined || rect === null) {
            useSelectionStore.getState().markSelectionDetached(uid);
          } else {
            useSelectionStore.getState().updateSelectionRect(uid, rect);
          }
        }
      });
    });
  }, []);

  // --- input capture (see module doc for why this, not the iframe itself) -
  const hoverRequestSeq = React.useRef(0);

  // Overlay-local `offsetX`/`offsetY` (relative to the resized-to-the-frame
  // capture div's own top-left, see the render return's doc) -> the
  // container-relative screen point `screenPointToIframePoint` expects —
  // add back the overlay's own screen-space offset (`overlayScreenBox.x/y`).
  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const connection = connectionRef.current;
      if (!frameBox || !connection || !overlayScreenBox) return;
      const screenPoint = {
        x: e.nativeEvent.offsetX + overlayScreenBox.x,
        y: e.nativeEvent.offsetY + overlayScreenBox.y,
      };
      const point = screenPointToIframePoint(camera, frameBox, screenPoint);
      const seq = (hoverRequestSeq.current += 1);
      void connection.hitTest(point.x, point.y).then((hit) => {
        if (hoverRequestSeq.current !== seq) return; // superseded by a newer move
        const nextHover: HoverState | null = hit
          ? { uid: hit.uid, rect: hit.rect, dynamic: hit.dynamic, component: hit.component, name: nameFromHit(hit) }
          : null;
        useSelectionStore.getState().setHover(nextHover);
        connection.setHover(hit?.uid ?? null);
      });
    },
    [frameBox, camera, overlayScreenBox],
  );

  const handleMouseLeave = React.useCallback(() => {
    useSelectionStore.getState().setHover(null);
    connectionRef.current?.setHover(null);
  }, []);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const connection = connectionRef.current;
      if (!frameBox || !connection || !overlayScreenBox) return;
      const point = screenPointToIframePoint(camera, frameBox, {
        x: e.nativeEvent.offsetX + overlayScreenBox.x,
        y: e.nativeEvent.offsetY + overlayScreenBox.y,
      });
      void connection.hitTest(point.x, point.y).then((hit) => {
        if (hit) {
          useSelectionStore.getState().setSelection({
            uid: hit.uid,
            rect: hit.rect,
            dynamic: hit.dynamic,
            component: hit.component,
            breadcrumb: hit.breadcrumb,
          });
          connection.subscribeRects([hit.uid]);
          connection.setSelection([hit.uid]);
        } else {
          useSelectionStore.getState().setSelection(null);
          connection.unsubscribeRects();
          connection.setSelection([]);
        }
      });
    },
    [frameBox, camera, overlayScreenBox],
  );

  /**
   * FP-4a double-click: text-edit entry, or (on an empty-background hit) a
   * fallback that reproduces the classic "double-click a frame to zoom into
   * it" gesture. Reachable here (not just via `CcsFrameShapeUtil.
   * onDoubleClick`) because once a frame is ACTIVE (see the frictionless
   * single-click activation in `StudioCanvas.tsx`'s `FrameSelectionBridge`),
   * this layer's own overlay — not tldraw's shape — is what receives the
   * second click of a fast double-click; `onDoubleClick` on the tldraw shape
   * itself is left completely untouched and still fires for the FIRST
   * double-click on a frame that isn't active yet (before this overlay
   * exists over it) — both paths land on the same "zoomed in + active"
   * outcome, so neither flow regresses the other.
   *
   * BUG FOUND VIA LIVE DOGFOOD (fixed here): a frame zoomed out far enough to
   * still be in `screenshot` render mode (`viewport-cull.ts`) has no live
   * iframe yet, so `connectionRef.current` is `null` — the classic "double-
   * click a small/distant frame to zoom into it" gesture MUST still work in
   * that case (there's nothing to hit-test against anyway), so the
   * no-connection branch always falls back to `zoomToBounds` rather than
   * silently no-op'ing. Confirmed live: `CcsFrameShapeUtil.onDoubleClick`
   * itself can lose the race for a frame's FIRST-ever interaction too — the
   * frictionless single-click activation (`FrameSelectionBridge`) mounts
   * this overlay fast enough that the SECOND physical click of even a real
   * (non-synthetic) double-click often lands on the overlay, not the tldraw
   * shape — so this fallback is the one path both a first-time and a
   * repeat double-click-to-zoom reliably go through now.
   */
  const handleDoubleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!frameBox || !overlayScreenBox || editingUid) return;
      const connection = connectionRef.current;
      if (!connection) {
        editor.zoomToBounds(frameBox, { animation: { duration: 200 } });
        return;
      }
      const point = screenPointToIframePoint(camera, frameBox, {
        x: e.nativeEvent.offsetX + overlayScreenBox.x,
        y: e.nativeEvent.offsetY + overlayScreenBox.y,
      });
      void connection.hitTest(point.x, point.y).then((hit) => {
        if (!hit) {
          editor.zoomToBounds(frameBox, { animation: { duration: 200 } });
          return;
        }
        if (hit.dynamic) return; // dynamic-locked — real code, not editable here.
        void connection.enterTextEdit(hit.uid).then((result) => {
          if (!result.ok) return; // component-instance / not-a-text-leaf / already-editing — no-op.
          setEditingUid(hit.uid);
          useSelectionStore.getState().setSelection({
            uid: hit.uid,
            rect: hit.rect,
            dynamic: hit.dynamic,
            component: hit.component,
            breadcrumb: hit.breadcrumb,
          });
          connection.subscribeRects([hit.uid]);
          connection.setSelection([hit.uid]);
        });
      });
    },
    [frameBox, camera, overlayScreenBox, editingUid, editor],
  );

  /**
   * The capture overlay (see module doc) sits ABOVE the whole canvas with
   * `pointer-events:auto` while a frame is in edit mode, which — being a
   * plain DOM element, not tldraw's own canvas — would otherwise silently
   * swallow wheel gestures too (CSS `pointer-events` governs wheel target
   * resolution the same as click/move), breaking ordinary pan/zoom for the
   * whole canvas the instant edit mode starts (caught empirically: P1's
   * established Ctrl+wheel zoom gesture had zero effect here before this
   * handler existed). Forwarded via `editor.dispatch` — tldraw's own
   * documented "feed a synthetic event into the state machine" API — rather
   * than re-dispatching a native DOM `WheelEvent` at tldraw's container,
   * since this overlay isn't a DOM descendant of tldraw's own canvas
   * container to bubble a re-dispatched native event into anyway (they're
   * siblings under `StudioCanvas`'s wrapper).
   *
   * The `delta` shape is NOT "just pass deltaX/deltaY through" — verified
   * empirically (an initial naive `{x:deltaX,y:deltaY,z:0}` version
   * dispatched successfully but produced a permanently-unchanged camera):
   * tldraw's own `wheel` case in `Editor.dispatch` reads the ZOOM amount
   * from `delta.z`, not `delta.y`, whenever ctrl/alt/meta is held — exactly
   * mirroring `@tldraw/editor`'s own (internal, unexported) `normalizeWheel`
   * helper, which folds a modifier-held `deltaY` into `deltaZ` (clamped to
   * +/-10, /100) instead of `deltaY` directly, because real trackpad
   * pinch-to-zoom is reported by the browser as a ctrl-modified wheel event.
   * Replicated inline below since that helper isn't exported.
   */
  const handleWheel = React.useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const native = e.nativeEvent;
      const hasZoomModifier = native.ctrlKey || native.altKey || native.metaKey;
      const ZOOM_STEP_CLAMP = 10;
      const deltaZ = hasZoomModifier
        ? (Math.abs(native.deltaY) > ZOOM_STEP_CLAMP ? ZOOM_STEP_CLAMP * Math.sign(native.deltaY) : native.deltaY) / 100
        : 0;
      editor.dispatch({
        type: 'wheel',
        name: 'wheel',
        point: { x: native.clientX, y: native.clientY, z: 0 },
        delta: { x: -native.deltaX, y: -native.deltaY, z: -deltaZ },
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        accelKey: e.ctrlKey || e.metaKey,
      });
    },
    [editor],
  );

  const primaryUid = selectedUids[0];
  const primarySelection: SelectionState | undefined = primaryUid ? selections[primaryUid] : undefined;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, fontFamily: 'system-ui, sans-serif' }}>
      {editModeFrame && overlayScreenBox && (
        <div
          data-testid="ccs-edit-mode-capture"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          style={{
            position: 'absolute',
            left: overlayScreenBox.x,
            top: overlayScreenBox.y,
            width: overlayScreenBox.w,
            height: overlayScreenBox.h,
            pointerEvents: editingUid ? 'none' : 'auto',
            cursor: 'crosshair',
          }}
        />
      )}

      {hover && frameBox && (
        <HoverOverlay camera={camera} frameBox={frameBox} hover={hover} />
      )}

      {primarySelection && primarySelection.rect && frameBox && (
        <SelectionOverlay camera={camera} frameBox={frameBox} selection={primarySelection} />
      )}

      {editModeFrame && (
        <BreadcrumbBar
          frameName={editModeRecord?.name ?? editModeFrame.framePath}
          breadcrumb={breadcrumb}
          dynamic={primarySelection?.dynamic ?? hover?.dynamic ?? false}
          detached={primarySelection?.detached ?? false}
        />
      )}
    </div>
  );
}

const HOVER_COLOR = '#2563eb';
const SELECTION_COLOR = '#1d4ed8';

function HoverOverlay({
  camera,
  frameBox,
  hover,
}: {
  camera: CameraState;
  frameBox: Box;
  hover: HoverState;
}): React.ReactElement {
  const box = iframeRectToScreenBox(camera, frameBox, hover.rect);
  const label = hover.name;
  return (
    <>
      <div
        data-testid="ccs-hover-outline"
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          border: `2px solid ${HOVER_COLOR}`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}
      />
      <div
        data-testid="ccs-hover-name-tag"
        style={{
          position: 'absolute',
          left: box.x,
          top: Math.max(0, box.y - 20),
          background: HOVER_COLOR,
          color: '#fff',
          fontSize: 11,
          lineHeight: '18px',
          padding: '0 6px',
          borderRadius: 3,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      {hover.dynamic && <LockBadge left={box.x} top={box.y + box.h + 4} />}
    </>
  );
}

function SelectionOverlay({
  camera,
  frameBox,
  selection,
}: {
  camera: CameraState;
  frameBox: Box;
  selection: SelectionState;
}): React.ReactElement | null {
  if (!selection.rect) return null;
  const box = iframeRectToScreenBox(camera, frameBox, selection.rect);
  return (
    <>
      <div
        data-testid="ccs-selection-outline"
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          border: `2px solid ${SELECTION_COLOR}`,
          boxShadow: `0 0 0 1px #ffffff inset`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
          opacity: selection.detached ? 0.4 : 1,
        }}
      />
      {selection.dynamic && <LockBadge left={box.x} top={box.y + box.h + 4} />}
    </>
  );
}

function LockBadge({ left, top }: { left: number; top: number }): React.ReactElement {
  return (
    <div
      data-testid="ccs-lock-badge"
      style={{
        position: 'absolute',
        left,
        top,
        background: '#18181b',
        color: '#fff',
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 6px',
        borderRadius: 3,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {'\u{1F512}'} dynamic — real code, edit in your editor
    </div>
  );
}

function BreadcrumbBar({
  frameName,
  breadcrumb,
  dynamic,
  detached,
}: {
  frameName: string;
  breadcrumb: { uid: string; name: string }[];
  dynamic: boolean;
  detached: boolean;
}): React.ReactElement {
  const text = breadcrumb.length > 0 ? breadcrumb.map((b) => b.name).join(' / ') : `${frameName} — click an element to select`;
  return (
    <div
      data-testid="ccs-breadcrumb-bar"
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#18181b',
        color: '#fff',
        fontSize: 12,
        lineHeight: '28px',
        padding: '0 12px',
        borderRadius: 6,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span>{text}</span>
      {dynamic && <span style={{ opacity: 0.8 }}>{'\u{1F512}'} dynamic</span>}
      {detached && <span style={{ opacity: 0.8 }}>(detached — code changed)</span>}
      <span style={{ opacity: 0.6 }}>Esc to exit</span>
    </div>
  );
}
