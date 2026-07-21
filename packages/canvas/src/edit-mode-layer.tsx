import * as React from 'react';
import type { ComputedStyleResult, HitInfo, LayoutAxis, Rect, TextEditExit } from '@ccs/bridge';
import type { CanvasFrameRecord } from './project-wiring.js';
import { getRegisteredFrameIframe, onFrameIframeRegistryChange } from './frame-shape.js';
import { useSelectionStore, onUidRemap, type HoverState, type SelectionState } from './selection-store.js';
import { connectBridge, type BridgeConnection } from './bridge-client.js';
import { iframeRectToScreenBox, boxToBridgeRect, screenPointToIframePoint } from './bridge-geometry.js';
import { boxToScreenBox, type Box, type CameraState, type Point } from './geometry.js';
import {
  computeReorderDropIndex,
  dropIndicatorBox,
  distance,
  DRAG_THRESHOLD_PX,
  type SiblingRect,
} from './drag-geometry.js';

/**
 * Sub-workstream 2d-i (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — the ONLY
 * thing this file needs from whatever engine is mounting it, narrowed down
 * from tldraw's full `Editor` to exactly the four calls this file actually
 * makes (confirmed by reading every `editor.*` call site below before this
 * refactor). Reading the current camera is deliberately NOT part of this
 * interface — the caller passes the live camera in as a plain `camera:
 * CameraState` prop instead (see `EditModeLayerProps.camera`'s doc), so this
 * file has no signal-reading concern at all, tldraw's `useValue` included.
 *
 * The tldraw-backed adapter satisfying this today is built inline at
 * `StudioCanvas.tsx`'s `<EditModeLayer>` call site (a small object literal
 * wrapping the real `Editor`) — see that file for the concrete
 * implementation. A future custom-engine adapter (sub-workstream 2d-ii)
 * wraps `camera-store.ts`'s `setCamera`/`zoomToBounds` actions the same way;
 * `dispatchWheel` is the one method that may not need a literal equivalent
 * there (see its own doc below).
 */
export interface CanvasCameraHandle {
  /** Restores a previously-captured camera — used ONLY for the Esc-exits-
   * edit-mode camera restore (`exitEditModeAndRestoreCamera` below), which
   * is why `opts` only ever needs an optional animation duration (the one
   * shape this file's single caller passes: `{ animation: { duration: 200
   * } }`). Mirrors tldraw's own `Editor.setCamera(camera, opts)` signature
   * exactly, narrowed to what's used. */
  setCamera(camera: CameraState, opts?: { animation?: { duration: number } }): void;
  /** Frames `box` into the viewport, used by the double-click-to-zoom
   * fallback (`handleDoubleClick` below, both the no-connection branch and
   * the empty-hit-test branch). Mirrors tldraw's own
   * `Editor.zoomToBounds(bounds, opts)`, narrowed the same way as
   * `setCamera` above — this file never passes a `targetZoom`/`inset`, so
   * those aren't part of this interface (a caller-side adapter is free to
   * pass its own defaults for them). */
  zoomToBounds(box: Box, opts?: { animation?: { duration: number } }): void;
  /** Forwards a wheel gesture the capture overlay (`handleWheel` below)
   * intercepted so the underlying engine's OWN wheel handling still applies
   * — see `handleWheel`'s doc comment for the full "why forward at all"
   * rationale (this overlay sits ABOVE the canvas with `pointer-events:
   * auto`, which would otherwise swallow every wheel event the instant a
   * frame enters edit mode). The shape here is exactly what tldraw's
   * `Editor.dispatch({type:'wheel', ...})` needs (point/delta each carry a
   * `z` component — `delta.z` is how tldraw reads ctrl/alt/meta-modified
   * wheel as a ZOOM amount, not `delta.y`; `point.z` is always 0, tldraw's
   * own wheel-event convention) plus the four modifier keys and the
   * `accelKey` tldraw derives from them — nothing here is invented, it's a
   * direct capture of what `handleWheel` used to pass to `dispatch`
   * inline. FLAG for 2d-ii: the custom engine (`camera-gestures.ts`'s
   * `classifyWheelGesture`) owns wheel handling directly against real DOM
   * events already and has no second (engine-internal) wheel handler to
   * route around, so its adapter may not need this "re-dispatch a
   * synthetic event" indirection at all — it could instead call
   * `camera-store.ts`'s pan/zoom actions straight from THIS file's
   * `handleWheel`, with `dispatchWheel` becoming a thin one-line shim (or
   * removed if `handleWheel` itself is restructured then). Not decided
   * here on purpose — this pass only narrows the interface without
   * changing behavior. */
  dispatchWheel(event: {
    point: { x: number; y: number; z: number };
    delta: { x: number; y: number; z: number };
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    accelKey: boolean;
  }): void;
}

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

