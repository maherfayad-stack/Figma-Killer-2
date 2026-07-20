import { distance, DRAG_THRESHOLD_PX } from './drag-geometry.js';
import { boxesIntersect, type Box, type Point } from './geometry.js';

/**
 * Sub-workstream 2c (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2
 * split) — click / shift-click / marquee selection over `camera-store.ts`,
 * replacing tldraw's native click-to-select + rubber-band marquee. PURE
 * LOGIC ONLY, mirroring `camera-gestures.ts`'s `createPanDragController`
 * pattern: a factory returning stateful pointer handlers, closed over
 * private mutable gesture state, with every side effect (mutating
 * selection, reading frame boxes) injected as a callback rather than this
 * module importing `camera-store.ts` directly — same reasoning that
 * module's own doc gives (store-agnostic, trivially testable with spies,
 * zero DOM coupling: pointer events are modeled as plain-object shapes).
 *
 * `Canvas.tsx` only ever calls this controller's handlers once
 * `camera-gestures.ts`'s `PanDragController.onPointerDown` has already
 * DECLINED the event (returned `false`) — this controller has no opinion
 * on space/middle-drag panning and never needs to, by construction.
 *
 * ## Frame hit-testing is the CALLER's job, not this module's
 * Knowing "which frame (if any) is under this pointer" is DOM hit-testing
 * (`FrameShape.tsx`'s own root div receiving the native pointer event vs.
 * the container background receiving it) — this pure controller can't do
 * that itself. `Canvas.tsx` resolves it (via a small ref relayed by
 * `FrameShape`'s own `onFramePointerDown` prop bubbling up to the
 * container, see that file's module doc) and passes the result in as
 * `frameId` on every `onPointerDown` call: a frame's id, or `null` for
 * empty canvas background.
 *
 * ## One pointer-down resolves to exactly one of four outcomes
 * A single pointer-down/move/up cycle ends up as exactly one of:
 *  1. **Plain click on background** (no drag) → `clearSelection()`.
 *  2. **Marquee drag from background** (drag past threshold) → on
 *     pointer-up, `select()` (or, if shift was held at pointer-down, a
 *     UNION with the existing selection) every frame whose box intersects
 *     the final marquee box.
 *  3. **Plain click on a frame** (no drag) → `select([frameId])` — this
 *     happens EITHER immediately at pointer-down (a previously unselected
 *     frame, or any shift-click, toggles immediately — see below) OR is
 *     deferred to pointer-up (a frame that was ALREADY part of the
 *     selection, clicked with no shift: kept as-is through pointer-move so
 *     a drag can move the whole existing multi-selection without
 *     collapsing it first, and only collapsed to a single selection on
 *     pointer-up if no drag actually happened).
 *  4. **Drag-to-move start**: pointer-down lands on a frame, no shift held,
 *     and the pointer moves past `DRAG_THRESHOLD_PX` before release. This
 *     controller recognizes this transition (it already tracks the
 *     threshold) and reports it via `onPointerMove`'s return value
 *     (`{ type: 'frame-drag-start', ... }`, see {@link SelectionMoveResult}),
 *     but does NOT itself
 *     move anything — moving frames is `Canvas.tsx`'s job (this module is
 *     "selection", not "geometry editing"). No selection change happens on
 *     pointer-up for this outcome (the frame — or frames, for a pre-existing
 *     multi-selection — stays exactly as selected as it was when the drag
 *     started).
 *
 * Shift-click ALWAYS toggles immediately at pointer-down (never deferred,
 * never starts a drag-to-move) — shift is a multi-select-adjustment
 * modifier, not a move-trigger, a deliberate simplification documented here
 * for a later parity-verification pass to weigh in on if it ever matters.
 */

export interface SelectionGesturePointerInfo {
  pointerId: number;
  /** Screen-space point (CSS px, relative to the canvas container's own
   * top-left) — used ONLY for the click-vs-drag `DRAG_THRESHOLD_PX` check,
   * matching `drag-geometry.ts`'s own "movement (screen px)" convention. */
  screenPoint: Point;
  /** Page-space point (same space `camera-store.ts`'s `frames` boxes live
   * in) — used for the marquee box and its `boxesIntersect` hit-testing.
   * The caller converts screen -> page via `geometry.ts`'s
   * `screenPointToPageSpace` fed with the CURRENT camera; this module never
   * touches a camera itself (zero `CameraState` dependency, kept purely in
   * page space once handed a point). */
  pagePoint: Point;
  shiftKey: boolean;
  /** Which frame (if any) DOM hit-testing found under this pointer, or
   * `null` for empty canvas background. Only read by `onPointerDown` — the
   * `onPointerMove`/`onPointerUp` calls don't need it (the gesture already
   * knows what it started on), so callers may pass `null` for those. */
  frameId: string | null;
}

