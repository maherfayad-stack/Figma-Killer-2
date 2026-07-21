import * as React from 'react';
import { FrameShape } from './FrameShape.js';
import { useCameraStore, MIN_ZOOM, MAX_ZOOM, type CameraFrame } from './camera-store.js';
import {
  classifyWheelGesture,
  createPanDragController,
  type PanDragController,
  type WheelEventLike,
} from './camera-gestures.js';
import { createSelectionGestureController, type SelectionGestureController } from './selection-gestures.js';
import {
  createResizeGestureController,
  resizeHandleCursor,
  resizeHandleScreenPoint,
  RESIZE_HANDLES,
  type ResizeGestureController,
  type ResizeHandle,
} from './resize-gestures.js';
import { emitFrameGeometryCommitted } from './frame-geometry-commit.js';
import { selectLiveFrames, DEFAULT_MAX_LIVE_FRAMES } from './viewport-cull.js';
import {
  boxToScreenBox,
  screenPointToPageSpace,
  screenViewportToPageBounds,
  type Box,
  type CameraState,
  type Point,
} from './geometry.js';

/**
 * Sub-workstream 2b (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — `Canvas.tsx`
 * is the plain-React replacement for the `<Tldraw>` mount in
 * `StudioCanvas.tsx`. NOT wired into `StudioCanvas.tsx`/`apps/studio` in
 * this pass — that's sub-workstream 2d. This component:
 *
 *  - renders a root container div (fills its parent, `overflow: hidden`),
 *  - renders one inner "world" div whose CSS `transform` is the ONLY place
 *    the camera is applied — every `FrameShape` child sits at its own
 *    plain page-space `left/top/width/height`, never manually multiplied
 *    by the camera (that's the entire point of the CSS-transform-DOM-
 *    camera approach — see the design doc's "Rendering approach" section),
 *  - measures its own screen (CSS pixel) size via `ResizeObserver` so
 *    `viewport-cull.ts`'s `selectLiveFrames` and the wheel/zoom gestures
 *    below have an accurate viewport size to work with,
 *  - wires up `camera-gestures.ts`'s wheel classification + space/middle
 *    drag-pan controller directly onto the container's native DOM events,
 *  - syncs its `frames` prop into `camera-store.ts` via `setFrames` on
 *    every prop change (the same "external truth -> store" sync shape
 *    `StudioCanvas.tsx`'s own `CanvasFrameRecord[] -> tldraw shape` effect
 *    uses, not its exact tldraw mechanics — our store's `setFrames` already
 *    does a full replace, so there's no per-shape create/update/delete
 *    diffing to replicate here).
 *
 * PROP SHAPE CHOICE: `CanvasFrame` extends `camera-store.ts`'s own
 * `CameraFrame` (`{ id, x, y, w, h }`) with exactly the two extra fields
 * `FrameShape.tsx` needs to render (`name`, `devServerUrl`) — the smallest
 * addition that covers both what the camera store needs (box + id) and
 * what the rendering layer needs (label + iframe src), without pulling in
 * unrelated `CanvasFrameRecord` fields (`fileFolder`, `framePath`) that
 * neither this component nor `FrameShape.tsx` reads. A later sub-workstream
 * mapping the real `CanvasFrameRecord[]` -> this shape is a trivial
 * narrowing projection, same reasoning `camera-store.ts`'s own module doc
 * gives for why `CameraFrame` itself doesn't import `CanvasFrameRecord`.
 *
 * ## Sub-workstream 2c additions: selection, drag-to-move, resize
 * (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2 split) — still NOT
 * wired into `StudioCanvas.tsx`/`apps/studio` in this pass either.
 *
 * - **Frame-hit lookup**: `selection-gestures.ts`'s controller needs to know
 *   "which frame (if any) is under this pointer" on every pointer-down —
 *   a plain DOM data-attribute lookup, `(event.target as
 *   Element)?.closest('[data-ccs-frame-id]')`, against the attribute
 *   `FrameShape.tsx` renders on its own root div (see that file's module
 *   doc). Resolved directly inside the native `pointerdown` listener below,
 *   no cross-component relay needed. The listener ALWAYS runs the existing
 *   `panController` check first regardless of what's under the pointer, so
 *   space/middle-drag panning starting on TOP of a frame still works
 *   exactly as it did before this sub-workstream (the task's own explicit
 *   non-conflict requirement) — only once `panController` DECLINES does
 *   the frame-hit info get used, by `selectionController`.
 * - **Why native `addEventListener`, not JSX `onPointerDown` props**: this
 *   codebase's installed `eslint-plugin-react-hooks` (React-Compiler-
 *   aligned v7) hard-errors (`react-hooks/immutability`) on mutating a
 *   `useMemo`-produced value ANYWHERE in the component except inside a
 *   `useEffect` callback — exactly this file's pre-existing `spaceHeldBox`
 *   pattern (mutated only inside its own `useEffect`'s `keydown`/`keyup`
 *   listeners). `moveStateBox` below needs that same mutable-box shape
 *   (transient, per-gesture, not React state), so its reads/writes are ALL
 *   grouped into one `pointerdown`/`pointermove`/`pointerup`/`pointercancel`
 *   native-listener `useEffect`, mirroring the existing wheel-gesture
 *   effect's own already-lint-clean shape below, rather than as
 *   JSX-prop-bound handlers (which this rule disallows mutating it from). A
 *   second, separate rule (`react-hooks/refs`-adjacent: storing a FUNCTION
 *   reference into a box is flagged even more strictly than storing plain
 *   data) is why `selection-gestures.ts`'s `onFrameDragStart` is a RETURN
 *   VALUE from `onPointerMove` (see that module's `SelectionMoveResult`)
 *   rather than an injected callback — no function-in-a-box needed at all.
 * - **Live geometry, not static props**: once mounted, a frame's on-screen
 *   box comes from `camera-store.ts`'s own `frames` map (subscribed via
 *   `storeFrames` below), NOT from the `frames` PROP array directly. The
 *   prop only seeds the store once (the existing sync effect) and supplies
 *   the static per-frame metadata (`name`, `devServerUrl`) that never
 *   changes from a drag/resize; the LIVE `x/y/w/h` used for rendering are
 *   read from `storeFrames.get(id)` every render, since `setFrameBox` (the
 *   new 2c store action) is what drag-to-move/resize actually write to.
 *   Without this switch, a live move/resize would update the store but the
 *   screen would never reflect it (the old render used the frozen prop
 *   box). NOTE for 2d: if a future caller's `frames` prop identity changes
 *   (e.g. a fresh daemon geometry sync) while a local drag/resize is still
 *   in flight, the sync effect's `setFrames` call fully replaces the store
 *   map and would clobber the in-progress local edit — an accepted,
 *   undecided-for-now interaction this sub-workstream flags rather than
 *   resolves (out of scope: this harness/pass never changes the `frames`
 *   prop reference after mount).
 * - **Drag-to-move**: tracked via `moveStateBox` (again a plain mutable box, not
 *   state — per-gesture transient data), populated (inside the pointer-event
 *   effect below) with a SNAPSHOT of every currently-selected frame's box the
 *   moment `selectionController.onPointerMove` returns a `'frame-drag-start'`
 *   result (moving the whole multi-selection together, maintaining relative
 *   positions — the task's preferred behavior over the simpler "move just the
 *   dragged frame" fallback). Every subsequent pointer-move computes one
 *   page-space delta and applies it to every frame in that snapshot via
 *   `setFrameBox`; pointer-up applies the same delta one final time and
 *   fires `emitFrameGeometryCommitted` for each moved frame (the "gesture
 *   finished, persist me" signal a later sub-workstream, 2d, will subscribe
 *   to).
 * - **Resize handles**: rendered by the `ResizeHandles` component below, ONLY when
 *   exactly one frame is selected, as 8 small screen-space squares (corners
 *   + edge midpoints — the full standard set, see `resize-gestures.ts`'s
 *   module doc) positioned via `resizeHandleScreenPoint` +
 *   `boxToScreenBox`. Each handle is its own DOM element layered on TOP of
 *   the frame (so it always wins native hit-testing over the frame body
 *   underneath) with its own `stopPropagation`'d pointer-down (unlike
 *   `FrameShape`'s own relay, a handle drag must NEVER be mistaken for a
 *   frame click/move) driving `resize-gestures.ts`'s
 *   `createResizeGestureController` directly; the same
 *   `emitFrameGeometryCommitted` pub-sub fires on resize-end as on
 *   move-end (a resize is just another kind of "box changed" event, per
 *   that module's own doc).
 */