/**
 * FP-4b (D-EDIT context-aware drag-to-move, `.orchestrator/
 * FEATURE-PARITY-PLAN.md` §2 FP-4 third bullet) — the REORDER branch's
 * commit: the dragged element's parent is flex/grid (LIVE-detected via the
 * bridge), so a drop re-sorts within it. `newParentUid`/`index` map
 * DIRECTLY onto the existing, frozen `move-node` `CanvasOp` — this package
 * never sends ops itself (same architecture as `CommitTextRequest`); the
 * caller (studio chrome) emits `{t:'move-node', uid, newParentUid, index}`
 * verbatim. No coordinates are ever involved in this branch.
 */
export interface ReorderNodeRequest {
  fileFolder: string;
  framePath: string;
  uid: string;
  newParentUid: string;
  index: number;
}

/**
 * FP-4b — the FREE-DRAG branch's commit: the dragged element's parent is
 * NOT flex/grid, so the drop writes absolute positioning into source. Both
 * class lists map directly onto the existing, frozen `set-classes`
 * `CanvasOp` — the caller emits ONE `set-classes` for `uid`
 * (`addClasses`/`removeClasses`) and, when `parentAddClasses` is non-empty,
 * a SECOND `set-classes` for `parentUid` (adds `relative` so the absolute
 * child is actually contained — see `@ccs/bridge`'s `free-drop.ts`). Two
 * separate ops (two undo steps) rather than a batched op — the frozen
 * `CanvasOp`/daemon op-application surface has no multi-op envelope; a
 * disclosed, minor divergence from "one user gesture, one undo step".
 */
export interface CommitFreeDragRequest {
  fileFolder: string;
  framePath: string;
  uid: string;
  addClasses: string[];
  removeClasses: string[];
  parentUid: string | null;
  parentAddClasses: string[];
}

// --- FP-4b drag-gesture state machine --------------------------------------
// Lives in this module (not a separate file) because it's tightly coupled to
// this component's own render (ghost/drop-indicator overlays) and its
// existing bridge-connection ref — see the component's own doc for the full
// gesture walkthrough (armed -> resolving -> reorder|free -> commit).

interface IdleDrag {
  phase: 'idle';
}

interface ArmedDrag {
  phase: 'armed';
  uid: string;
  fileFolder: string;
  framePath: string;
  pointerId: number;
  startScreen: Point;
  /** The dragged element's OWN rect (iframe space) at drag start — captured
   * once here so the FREE branch doesn't need a second bridge round trip
   * just to learn its starting position (the selection overlay already
   * tracks this live via `rects-update`). */
  startRectIframe: Rect;
  /** `true` once the `report-parent-layout` (+ possibly `report-rects`)
   * round trip has been kicked off — guards against re-firing it on every
   * subsequent `pointermove` while it's still in flight. */
  resolving: boolean;
}

interface ReorderDrag {
  phase: 'reorder';
  uid: string;
  fileFolder: string;
  framePath: string;
  pointerId: number;
  parentUid: string;
  axis: LayoutAxis;
  /** DOM-ordered, EXCLUDING the dragged uid — matches `move-node`'s own
   * index semantics (`packages/ast-engine/src/apply-op.ts`'s
   * `applyMoveNodeOp`: `siblingsExcludingTarget`). */
  siblings: SiblingRect[];
  /** This uid's index within the FULL sibling list (incl. itself) at drag
   * start — used as the "dropped back in its original slot" no-op check. */
  originalIndex: number;
  parentRect: Rect;
  dropIndex: number;
}

interface FreeDrag {
  phase: 'free';
  uid: string;
  fileFolder: string;
  framePath: string;
  pointerId: number;
  startScreen: Point;
  currentScreen: Point;
  startRectIframe: Rect;
}

type DragState = IdleDrag | ArmedDrag | ReorderDrag | FreeDrag;

const IDLE_DRAG: DragState = { phase: 'idle' };

const GHOST_COLOR = '#f59e0b';

function GhostOverlay({ box }: { box: Box }): React.ReactElement {
  return (
    <div
      data-testid="ccs-drag-ghost"
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        border: `2px dashed ${GHOST_COLOR}`,
        background: 'rgba(245, 158, 11, 0.14)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    />
  );
}