export interface SelectionGestureOptions {
  /** Current selection snapshot, read FRESH on every call (never cached by
   * this controller) — same "read live from the store at call time"
   * convention `camera-store.ts`'s own actions use internally via `get()`. */
  getSelectedIds: () => ReadonlySet<string>;
  /** All frame boxes, in PAGE space, for marquee hit-testing. Read fresh on
   * every marquee-resolving pointer-up (and NOT cached at marquee-start) so
   * a frame that's been moved/resized mid-marquee-drag by some other
   * concern is tested against its CURRENT box, not a stale one. */
  getFrameBoxes: () => ReadonlyMap<string, Box>;
  /** Replaces the whole selection — `camera-store.ts`'s existing `select`
   * action, called directly (this controller computes toggle/union
   * semantics itself rather than requiring a separate `toggle` store
   * action, so no new selection-related store action is needed at all). */
  select: (ids: string[]) => void;
  clearSelection: () => void;
  /** Called with the marquee's current box (PAGE space) on every update
   * while a background marquee-drag is in progress, and with `null` the
   * moment it ends (pointer-up) or was never active — the caller uses this
   * to render (via `geometry.ts`'s `boxToScreenBox`) or hide the rubber-band
   * overlay. */
  onMarqueeChange: (box: Box | null) => void;
}

/**
 * `onPointerMove`'s result — see outcome 4 in the module doc above. A
 * RETURNED descriptor (matching `camera-gestures.ts`'s `classifyWheelGesture`
 * return-a-descriptor style) rather than an injected `onFrameDragStart`
 * callback: `Canvas.tsx` needs to react to this exactly once, the instant
 * the drag threshold is crossed, by snapshotting every selected frame's
 * CURRENT box — logic that itself needs to mutate `Canvas.tsx`'s own
 * transient move-gesture state. A callback baked into this controller's
 * options (constructed once, outside the render that eventually calls it)
 * has no lint-clean way to reach that mutation (a project-wide
 * `eslint-plugin-react-hooks` constraint — see `Canvas.tsx`'s module doc);
 * a plain return value sidesteps the whole problem, and reads better besides
 * (the caller's `onPointerMove` call site sees directly what happened).
 */
export type SelectionMoveResult =
  | { type: 'none' }
  | { type: 'marquee-update' }
  /** Fired exactly once per gesture, the instant a pointer-down that landed
   * on a frame (with no shift key) crosses `DRAG_THRESHOLD_PX`.
   * `startPagePoint` is the pointer's page-space position at the ORIGINAL
   * pointer-down (not the current move), handed back so the caller doesn't
   * need to remember it separately. `frameId` is guaranteed to be a member
   * of the CURRENT selection by the time this fires (see the module doc's
   * outcome 3/4 — either it was already selected, or pointer-down just
   * selected it). */
  | { type: 'frame-drag-start'; frameId: string; startPagePoint: Point };

export interface SelectionGestureController {
  onPointerDown(info: SelectionGesturePointerInfo): void;
  onPointerMove(info: SelectionGesturePointerInfo): SelectionMoveResult;
  onPointerUp(info: SelectionGesturePointerInfo): void;
  /** Whether a background marquee-drag is CURRENTLY in progress (past the
   * drag threshold) — exposed mostly for tests/debugging; `Canvas.tsx`
   * itself only needs `onMarqueeChange`'s box to render the overlay. */
  isMarqueeActive(): boolean;
}

type GestureMode =
  | { kind: 'idle' }
  | {
      kind: 'pendingBackground';
      pointerId: number;
      screenStart: Point;
      pageStart: Point;
      shiftKey: boolean;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      screenStart: Point;
      pageStart: Point;
      shiftKey: boolean;
    }
  | {
      kind: 'pendingFrame';
      pointerId: number;
      frameId: string;
      screenStart: Point;
      pageStart: Point;
      shiftKey: boolean;
      /** Whether pointer-up (with no drag) should collapse the selection to
       * just this frame — true only for "was already selected, no shift"
       * (see outcome 3's deferred branch above); false when pointer-down
       * already applied the selection change itself (fresh single-select or
       * a shift-toggle), so pointer-up has nothing left to do. */
      deferredSingleSelect: boolean;
      /** Set once the pointer has moved past `DRAG_THRESHOLD_PX` — after
       * that, a `'frame-drag-start'` result has already been returned and
       * further movement is `Canvas.tsx`'s concern, not this controller's. */
      dragStarted: boolean;
    };

