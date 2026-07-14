import * as React from 'react';
import { createShapeId, useValue, type Editor } from 'tldraw';
import type { HitInfo } from '@ccs/bridge';
import type { CanvasFrameRecord } from './project-wiring.js';
import { getRegisteredFrameIframe, onFrameIframeRegistryChange } from './frame-shape.js';
import { useSelectionStore, onUidRemap, type HoverState, type SelectionState } from './selection-store.js';
import { connectBridge, type BridgeConnection } from './bridge-client.js';
import { iframeRectToScreenBox, screenPointToIframePoint } from './bridge-geometry.js';
import type { Box, CameraState } from './geometry.js';

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
 * ## Why a full-canvas capture div, not the iframe itself, drives hit-testing
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
 * that with one transparent, `pointer-events:auto` div that exactly covers
 * the canvas container (only while a frame is in edit mode), converts the
 * event's own `offsetX`/`offsetY` (already relative to that div's — and
 * therefore the container's — top-left, since the div is `inset:0` of the
 * same `position:relative` container `StudioCanvas` renders) through
 * `screenPointToIframePoint`, and sends the resulting iframe-space point as
 * a `hit-test` request. This deliberately sits ABOVE the iframe (as the
 * last-rendered sibling), so the iframe's own `pointer-events:auto` (set by
 * `frame-shape.tsx` per the playbook prompt) is currently inert for P2 —
 * flagged as a CR in the worker report: it's wired and ready for a future
 * phase that needs the iframe to receive events directly (e.g. in-place
 * text editing), but P2's actual interaction model is capture-overlay +
 * postMessage, the only approach the browser's cross-origin model and the
 * FROZEN protocol actually allow.
 */

export interface EditModeLayerProps {
  editor: Editor;
  frames: CanvasFrameRecord[];
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

export function EditModeLayer({ editor, frames }: EditModeLayerProps): React.ReactElement {
  const editModeFrame = useSelectionStore((s) => s.editModeFrame);
  const hover = useSelectionStore((s) => s.hover);
  const selectedUids = useSelectionStore((s) => s.selectedUids);
  const selections = useSelectionStore((s) => s.selections);
  const breadcrumb = useSelectionStore((s) => s.breadcrumb);

  const camera = useValue<CameraState>('ccs-edit-mode-camera', () => editor.getCamera(), [editor]);

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

  // --- bridge connection lifecycle: one connection per edit-mode iframe ---
  const connectionRef = React.useRef<BridgeConnection | null>(null);
  const connectedWindowRef = React.useRef<Window | null>(null);

  React.useEffect(() => {
    const win = iframeEl?.contentWindow ?? null;
    if (connectedWindowRef.current === win) return;
    connectionRef.current?.dispose();
    connectionRef.current = null;
    connectedWindowRef.current = win;
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
        if (currentSelection.length > 0) connectionRef.current?.subscribeRects(currentSelection);
      },
    });
    connectionRef.current = connection;

    return () => {
      connection.dispose();
      if (connectedWindowRef.current === win) connectedWindowRef.current = null;
    };
  }, [iframeEl]);

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

  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const connection = connectionRef.current;
      if (!frameBox || !connection) return;
      const screenPoint = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
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
    [frameBox, camera],
  );

  const handleMouseLeave = React.useCallback(() => {
    useSelectionStore.getState().setHover(null);
    connectionRef.current?.setHover(null);
  }, []);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const connection = connectionRef.current;
      if (!frameBox || !connection) return;
      const point = screenPointToIframePoint(camera, frameBox, {
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
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
    [frameBox, camera],
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
      {editModeFrame && frameBox && (
        <div
          data-testid="ccs-edit-mode-capture"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onWheel={handleWheel}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'crosshair' }}
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