function DropIndicatorOverlay({ box }: { box: Box }): React.ReactElement {
  return (
    <div
      data-testid="ccs-drop-indicator"
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        background: GHOST_COLOR,
        borderRadius: 2,
        pointerEvents: 'none',
      }}
    />
  );
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
  /** Imperative camera actions this layer needs from whatever engine is
   * mounting it — see {@link CanvasCameraHandle}'s own doc. Replaces the
   * old `editor: Editor` prop 1:1 in effect (every former `editor.*` call
   * below now reads `cameraHandle.*` instead), narrowed so this file has
   * zero tldraw import. */
  cameraHandle: CanvasCameraHandle;
  /** The CURRENT camera, read reactively. Sub-workstream 2d-i replaced
   * tldraw's `useValue('ccs-edit-mode-camera', () => editor.getCamera(),
   * [editor])` signal-subscription with this plain prop: `useValue` is
   * tldraw's own signal->React bridge and has no engine-agnostic
   * equivalent, but this component never actually needs a SUBSCRIPTION —
   * it just needs the current value at render time, and a prop that
   * changes on every camera move already re-renders this component exactly
   * as often as `useValue` did (the caller is expected to re-render on
   * every camera change, same as `StudioCanvas.tsx`'s own tldraw-editor
   * render loop already does today for its other camera-dependent JSX).
   * This also means `CanvasCameraHandle` itself never needs a `getCamera()`
   * method — reading and mutating the camera are now two separate
   * concerns, which is the smaller, more explicit interface the brief
   * asked for. */
  camera: CameraState;
  /** Maps a `CanvasFrameRecord.id` to whatever id convention
   * `editModeFrame.shapeId` (`selection-store.ts`'s `EditModeFrameRef.
   * shapeId`) actually uses, so this file never imports `createShapeId`
   * from `tldraw` itself. The tldraw-backed caller passes tldraw's own
   * `createShapeId`; a future custom-engine caller can pass plain identity
   * (`(id) => id`) once `EditModeFrameRef.shapeId` stores a real
   * `CanvasFrameRecord.id` directly instead of a tldraw shape id — see
   * `editModeRecord`'s `useMemo` below, the only call site. */
  frameIdToShapeId: (recordId: string) => string;
  frames: CanvasFrameRecord[];
  /** FP-4a: called once per committed in-place text edit (never for a
   * cancelled one) — see {@link CommitTextRequest}'s doc. Optional so
   * existing callers/tests that don't care about text-editing keep
   * compiling unchanged (additive prop). */
  onCommitText?: ((request: CommitTextRequest) => void) | undefined;
  /** FP-4b (D-EDIT): called once per completed REORDER drop (a drop that
   * actually changed position — a drop back into the same slot is a no-op,
   * never calls this). See {@link ReorderNodeRequest}'s doc. */
  onReorderNode?: ((request: ReorderNodeRequest) => void) | undefined;
  /** FP-4b (D-EDIT): called once per completed FREE-DRAG drop. See
   * {@link CommitFreeDragRequest}'s doc. */
  onCommitFreeDrag?: ((request: CommitFreeDragRequest) => void) | undefined;
  /** FP-INS-b (Inspect / code tab): fires with a `requestComputedStyle`
   * function bound to the CURRENT edit-mode frame's live bridge connection
   * whenever that connection (re)connects, and with `null` when it's torn
   * down (frame deselected/reloaded, no live iframe yet). `StudioCanvas`
   * stores whatever this last reports in a ref and exposes it as
   * `StudioCanvasHandle.requestComputedStyle` — this is the ONLY place a
   * frame's bridge connection actually lives, so it's the only place that
   * can hand one out. Optional so existing callers/tests compile unchanged
   * (additive prop, same pattern as `onCommitText`/`onReorderNode`). */
  onBridgeConnectionChange?: ((requestComputedStyle: ((uid: string) => Promise<ComputedStyleResult>) | null) => void) | undefined;
  /**
   * Phase 3b fix: looks up the edit-mode frame's live `<iframe>` element (by
   * `editModeFrame.shapeId`) so this file can open a bridge connection on
   * it. **Optional, defaulting to the tldraw-path's own
   * `getRegisteredFrameIframe`/`onFrameIframeRegistryChange` (imported
   * below from `./frame-shape.js`)** — this file used to call those two
   * directly, unconditionally, which is itself a tldraw-specific coupling
   * this "engine-agnostic" file was never actually free of (2d-i's own
   * "zero tldraw imports" claim only checked TYPE imports, not this runtime
   * one). Rather than risk changing `TldrawEngineCanvas.tsx` (off-limits per
   * this task's boundaries) to pass an explicit prop, the default argument
   * below preserves the exact existing tldraw-path behavior for any caller
   * that doesn't pass these two — `CustomEngineCanvas.tsx`'s
   * `CustomEditModeLayerBridge` is the only caller that DOES, supplying its
   * own parallel registry (`custom-frame-iframe-registry.ts`) that `FrameShape.
   * tsx` (2b) populates the same way `frame-shape.tsx`'s
   * `CcsFrameShapeComponent` populates the tldraw one. */
  getFrameIframe?: (shapeId: string) => HTMLIFrameElement | null;
  /** Companion to {@link EditModeLayerProps.getFrameIframe} — see its doc. */
  onFrameIframeChange?: (listener: () => void) => () => void;
}