export interface CanvasFrame extends CameraFrame {
  /** Filename without extension — the chrome header label. */
  name: string;
  /** Full iframe src, already including `?frame=<Name>`. */
  devServerUrl: string;
}

export interface CanvasProps {
  frames: CanvasFrame[];
  className?: string;
  style?: React.CSSProperties;
  /**
   * Phase 3b (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2 mapping
   * table: "`onDoubleClick` -> edit mode ... Plain `onDoubleClick` prop on
   * `FrameShape.tsx`") — fired when a native browser `dblclick` lands on a
   * frame (resolved the same `data-ccs-frame-id` way `handlePointerDown`
   * hit-tests, and past the same `isResizeHandleTarget` guard). `Canvas`
   * itself already snaps the camera to the frame's bounds (mirroring
   * `frame-shape.tsx`'s tldraw `CcsFrameShapeUtil.onDoubleClick`'s
   * `editor.zoomToBounds` call — see `handleDoubleClick` below) since that's
   * squarely this file's own camera-store concern; this callback exists so
   * the CALLER can additionally record `selection-store.ts`'s
   * `editModeFrame` with the daemon-facing `fileFolder`/`framePath` this
   * engine-agnostic file deliberately doesn't carry (see `CanvasFrame`'s own
   * doc for why — same reasoning applies here).
   *
   * `previousCamera` is the camera snapshot from BEFORE `zoomToBounds` was
   * applied — deliberately captured first (see `handleDoubleClick`'s own
   * comment for why the ORDER here matters): `selection-store.ts`'s
   * `enterEditMode` records whatever camera it's given as the value Esc
   * restores on exit, and tldraw's own `CcsFrameShapeUtil.onDoubleClick`
   * reads `editor.getCamera()` BEFORE its own `zoomToBounds` call for
   * exactly this reason — get this backwards and every edit-mode exit
   * "restores" to the just-zoomed-in view instead of undoing it, which
   * silently ratchets the camera in tighter on every double-click a test
   * (or a real user) performs, never zooming back out. Confirmed
   * empirically: getting this wrong here didn't fail the double-click test
   * itself, only a LATER one (`panUntilOnScreen` timing out trying to
   * reach a different, far-away frame from a camera that never zoomed back
   * out) — a good reminder that this ordering bug is easy to miss by only
   * testing the immediate gesture in isolation. */
  onFrameDoubleClick?: (frameId: string, previousCamera: CameraState) => void;
}