function boxFromPoints(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function createSelectionGestureController(options: SelectionGestureOptions): SelectionGestureController {
  let mode: GestureMode = { kind: 'idle' };

  function onPointerDown(info: SelectionGesturePointerInfo): void {
    if (info.frameId !== null) {
      const frameId = info.frameId;
      const wasSelected = options.getSelectedIds().has(frameId);
      if (info.shiftKey) {
        const next = new Set(options.getSelectedIds());
        if (next.has(frameId)) next.delete(frameId);
        else next.add(frameId);
        options.select(Array.from(next));
        mode = {
          kind: 'pendingFrame',
          pointerId: info.pointerId,
          frameId,
          screenStart: info.screenPoint,
          pageStart: info.pagePoint,
          shiftKey: true,
          deferredSingleSelect: false,
          dragStarted: false,
        };
      } else if (!wasSelected) {
        options.select([frameId]);
        mode = {
          kind: 'pendingFrame',
          pointerId: info.pointerId,
          frameId,
          screenStart: info.screenPoint,
          pageStart: info.pagePoint,
          shiftKey: false,
          deferredSingleSelect: false,
          dragStarted: false,
        };
      } else {
        // Already selected, no shift: defer the possible single-select
        // collapse to pointer-up so a drag can move the existing
        // multi-selection without losing it first.
        mode = {
          kind: 'pendingFrame',
          pointerId: info.pointerId,
          frameId,
          screenStart: info.screenPoint,
          pageStart: info.pagePoint,
          shiftKey: false,
          deferredSingleSelect: true,
          dragStarted: false,
        };
      }
    } else {
      mode = {
        kind: 'pendingBackground',
        pointerId: info.pointerId,
        screenStart: info.screenPoint,
        pageStart: info.pagePoint,
        shiftKey: info.shiftKey,
      };
    }
  }

  function onPointerMove(info: SelectionGesturePointerInfo): SelectionMoveResult {
    if (mode.kind === 'idle' || info.pointerId !== mode.pointerId) return { type: 'none' };

    if (mode.kind === 'pendingBackground') {
      if (distance(info.screenPoint, mode.screenStart) >= DRAG_THRESHOLD_PX) {
        const box = boxFromPoints(mode.pageStart, info.pagePoint);
        mode = { kind: 'marquee', pointerId: mode.pointerId, screenStart: mode.screenStart, pageStart: mode.pageStart, shiftKey: mode.shiftKey };
        options.onMarqueeChange(box);
        return { type: 'marquee-update' };
      }
      return { type: 'none' };
    }

    if (mode.kind === 'marquee') {
      options.onMarqueeChange(boxFromPoints(mode.pageStart, info.pagePoint));
      return { type: 'marquee-update' };
    }

    // mode.kind === 'pendingFrame'
    if (!mode.dragStarted && distance(info.screenPoint, mode.screenStart) >= DRAG_THRESHOLD_PX) {
      const { frameId, shiftKey, pageStart } = mode;
      mode = { ...mode, dragStarted: true };
      if (!shiftKey) return { type: 'frame-drag-start', frameId, startPagePoint: pageStart };
    }
    return { type: 'none' };
  }

  function onPointerUp(info: SelectionGesturePointerInfo): void {
    if (mode.kind === 'idle' || info.pointerId !== mode.pointerId) return;

    if (mode.kind === 'pendingBackground') {
      // No drag ever happened — a plain click on empty background.
      options.clearSelection();
    } else if (mode.kind === 'marquee') {
      const box = boxFromPoints(mode.pageStart, info.pagePoint);
      const hitIds: string[] = [];
      for (const [id, frameBox] of options.getFrameBoxes()) {
        if (boxesIntersect(box, frameBox)) hitIds.push(id);
      }
      if (mode.shiftKey) {
        const merged = new Set(options.getSelectedIds());
        for (const id of hitIds) merged.add(id);
        options.select(Array.from(merged));
      } else {
        options.select(hitIds);
      }
      options.onMarqueeChange(null);
    } else {
      // mode.kind === 'pendingFrame'
      if (mode.deferredSingleSelect && !mode.dragStarted) {
        options.select([mode.frameId]);
      }
      // Otherwise: either the selection was already applied at pointer-down
      // (fresh select / shift-toggle), or a drag-to-move happened and the
      // selection intentionally stays exactly as it was — nothing more to
      // do here either way.
    }

    mode = { kind: 'idle' };
  }

  function isMarqueeActive(): boolean {
    return mode.kind === 'marquee';
  }

  return { onPointerDown, onPointerMove, onPointerUp, isMarqueeActive };
}