function exitEditModeAndRestoreCamera(cameraHandle: CanvasCameraHandle): void {
  // `setCameraOptions({isLocked:false})` is deliberately NOT called here —
  // entry never locks the camera (see `CcsFrameShapeUtil.onDoubleClick`'s
  // doc comment for why); this only restores whatever camera was active
  // before edit mode was entered.
  const result = useSelectionStore.getState().exitEditMode();
  if (result?.previousCamera) {
    cameraHandle.setCamera(result.previousCamera, { animation: { duration: 200 } });
  }
}

function frameBoxOf(record: CanvasFrameRecord): Box {
  return { x: record.x, y: record.y, w: record.w, h: record.h };
}

export function EditModeLayer({
  cameraHandle,
  camera,
  frameIdToShapeId,
  frames,
  onCommitText,
  onReorderNode,
  onCommitFreeDrag,
  onBridgeConnectionChange,
  // Defaults preserve the tldraw path's exact pre-existing behavior — see
  // `EditModeLayerProps.getFrameIframe`'s doc for why these two specific
  // functions (not a narrower/different pair) are the default.
  getFrameIframe = getRegisteredFrameIframe,
  onFrameIframeChange = onFrameIframeRegistryChange,
}: EditModeLayerProps): React.ReactElement {
  const editModeFrame = useSelectionStore((s) => s.editModeFrame);
  const hover = useSelectionStore((s) => s.hover);
  const selectedUids = useSelectionStore((s) => s.selectedUids);
  const selections = useSelectionStore((s) => s.selections);
  const breadcrumb = useSelectionStore((s) => s.breadcrumb);

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

  // FP-4b: the primary selection, computed up-front (moved ahead of the
  // former render-only usage) — the drag gesture's pointer-down handler
  // needs to know it synchronously to decide "did this pointer-down land on
  // the CURRENTLY SELECTED element" (D-EDIT's own scoping: "on pointer-down
  // + drag on a SELECTED element" — an unselected element never starts a
  // drag; a plain click still selects it as before).
  const primaryUid = selectedUids[0];
  const primarySelection: SelectionState | undefined = primaryUid ? selections[primaryUid] : undefined;

  // FP-4b (D-EDIT context-aware drag-to-move) — see the module-level
  // `DragState` doc for the full shape. `dragOccurredRef` suppresses the
  // native `click` that always fires right after a pointerup, even after a
  // real drag gesture (a browser's `click` event doesn't care how far the
  // pointer moved between down/up) — without this, every completed drag
  // would ALSO re-run `handleClick`'s hit-test+select against whatever now
  // happens to be under the pointer.
  const [dragState, setDragState] = React.useState<DragState>(IDLE_DRAG);
  const dragOccurredRef = React.useRef(false);
  const latestScreenPointRef = React.useRef<Point | null>(null);

  // Re-render whenever a frame's iframe (re)registers/unregisters (e.g. the
  // edit-mode frame flips live<->screenshot, or first mounts its iframe
  // after entering edit mode before the iframe has painted) so this layer
  // picks up the DOM node to open a bridge connection on.
  const [, bumpRegistryTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => onFrameIframeChange(bumpRegistryTick), [onFrameIframeChange]);

  const editModeRecord = React.useMemo(() => {
    if (!editModeFrame) return null;
    return frames.find((r) => frameIdToShapeId(r.id) === editModeFrame.shapeId) ?? null;
  }, [frames, editModeFrame, frameIdToShapeId]);

  const frameBox = editModeRecord ? frameBoxOf(editModeRecord) : null;
  const iframeEl = editModeFrame ? getFrameIframe(editModeFrame.shapeId) : null;

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
    onBridgeConnectionChange?.(null);
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
        // FP-INS-b (AUDIT-FPINSb): re-announce the connection on READY, not
        // just on connect. A FRESHLY-MOUNTED edit-mode iframe (the natural
        // Layers-select-then-Inspect flow: the frame only goes live AFTER
        // selection) isn't yet listening when `connectBridge` returns below,
        // so a `report-computed-style` fired at connect-time is dropped and
        // never answered. This `ready` handshake is the point the in-iframe
        // bridge is actually able to reply — re-announcing here bumps the
        // studio's bridge-generation again so the Inspect tab's CSS fetch
        // re-runs against a bridge that can now respond.
        const conn = connectionRef.current;
        if (conn) onBridgeConnectionChange?.(conn.requestComputedStyle);
      },
      onTextEditExit: handleTextEditExit,
    });
    connectionRef.current = connection;
    // FP-INS-b: hand the Inspect tab a way to reach THIS connection's
    // `requestComputedStyle` without `StudioCanvas` needing its own bridge
    // wiring — see this prop's own doc. (Covers the case where the iframe's
    // bridge is ALREADY listening at connect time — e.g. reconnecting to an
    // already-booted iframe; the `onReady` re-announce above covers the
    // freshly-mounted case where it isn't ready yet.)
    onBridgeConnectionChange?.(connection.requestComputedStyle);

    return () => {
      connection.dispose();
      if (connectedWindowRef.current === win) connectedWindowRef.current = null;
    };
    // `onBridgeConnectionChange` is a real dependency (included below) —
    // callers are expected to pass a stable ref-setter (`StudioCanvas.tsx`
    // uses `useCallback` with an empty dep array, exactly like `onReady`'s
    // other stable callbacks), so this doesn't reconnect the bridge on every
    // render in practice, but the exhaustive-deps discipline this repo
    // otherwise follows (no lint-suppression comments elsewhere) still
    // applies here.
  }, [iframeEl, handleTextEditExit, onBridgeConnectionChange]);

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
  // FP-4b: Esc during an ACTIVE drag (armed/reorder/free) cancels only the
  // drag (no commit, ghost/indicator disappears) and does NOT also exit
  // edit mode in the same keystroke — a second Esc (now that dragState is
  // idle again) exits edit mode as before. Mirrors the existing text-edit
  // Esc-cancel precedent (`text-edit.ts`): Esc always backs out of the
  // MOST LOCAL in-progress gesture first.
  React.useEffect(() => {
    if (!editModeFrame) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (dragState.phase !== 'idle') {
        setDragState(IDLE_DRAG);
        return;
      }
      exitEditModeAndRestoreCamera(cameraHandle);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editModeFrame, cameraHandle, dragState]);

  // --- robustness: if the edit-mode frame's shape vanishes from under us
  // (e.g. deleted while editing), don't get stuck in a locked-camera limbo.
  React.useEffect(() => {
    if (editModeFrame && !editModeRecord) exitEditModeAndRestoreCamera(cameraHandle);
  }, [editModeFrame, editModeRecord, cameraHandle]);

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
  // FP-4b: factored out as `toScreenPoint` so the drag-gesture handlers
  // below reuse the EXACT same conversion basis (required for the drag
  // threshold's distance check to be meaningful).
  const toScreenPoint = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>): Point | null => {
      if (!overlayScreenBox) return null;
      return { x: e.nativeEvent.offsetX + overlayScreenBox.x, y: e.nativeEvent.offsetY + overlayScreenBox.y };
    },
    [overlayScreenBox],
  );

  const handleMouseMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const connection = connectionRef.current;
      const screenPoint = toScreenPoint(e);
      if (!frameBox || !connection || !screenPoint) return;
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
    [frameBox, camera, toScreenPoint],
  );

  const handleMouseLeave = React.useCallback(() => {
    // FP-4b: a stray `mouseleave` (the pointer visually leaving the overlay
    // div's box) must NOT clear the ghost/drop-indicator mid-drag — pointer
    // CAPTURE (see `handlePointerDown`) keeps `pointermove`/`pointerup`
    // targeting this element regardless, so the drag itself is unaffected;
    // this guard only concerns the (unrelated) hover-outline state.
    if (dragState.phase !== 'idle') return;
    useSelectionStore.getState().setHover(null);
    connectionRef.current?.setHover(null);
  }, [dragState.phase]);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // FP-4b: a completed drag/reorder/free-drag gesture's pointerup is
      // immediately followed by the browser's own native `click` (which
      // fires regardless of how far the pointer moved between down/up) —
      // suppress exactly that one synthetic re-selection, once.
      if (dragOccurredRef.current) {
        dragOccurredRef.current = false;
        return;
      }
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
   * FP-4b (D-EDIT context-aware drag-to-move) — the full gesture:
   *
   * 1. **pointerdown** (`handlePointerDown`): only ARMS a potential drag if
   *    the pointer landed within the CURRENTLY SELECTED element's own
   *    screen box (checked via the already-known `primarySelection.rect` —
   *    no hit-test round trip needed for this decision) and that selection
   *    isn't `dynamic`-locked. Anything else (nothing selected, pointer
   *    outside it, dynamic) leaves `dragState` idle — the native
   *    click/dblclick handlers proceed exactly as before, unaffected.
   * 2. **pointermove while armed** (`handlePointerMoveCapture`): below
   *    `DRAG_THRESHOLD_PX` of movement, nothing happens yet — this is the
   *    "small movement still registers as a SELECT" guarantee (the
   *    eventual native `click` on pointerup does the selecting, same as
   *    always). Once the threshold is crossed, kicks off ONE
   *    `report-parent-layout` bridge round trip (guarded by `resolving` so
   *    it only fires once) to learn the REAL, LIVE parent layout mode.
   * 3. **branch resolution**: `mode !== 'none'` AND an addressable
   *    `parentUid` -> fetches sibling rects (`report-rects`, reused
   *    verbatim) and transitions to `reorder`. `mode === 'none'` ->
   *    transitions to `free` using the already-known starting rect (no
   *    extra round trip). `mode !== 'none'` but `parentUid` is `null` (an
   *    unaddressable real DOM parent — component-instance/fragment
   *    boundary, see `@ccs/bridge`'s `parent-layout.ts`) -> drag is
   *    DISABLED for this gesture (falls back to idle; disclosed
   *    carry-forward, see worker report) rather than guessing.
   * 4. **pointermove while reorder/free**: recomputes the drop
   *    index/ghost position on every move (pure, local — `drag-
   *    geometry.ts`), no further bridge calls.
   * 5. **pointerup**: `armed` (never crossed threshold) resolves to a
   *    no-op — the native `click` fires normally right after, selecting
   *    whatever's under the pointer, exactly like before this feature
   *    existed. `reorder`/`free` commit (if the drop actually changed
   *    anything) via `onReorderNode`/`onCommitFreeDrag` and mark
   *    `dragOccurredRef` so the trailing native `click` is suppressed.
   */
  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (editingUid || dragState.phase !== 'idle' || !editModeFrame) return;
      if (!primarySelection || primarySelection.dynamic || !primarySelection.rect) return;
      if (!frameBox) return;
      const point = toScreenPoint(e);
      if (!point) return;
      const selectionScreenBox = iframeRectToScreenBox(camera, frameBox, primarySelection.rect);
      const withinSelection =
        point.x >= selectionScreenBox.x &&
        point.x <= selectionScreenBox.x + selectionScreenBox.w &&
        point.y >= selectionScreenBox.y &&
        point.y <= selectionScreenBox.y + selectionScreenBox.h;
      if (!withinSelection) return; // pointer-down landed elsewhere — let the normal click/select flow handle it.

      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        phase: 'armed',
        uid: primarySelection.uid,
        fileFolder: editModeFrame.fileFolder,
        framePath: editModeFrame.framePath,
        pointerId: e.pointerId,
        startScreen: point,
        startRectIframe: primarySelection.rect,
        resolving: false,
      });
    },
    [editingUid, dragState.phase, editModeFrame, primarySelection, frameBox, camera, toScreenPoint],
  );

  const handlePointerMoveCapture = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const point = toScreenPoint(e);
      if (point) latestScreenPointRef.current = point;

      if (dragState.phase === 'idle') {
        handleMouseMove(e);
        return;
      }
      if (!point || !frameBox) return;

      if (dragState.phase === 'armed') {
        if (dragState.resolving) return; // already kicked off the parent-layout round trip
        if (distance(dragState.startScreen, point) < DRAG_THRESHOLD_PX) return;

        const connection = connectionRef.current;
        const { uid } = dragState;
        if (!connection) {
          setDragState(IDLE_DRAG);
          return;
        }
        setDragState((current) => (current.phase === 'armed' && current.uid === uid ? { ...current, resolving: true } : current));

        void connection.reportParentLayout(uid).then(async (result) => {
          if (!result.ok) {
            setDragState((current) => (current.phase === 'armed' && current.uid === uid ? IDLE_DRAG : current));
            return;
          }
          const { info } = result;

          if (info.mode === 'none') {
            setDragState((current) => {
              if (current.phase !== 'armed' || current.uid !== uid) return current;
              const pointer = latestScreenPointRef.current ?? current.startScreen;
              return {
                phase: 'free',
                uid,
                fileFolder: current.fileFolder,
                framePath: current.framePath,
                pointerId: current.pointerId,
                startScreen: current.startScreen,
                currentScreen: pointer,
                startRectIframe: current.startRectIframe,
              };
            });
            return;
          }

          if (!info.parentUid) {
            // Real DOM parent is flex/grid but isn't itself addressable
            // (component-instance/fragment boundary) — `move-node` has no
            // valid `newParentUid` to target. Disabled, not guessed.
            setDragState((current) => (current.phase === 'armed' && current.uid === uid ? IDLE_DRAG : current));
            return;
          }

          const rects = await connection.reportRects(info.siblingUids);
          const siblings: SiblingRect[] = info.siblingUids
            .filter((siblingUid) => siblingUid !== uid)
            .flatMap((siblingUid) => {
              const rect = rects[siblingUid];
              return rect ? [{ uid: siblingUid, rect }] : [];
            });
          const pointerIframe = screenPointToIframePoint(camera, frameBox, latestScreenPointRef.current ?? point);
          const dropIndex = computeReorderDropIndex(info.axis, siblings, pointerIframe);

          setDragState((current) =>
            current.phase === 'armed' && current.uid === uid
              ? {
                  phase: 'reorder',
                  uid,
                  fileFolder: current.fileFolder,
                  framePath: current.framePath,
                  pointerId: current.pointerId,
                  parentUid: info.parentUid!,
                  axis: info.axis,
                  siblings,
                  originalIndex: info.index,
                  parentRect: info.parentRect,
                  dropIndex,
                }
              : current,
          );
        });
        return;
      }

      if (dragState.phase === 'reorder') {
        const iframePoint = screenPointToIframePoint(camera, frameBox, point);
        const dropIndex = computeReorderDropIndex(dragState.axis, dragState.siblings, iframePoint);
        if (dropIndex !== dragState.dropIndex) setDragState({ ...dragState, dropIndex });
        return;
      }

      if (dragState.phase === 'free') {
        setDragState({ ...dragState, currentScreen: point });
      }
    },
    [dragState, frameBox, camera, toScreenPoint, handleMouseMove],
  );

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragState.phase === 'idle') return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);

      if (dragState.phase === 'armed') {
        // Never crossed the threshold (or the async resolution hadn't
        // settled yet) — this was just a click. Reset and let the native
        // `click` event (which fires next) select as usual.
        setDragState(IDLE_DRAG);
        return;
      }

      dragOccurredRef.current = true; // suppress the trailing native click
      const finished = dragState;
      setDragState(IDLE_DRAG);

      if (finished.phase === 'reorder') {
        if (finished.dropIndex === finished.originalIndex) return; // dropped back in its own slot — no-op
        onReorderNode?.({
          fileFolder: finished.fileFolder,
          framePath: finished.framePath,
          uid: finished.uid,
          newParentUid: finished.parentUid,
          index: finished.dropIndex,
        });
        return;
      }

      if (finished.phase === 'free') {
        const connection = connectionRef.current;
        if (!connection) return;
        const dx = (finished.currentScreen.x - finished.startScreen.x) / camera.z;
        const dy = (finished.currentScreen.y - finished.startScreen.y) / camera.z;
        const targetX = finished.startRectIframe.x + dx;
        const targetY = finished.startRectIframe.y + dy;
        void connection.resolveFreeDrop(finished.uid, targetX, targetY).then((result) => {
          if (!result.ok) return;
          onCommitFreeDrag?.({
            fileFolder: finished.fileFolder,
            framePath: finished.framePath,
            uid: finished.uid,
            addClasses: result.info.addClasses,
            removeClasses: result.info.removeClasses,
            parentUid: result.info.parentUid,
            parentAddClasses: result.info.parentAddClasses,
          });
        });
      }
    },
    [dragState, camera, onReorderNode, onCommitFreeDrag],
  );

  const handlePointerCancel = React.useCallback(() => {
    // e.g. the OS/browser yanks pointer capture (alt-tab mid-drag) — cancel
    // without committing anything, same as an Esc-cancel.
    setDragState(IDLE_DRAG);
  }, []);

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
        cameraHandle.zoomToBounds(frameBox, { animation: { duration: 200 } });
        return;
      }
      const point = screenPointToIframePoint(camera, frameBox, {
        x: e.nativeEvent.offsetX + overlayScreenBox.x,
        y: e.nativeEvent.offsetY + overlayScreenBox.y,
      });
      void connection.hitTest(point.x, point.y).then((hit) => {
        if (!hit) {
          cameraHandle.zoomToBounds(frameBox, { animation: { duration: 200 } });
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
    [frameBox, camera, overlayScreenBox, editingUid, cameraHandle],
  );

  /**
   * The capture overlay (see module doc) sits ABOVE the whole canvas with
   * `pointer-events:auto` while a frame is in edit mode, which — being a
   * plain DOM element, not tldraw's own canvas — would otherwise silently
   * swallow wheel gestures too (CSS `pointer-events` governs wheel target
   * resolution the same as click/move), breaking ordinary pan/zoom for the
   * whole canvas the instant edit mode starts (caught empirically: P1's
   * established Ctrl+wheel zoom gesture had zero effect here before this
   * handler existed). Forwarded via `cameraHandle.dispatchWheel` (sub-
   * workstream 2d-i: was `editor.dispatch` directly — tldraw's own
   * documented "feed a synthetic event into the state machine" API — now
   * routed through the narrow {@link CanvasCameraHandle} interface so this
   * file has zero tldraw import; the tldraw-backed adapter at
   * `StudioCanvas.tsx`'s call site forwards this verbatim to
   * `editor.dispatch`) rather than re-dispatching a native DOM `WheelEvent`
   * at tldraw's container, since this overlay isn't a DOM descendant of
   * tldraw's own canvas container to bubble a re-dispatched native event
   * into anyway (they're siblings under `StudioCanvas`'s wrapper).
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
   * Replicated inline below since that helper isn't exported. This whole
   * computation is UNCHANGED by the 2d-i refactor — only the final call
   * (`editor.dispatch({type:'wheel',...})` -> `cameraHandle.dispatchWheel
   * ({...})`, same object contents minus the tldraw-specific `type`/`name`
   * envelope fields) moved.
   */
  const handleWheel = React.useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const native = e.nativeEvent;
      const hasZoomModifier = native.ctrlKey || native.altKey || native.metaKey;
      const ZOOM_STEP_CLAMP = 10;
      const deltaZ = hasZoomModifier
        ? (Math.abs(native.deltaY) > ZOOM_STEP_CLAMP ? ZOOM_STEP_CLAMP * Math.sign(native.deltaY) : native.deltaY) / 100
        : 0;
      cameraHandle.dispatchWheel({
        point: { x: native.clientX, y: native.clientY, z: 0 },
        delta: { x: -native.deltaX, y: -native.deltaY, z: -deltaZ },
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        accelKey: e.ctrlKey || e.metaKey,
      });
    },
    [cameraHandle],
  );

  return (
    // FIX 5 (AUDIT-FIXW1 major remediation): `overflow: hidden` CLIPS every
    // child — crucially the `pointer-events:auto` capture div below — to
    // this wrapper's box, which is `inset:0` of `StudioCanvas`'s own canvas
    // container (the middle grid column only). When a frame is zoomed in far
    // enough that its on-screen box (`overlayScreenBox`) is larger than the
    // viewport, the capture div used to overflow this container and cover the
    // Layers/Inspector panels too, swallowing every click there until Esc.
    // Clipping to the canvas region means a click on a panel (which lives in
    // a DIFFERENT grid column, outside this container) is never intercepted —
    // you can click another Layers row / the Inspector immediately after a
    // zoom-to-node, no Escape needed. (FIX 5's zoom clamp above also bounds
    // how large the box can get, but this makes the scoping robust regardless
    // of zoom.)
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 5, fontFamily: 'system-ui, sans-serif' }}>
      {editModeFrame && overlayScreenBox && (
        <div
          data-testid="ccs-edit-mode-capture"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMoveCapture}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
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

      {/* FP-4b: hover/selection outlines are suppressed while a drag gesture
          is active (armed-but-below-threshold still shows them normally —
          only `reorder`/`free` replace them with their own affordance
          below) so the ghost/drop-indicator is the only moving visual. */}
      {dragState.phase === 'idle' && hover && frameBox && (
        <HoverOverlay camera={camera} frameBox={frameBox} hover={hover} />
      )}

      {dragState.phase === 'idle' && primarySelection && primarySelection.rect && frameBox && (
        <SelectionOverlay camera={camera} frameBox={frameBox} selection={primarySelection} />
      )}

      {dragState.phase === 'free' && frameBox && (
        <GhostOverlay
          box={(() => {
            const startBox = iframeRectToScreenBox(camera, frameBox, dragState.startRectIframe);
            const dx = dragState.currentScreen.x - dragState.startScreen.x;
            const dy = dragState.currentScreen.y - dragState.startScreen.y;
            return { x: startBox.x + dx, y: startBox.y + dy, w: startBox.w, h: startBox.h };
          })()}
        />
      )}

      {dragState.phase === 'reorder' && frameBox && (
        <DropIndicatorOverlay
          box={iframeRectToScreenBox(
            camera,
            frameBox,
            boxToBridgeRect(dropIndicatorBox(dragState.axis, dragState.siblings, dragState.dropIndex, dragState.parentRect)),
          )}
        />
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