const CONTAINER_STYLE: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  touchAction: 'none',
  userSelect: 'none',
};

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function Canvas({ frames, className, style, onFrameDoubleClick }: CanvasProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const camera = useCameraStore((s) => s.camera);
  const selectedIds = useCameraStore((s) => s.selectedIds);
  // Sub-workstream 2c: LIVE per-frame geometry (see module doc's "Live
  // geometry, not static props" section) — subscribed so a `setFrameBox`
  // call from a drag/resize triggers a re-render with the new box.
  const storeFrames = useCameraStore((s) => s.frames);

  // --- sync the `frames` prop into camera-store.ts -----------------------
  // Mirrors (not the exact mechanics of) `StudioCanvas.tsx`'s own
  // `CanvasFrameRecord[] -> tldraw shape` sync effect: external truth (the
  // caller's `frames` prop) flows INTO the store, one direction, every time
  // it changes. `setFrames` already does a full-map replace, so there's no
  // per-frame create/update/delete diff to hand-roll here.
  React.useEffect(() => {
    useCameraStore
      .getState()
      .setFrames(frames.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
  }, [frames]);

  // --- measure the container's own screen (CSS pixel) size ---------------
  // No existing precedent for this in the repo (tldraw manages its own
  // sizing internally, so `StudioCanvas.tsx` never needed to) — a standard
  // `ResizeObserver` in an effect, per the sub-workstream brief.
  const [screenSize, setScreenSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const screenSizeRef = React.useRef(screenSize);
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      screenSizeRef.current = next;
      setScreenSize(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- live/placeholder decision for ALL frames, once per camera/size/frames change --
  // Keyed off `storeFrames` (LIVE boxes), not the `frames` prop, so culling
  // stays correct for a frame currently mid-drag/resize.
  const liveIds = React.useMemo(() => {
    if (screenSize.w === 0 && screenSize.h === 0) return new Set<string>();
    const viewportPageBounds = screenViewportToPageBounds(camera, screenSize);
    const boxes = new Map<string, Box>();
    for (const frame of storeFrames.values()) boxes.set(frame.id, { x: frame.x, y: frame.y, w: frame.w, h: frame.h });
    return selectLiveFrames(viewportPageBounds, boxes, { maxLive: DEFAULT_MAX_LIVE_FRAMES });
  }, [camera, screenSize, storeFrames]);

  // --- space-held tracker for `createPanDragController`'s `isSpaceHeld` --
  // Simplest correct approach per the brief: a mutable box flipped by
  // window keydown/keyup, not app state anything else needs to read.
  // Deliberately a plain `useMemo`-created object rather than `useRef` —
  // `react-hooks/refs` flags ANY `ref.current` access reachable from a
  // function invoked during render (even nested inside a callback that
  // itself only runs later), which the lazy `useState` initializer below
  // counts as; a non-ref mutable box sidesteps that without changing the
  // actual behavior (still a stable, effect-free, per-component box).
  const spaceHeldBox = React.useMemo(() => ({ held: false }), []);
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldBox.held = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldBox.held = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [spaceHeldBox]);

  // --- space+drag / middle-drag pan controller (camera-gestures.ts) ------
  // Lazy-initialized via `useState`'s initializer form so the controller is
  // constructed exactly once and its identity stays stable across
  // re-renders.
  const [panController] = React.useState<PanDragController>(() =>
    createPanDragController({
      onPan: (dx, dy) => useCameraStore.getState().pan(dx, dy),
      isSpaceHeld: () => spaceHeldBox.held,
    }),
  );

  // --- sub-workstream 2c: selection (click/shift-click/marquee) ----------
  // See the module doc's "Sub-workstream 2c additions" section for the
  // full frame-hit relay / live-geometry / drag-to-move / resize-handle
  // design this and the blocks below implement together.

  /** The in-progress drag-to-move gesture's snapshot, or `null` when no
   * move is active. A plain mutable box (not `useRef`) — same reason as
   * this file's pre-existing `spaceHeldBox` above (see this doc's "Why
   * native addEventListener" section): only ever mutated inside the
   * `pointerdown`/`pointermove`/`pointerup` `useEffect` below, the one
   * lint-exempt zone for mutating a `useMemo`-produced value. */
  const moveStateBox = React.useMemo<{
    current: { pointerId: number; startPagePoint: Point; originalBoxes: Map<string, Box> } | null;
  }>(() => ({ current: null }), []);

  const [marqueeBox, setMarqueeBox] = React.useState<Box | null>(null);

  // `selectionController.onPointerMove` RETURNS a `SelectionMoveResult`
  // (rather than taking an injected `onFrameDragStart` callback) precisely
  // so the drag-to-move-start reaction — which needs to mutate
  // `moveStateBox` — can live in the pointer-event `useEffect` below (the
  // lint-exempt zone) instead of inside this `useState` lazy initializer
  // (a "during render" call `eslint-plugin-react-hooks` disallows box
  // mutation from, and disallows storing a callback INTO a box for either,
  // per two separate rules both hit while iterating on this — see that
  // effect's own comment for the full reasoning).
  const [selectionController] = React.useState<SelectionGestureController>(() =>
    createSelectionGestureController({
      getSelectedIds: () => useCameraStore.getState().selectedIds,
      getFrameBoxes: () => useCameraStore.getState().frames,
      select: (ids) => useCameraStore.getState().select(ids),
      clearSelection: () => useCameraStore.getState().clearSelection(),
      onMarqueeChange: setMarqueeBox,
    }),
  );

  const [resizeController] = React.useState<ResizeGestureController>(() =>
    createResizeGestureController({
      onResize: (frameId, box) => useCameraStore.getState().setFrameBox(frameId, box),
      onResizeEnd: (frameId, box) => {
        useCameraStore.getState().setFrameBox(frameId, box);
        emitFrameGeometryCommitted({ id: frameId, ...box });
      },
    }),
  );

  /** Converts a native pointer event's `clientX/clientY` into BOTH the
   * screen-space point (relative to this container's own top-left, matching
   * every other screen-space convention in this file) and the page-space
   * point (via `screenPointToPageSpace` fed the CURRENT camera) — every
   * pointer handler below needs both. */
  const toPoints = React.useCallback((e: { clientX: number; clientY: number }): { screenPoint: Point; pagePoint: Point } => {
    const rect = containerRef.current?.getBoundingClientRect();
    const screenPoint: Point = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: e.clientX, y: e.clientY };
    const pagePoint = screenPointToPageSpace(useCameraStore.getState().camera, screenPoint);
    return { screenPoint, pagePoint };
  }, []);

  /** Resolves the frame (if any) a native pointer event's `target` landed
   * on, via the `data-ccs-frame-id` attribute `FrameShape.tsx` renders on
   * its own root div (see that file's module doc) — plain DOM
   * hit-testing, no React involved. */
  function frameIdFromEventTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const hit = target.closest('[data-ccs-frame-id]');
    return hit ? hit.getAttribute('data-ccs-frame-id') : null;
  }

  /**
   * Phase 3b fix: whether a native pointer event's `target` landed on one of
   * `ResizeHandles`' own overlay divs (`data-ccs-resize-handle`, set below).
   *
   * Root cause this guards against: `ResizeHandles` renders each handle as a
   * FIXED SCREEN-SPACE size (`HANDLE_SIZE = 8px`), positioned via
   * `resizeHandleScreenPoint` — the 'n' (north/top-edge) handle sits at the
   * selected frame's horizontal center, right at its top edge, which is
   * exactly where a click on `FrameShape.tsx`'s chrome header (which spans
   * the frame's full width, vertically centered a few px below the frame's
   * top edge) lands. At a typical zoomed-out camera (routine once more than
   * a couple of frames are on screen — the whole `viewport-cull.ts` design
   * assumes many frames fit in one viewport), the header's ON-SCREEN height
   * shrinks with zoom while the handle's 8px hit-box does NOT (it's rendered
   * in screen space, a sibling of the transformed world div, same as
   * `resizeHandleScreenPoint`'s own doc explains) — so the handle's hit-box
   * ends up covering the header's vertical center, and the handle (being
   *`zIndex: 10`, painted after the frame) wins the browser's hit-test.
   *
   * `ResizeHandles`' own `onPointerDown` already calls `e.stopPropagation()`
   * on the React `SyntheticEvent`, but that does NOT stop THIS file's own
   * plain `el.addEventListener('pointerdown', ...)` below from also
   * running: `containerRef.current` (where that listener lives) is a DOM
   * ANCESTOR of the handle, strictly BETWEEN the handle and wherever React's
   * root-delegated listener is attached, so the native bubble phase reaches
   * this file's listener FIRST, before React's synthetic dispatch (and
   * therefore before `stopPropagation()`) ever runs. Confirmed empirically:
   * without this guard, a double-click on a zoomed-out frame's header
   * lands its SECOND pointerdown on the 'n' handle, which
   * `frameIdFromEventTarget` (rightly) doesn't recognize as a frame hit, so
   * `selectionController` treats it as an empty-background click and
   * `clearSelection()`s on the matching pointerup — silently undoing the
   * FIRST click's selection (and the edit-mode entry it triggered) a moment
   * later, which is exactly the bug that made
   * `p2-selection.spec.ts`'s double-click test flake/fail on this engine.
   *
   * The fix: recognize a resize-handle target explicitly and bail out of
   * `handlePointerDown` before either `panController` or
   * `selectionController` sees the event at all — the handle's own
   * `onPointerDown` (a normal React prop, still dispatched independently)
   * remains the sole owner of starting its resize gesture.
   */
  function isResizeHandleTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-ccs-resize-handle]') !== null;
  }

  // --- click/shift-click/marquee/drag-to-move: one native-listener effect
  // -------------------------------------------------------------------------
  // See this file's module doc ("Why native addEventListener, not JSX
  // onPointerDown props") for why this is a `useEffect` (mirroring the
  // wheel-gesture effect just below) rather than JSX-bound handlers: this
  // is the only lint-clean place to mutate `moveStateBox`.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    /** Snapshots every currently-selected frame's box into `moveStateBox`,
     * in response to `selectionController.onPointerMove` returning
     * `{ type: 'frame-drag-start', ... }` (see `selection-gestures.ts`'s
     * `SelectionMoveResult` doc) — moves the WHOLE current selection
     * together, maintaining relative positions (the task's preferred
     * multi-select-move behavior), so every subsequent pointer-move
     * computes ONE shared delta from this fixed original rather than
     * compounding per-frame drift. */
    function handleFrameDragStart(pointerId: number, startPagePoint: Point): void {
      const store = useCameraStore.getState();
      const originalBoxes = new Map<string, Box>();
      for (const id of store.selectedIds) {
        const box = store.frames.get(id);
        if (box) originalBoxes.set(id, { x: box.x, y: box.y, w: box.w, h: box.h });
      }
      moveStateBox.current = { pointerId, startPagePoint, originalBoxes };
    }

    function handlePointerDown(e: PointerEvent): void {
      // See `isResizeHandleTarget`'s doc above — a resize handle's own
      // `onPointerDown` owns this event entirely; letting it fall through
      // to `selectionController` below would misread it as an empty-
      // background click (the handle has no `data-ccs-frame-id` ancestor)
      // and clear whatever's currently selected.
      if (isResizeHandleTarget(e.target)) return;

      const hitFrameId = frameIdFromEventTarget(e.target);

      const started = panController.onPointerDown({
        pointerId: e.pointerId,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      if (started) {
        e.preventDefault();
        el!.setPointerCapture(e.pointerId);
        return;
      }

      // Pan declined this event — selection-gestures.ts's turn. Only the
      // primary (left) button drives click/shift-click/marquee/drag-move.
      if (e.button !== 0) return;

      const { screenPoint, pagePoint } = toPoints(e);
      selectionController.onPointerDown({
        pointerId: e.pointerId,
        screenPoint,
        pagePoint,
        shiftKey: e.shiftKey,
        frameId: hitFrameId,
      });
      el!.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: PointerEvent): void {
      panController.onPointerMove({
        pointerId: e.pointerId,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });

      const { screenPoint, pagePoint } = toPoints(e);

      const moveResult = selectionController.onPointerMove({
        pointerId: e.pointerId,
        screenPoint,
        pagePoint,
        shiftKey: e.shiftKey,
        frameId: null,
      });
      if (moveResult.type === 'frame-drag-start') {
        handleFrameDragStart(e.pointerId, moveResult.startPagePoint);
      }

      const moveState = moveStateBox.current;
      if (moveState && moveState.pointerId === e.pointerId) {
        const dx = pagePoint.x - moveState.startPagePoint.x;
        const dy = pagePoint.y - moveState.startPagePoint.y;
        const store = useCameraStore.getState();
        for (const [id, box] of moveState.originalBoxes) {
          store.setFrameBox(id, { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
        }
      }

      resizeController.onPointerMove(e.pointerId, pagePoint);
    }

    function handlePointerUp(e: PointerEvent): void {
      panController.onPointerUp({
        pointerId: e.pointerId,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });

      const { screenPoint, pagePoint } = toPoints(e);

      const moveState = moveStateBox.current;
      if (moveState && moveState.pointerId === e.pointerId) {
        const dx = pagePoint.x - moveState.startPagePoint.x;
        const dy = pagePoint.y - moveState.startPagePoint.y;
        const store = useCameraStore.getState();
        for (const [id, box] of moveState.originalBoxes) {
          const finalBox = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
          store.setFrameBox(id, finalBox);
          emitFrameGeometryCommitted({ id, ...finalBox });
        }
        moveStateBox.current = null;
      }

      resizeController.onPointerUp(e.pointerId, pagePoint);

      selectionController.onPointerUp({
        pointerId: e.pointerId,
        screenPoint,
        pagePoint,
        shiftKey: e.shiftKey,
        frameId: null,
      });
    }

    el.addEventListener('pointerdown', handlePointerDown);
    el.addEventListener('pointermove', handlePointerMove);
    el.addEventListener('pointerup', handlePointerUp);
    el.addEventListener('pointercancel', handlePointerUp);
    return () => {
      el.removeEventListener('pointerdown', handlePointerDown);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', handlePointerUp);
      el.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [panController, selectionController, resizeController, toPoints, moveStateBox]);

  // --- Phase 3b: double-click a frame -> zoom-to-bounds + notify the caller
  // -------------------------------------------------------------------------
  // Native `dblclick`, not hand-rolled two-clicks-within-a-window detection:
  // the browser already does exactly this timing/target-matching work (and
  // does it consistently with every other double-click affordance on the
  // page), so there's no reason to reimplement it. `onFrameDoubleClick` is
  // read via a ref (not a `useEffect` dependency) so this listener is
  // registered exactly once per mount, same "stable native listener, fresh
  // callback read at call time" shape `screenSizeRef`/`toPoints` already use
  // elsewhere in this file — the prop's identity is free to change every
  // render (`CustomEngineCanvas.tsx`'s call site doesn't need to memoize it)
  // without tearing down and re-adding the DOM listener.
  const onFrameDoubleClickRef = React.useRef(onFrameDoubleClick);
  React.useEffect(() => {
    onFrameDoubleClickRef.current = onFrameDoubleClick;
  }, [onFrameDoubleClick]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleDoubleClick(e: MouseEvent): void {
      // Resolving the frame under a double-click is NOT simply
      // `frameIdFromEventTarget(e.target)`: the FIRST of the two clicks
      // already ran through `handlePointerDown` above and (for a
      // previously-unselected frame — the common case this whole gesture
      // exists for) selected it, which immediately renders `ResizeHandles`
      // over it (this engine's "frictionless single-click activation" —
      // see `CameraFrameSelectionSync`'s doc — means "selected" and "in
      // edit mode" are the same state, so this happens on every fresh
      // double-click, not just an edge case). If the SECOND click's screen
      // position happens to land inside one of those handles' small
      // screen-space hit-boxes (routine at the zoomed-OUT camera levels a
      // multi-frame project starts at — see `isResizeHandleTarget`'s doc),
      // the handle's own `setPointerCapture` redirects the browser's
      // derived `click`/`dblclick` events to TARGET THE HANDLE, not the
      // frame underneath — confirmed empirically (without this fallback,
      // `e.target` resolves to `[data-testid="ccs-resize-handle-n"]` and a
      // naive bail-out here would silently skip the zoom-to-bounds this
      // whole handler exists to perform, which in turn leaves the camera at
      // the zoomed-out scale that CAUSED the handle collision in the first
      // place — a self-perpetuating bug).
      //
      // Since `ResizeHandles` only ever renders for the SOLE selected
      // frame (`Canvas`'s own render, `soleSelectedId`), a resize-handle
      // target is unambiguous: it can only belong to that one frame. Fall
      // back to it instead of bailing out.
      const hitFrameId = isResizeHandleTarget(e.target)
        ? (Array.from(useCameraStore.getState().selectedIds)[0] ?? null)
        : frameIdFromEventTarget(e.target);
      if (!hitFrameId) return;

      // Captured BEFORE `zoomToBounds` runs, on purpose — see
      // `CanvasProps.onFrameDoubleClick`'s own doc for why getting this
      // ordering backwards is a real, easy-to-miss bug (it doesn't fail
      // THIS gesture, only a later edit-mode exit's camera restore).
      const previousCamera = useCameraStore.getState().camera;

      // Mirrors `frame-shape.tsx`'s tldraw `CcsFrameShapeUtil.onDoubleClick`:
      // snap the camera to fit this frame's current box. `camera-store.ts`
      // has no move-animation support yet (2a/2b never built easing — see
      // `CustomEngineCanvas.tsx`'s own disclosed-simplifications doc), so
      // this is an instant jump rather than tldraw's `{animation:{duration:
      // 200}}` tween — a known, already-disclosed gap, not something new
      // introduced here.
      const box = useCameraStore.getState().frames.get(hitFrameId);
      if (box) {
        useCameraStore.getState().zoomToBounds(box, screenSizeRef.current);
      }

      onFrameDoubleClickRef.current?.(hitFrameId, previousCamera);
    }

    el.addEventListener('dblclick', handleDoubleClick);
    return () => el.removeEventListener('dblclick', handleDoubleClick);
  }, []);

  // --- wheel gestures (classifyWheelGesture: ctrl/meta=zoom, shift=h-pan,
  // plain=v-pan) -----------------------------------------------------------
  // A native (non-React) listener with `{ passive: false }` so
  // `preventDefault` actually suppresses the browser's native ctrl+wheel
  // zoom / scroll — React's synthetic wheel handler is attached passively
  // by default and can't reliably do this.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleWheel(e: WheelEvent): void {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const eventLike: WheelEventLike = {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        // `geometry.ts`'s screen space is relative to THIS container's own
        // top-left (matches `screenViewportToPageBounds`'s `{0,0}` ==
        // container top-left convention above), so raw `clientX/clientY`
        // must be offset by the container's own bounding rect.
        clientX: e.clientX - rect.left,
        clientY: e.clientY - rect.top,
      };
      const action = classifyWheelGesture(eventLike);
      const store = useCameraStore.getState();
      if (action.type === 'pan') {
        store.pan(action.dx, action.dy);
      } else {
        const newZoom = clampZoom(store.camera.z * action.factor);
        store.zoomAtPoint(newZoom, action.point, screenSizeRef.current);
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // --- the camera transform itself ----------------------------------------
  // `geometry.ts`'s convention (`pagePointToScreenSpace`): `screen = (page +
  // camera) * z`. A child positioned at plain page-space `left: x, top: y`
  // needs its FINAL on-screen position to equal `(x + camera.x) * z`. If the
  // world div itself carries `transform: translate(tx, ty) scale(z)` with
  // `transformOrigin: '0 0'`, a child at local position `x` ends up at
  // `tx + x * z` in the parent's coordinate space. Setting `tx = camera.x *
  // z` (and `ty = camera.y * z`) makes that `camera.x * z + x * z = (x +
  // camera.x) * z` — exactly the target. So the transform is
  // `translate3d(camera.x * z, camera.y * z, 0) scale(z)`, verified by hand
  // against `computeCameraToFitBounds` in `geometry.ts` (which centers the
  // camera the same way: `camera.x = viewport.w/2/zoom - centerX`, i.e. it
  // solves for the `camera.x` that makes `pagePointToScreenSpace` of the
  // fit box's center land on the viewport's center).
  const worldStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: '0 0',
    transform: `translate3d(${camera.x * camera.z}px, ${camera.y * camera.z}px, 0) scale(${camera.z})`,
    willChange: 'transform',
  };

  // --- sub-workstream 2c: marquee overlay + resize handles, both in SCREEN
  // space (siblings of the transformed `world` div, not children of it —
  // matching `bridge-geometry.ts`'s existing overlay convention of
  // rendering hover/selection boxes in screen space via `boxToScreenBox`
  // rather than inheriting the world div's own CSS transform). ------------
  const marqueeScreenBox = React.useMemo(
    () => (marqueeBox ? boxToScreenBox(camera, marqueeBox) : null),
    [camera, marqueeBox],
  );

  // Resize handles render only when EXACTLY one frame is selected (per the
  // task brief) — reads the frame's LIVE box from `storeFrames`, same
  // "live, not static prop" reasoning as the main render loop below.
  const soleSelectedId = selectedIds.size === 1 ? (Array.from(selectedIds)[0] ?? null) : null;
  const soleSelectedBox = soleSelectedId ? (storeFrames.get(soleSelectedId) ?? null) : null;
  const soleSelectedScreenBox = soleSelectedBox ? boxToScreenBox(camera, soleSelectedBox) : null;

  return (
    <div ref={containerRef} className={className} style={{ ...CONTAINER_STYLE, ...style }}>
      <div style={worldStyle}>
        {frames.map((frame) => {
          // Live box from the store (see module doc) — falls back to the
          // prop's own box only in the impossible-in-practice case the sync
          // effect hasn't run yet for this id.
          const liveBox = storeFrames.get(frame.id) ?? frame;
          return (
            <FrameShape
              key={frame.id}
              id={frame.id}
              x={liveBox.x}
              y={liveBox.y}
              w={liveBox.w}
              h={liveBox.h}
              name={frame.name}
              devServerUrl={frame.devServerUrl}
              live={liveIds.has(frame.id)}
              selected={selectedIds.has(frame.id)}
            />
          );
        })}
      </div>

      {marqueeScreenBox && (
        <div
          data-testid="ccs-marquee"
          style={{
            position: 'absolute',
            left: marqueeScreenBox.x,
            top: marqueeScreenBox.y,
            width: marqueeScreenBox.w,
            height: marqueeScreenBox.h,
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid #3b82f6',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}

      {soleSelectedId && soleSelectedBox && soleSelectedScreenBox && (
        <ResizeHandles
          screenBox={soleSelectedScreenBox}
          onHandlePointerDown={(handle, e) => {
            if (e.button !== 0) return;
            const { pagePoint } = toPoints(e);
            resizeController.startResize(soleSelectedId, handle, soleSelectedBox, pagePoint, e.pointerId);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onHandlePointerMove={(_handle, e) => {
            const { pagePoint } = toPoints(e);
            resizeController.onPointerMove(e.pointerId, pagePoint);
          }}
          onHandlePointerUp={(_handle, e) => {
            const { pagePoint } = toPoints(e);
            resizeController.onPointerUp(e.pointerId, pagePoint);
          }}
        />
      )}
    </div>
  );
}

/**
 * Sub-workstream 2c — the 8 corner/edge resize-handle overlay for the ONE
 * selected frame, rendered as a sibling overlay by `Canvas` itself (not
 * inside `FrameShape.tsx`) so it can sit in plain SCREEN space (see
 * `Canvas`'s render, above) rather than inside the camera-transformed
 * world div. Purely presentational + pointer-event plumbing — all the
 * actual resize MATH lives in `resize-gestures.ts`.
 */
function ResizeHandles({
  screenBox,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
}: {
  screenBox: Box;
  onHandlePointerDown: (handle: ResizeHandle, e: React.PointerEvent<HTMLDivElement>) => void;
  onHandlePointerMove: (handle: ResizeHandle, e: React.PointerEvent<HTMLDivElement>) => void;
  onHandlePointerUp: (handle: ResizeHandle, e: React.PointerEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  const HANDLE_SIZE = 8;
  return (
    <>
      {RESIZE_HANDLES.map((handle) => {
        const point = resizeHandleScreenPoint(screenBox, handle);
        return (
          <div
            key={handle}
            data-testid={`ccs-resize-handle-${handle}`}
            // Phase 3b fix: read by `isResizeHandleTarget` above —
            // `handlePointerDown`'s native container-level listener bails
            // out entirely for any target under one of these divs, rather
            // than relying on `stopPropagation()` below to keep it from
            // running (that assumption turned out to be WRONG: a plain
            // `addEventListener` on `containerRef` — an ANCESTOR of this
            // handle, and of wherever React's own root-delegated listener
            // attaches — fires during the native bubble phase before
            // React's synthetic dispatch (and therefore this
            // `stopPropagation()`) ever runs, so the container-level
            // listener saw every resize-handle pointerdown regardless; see
            // `isResizeHandleTarget`'s own doc for the full empirical
            // trace of the bug this caused).
            data-ccs-resize-handle="true"
            // `stopPropagation` on EVERY pointer event here, not just
            // pointerdown: once `onPointerDown` calls `setPointerCapture`,
            // the browser redirects subsequent move/up events to this
            // element but they still BUBBLE normally afterward — without
            // this, they'd also reach `Canvas.tsx`'s own container-level
            // native listener. That listener's own controllers all no-op
            // for a pointerId they never saw a matching (non-bailed-out)
            // pointerdown for, so this remains harmless-but-correct
            // belt-and-suspenders now that `handlePointerDown` itself also
            // bails out via `data-ccs-resize-handle` above.
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandlePointerDown(handle, e);
            }}
            onPointerMove={(e) => {
              e.stopPropagation();
              onHandlePointerMove(handle, e);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              onHandlePointerUp(handle, e);
            }}
            onPointerCancel={(e) => {
              e.stopPropagation();
              onHandlePointerUp(handle, e);
            }}
            style={{
              position: 'absolute',
              left: point.x,
              top: point.y,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              transform: 'translate(-50%, -50%)',
              background: '#fff',
              border: '1.5px solid #3b82f6',
              borderRadius: 2,
              cursor: resizeHandleCursor(handle),
              touchAction: 'none',
              zIndex: 10,
            }}
          />
        );
      })}
    </>
  );
}
