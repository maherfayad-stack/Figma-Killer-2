import { shiftPanDelta } from './wheel-gesture.js';
import type { Point } from './geometry.js';

/**
 * Sub-workstream 2a (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — gesture
 * handling over the new `camera-store.ts`, replacing tldraw's own wheel
 * dispatch + drag-to-pan. PURE LOGIC ONLY: nothing here is wired into
 * `StudioCanvas.tsx`/`edit-mode-layer.tsx` yet.
 *
 * Mirrors `StudioCanvas.tsx`'s existing wheel-handling effect (its
 * capture-phase `onWheelCapture`, lines ~997-1060 at the time this was
 * written): ctrl/meta+wheel = zoom-at-cursor, shift+wheel = horizontal pan
 * via `shiftPanDelta` (reused verbatim, not reimplemented), plain wheel =
 * vertical pan.
 */

/** Plain-object stand-in for a DOM `WheelEvent` — deliberately NOT the DOM
 * type itself so `classifyWheelGesture` is unit-testable without jsdom
 * (matches this file's "pure logic, no DOM" scope). A real caller (2b/2d)
 * passes `{ deltaX: e.deltaX, deltaY: e.deltaY, shiftKey: e.shiftKey,
 * ctrlKey: e.ctrlKey, metaKey: e.metaKey, clientX: e.clientX, clientY:
 * e.clientY }` straight off the native event. */
export interface WheelEventLike {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
}

/** The action a caller should apply to the camera store for one wheel
 * event — either `useCameraStore.getState().pan(dx, dy)` or
 * `zoomAtPoint(currentZoom * factor, point, viewportSize)`. Deliberately
 * a `factor` (multiplicative), not an absolute zoom level, since this
 * function has no access to the store's current zoom — the caller
 * multiplies it onto whatever zoom is current at apply-time. */
export type WheelGestureAction =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number; point: Point };

export interface ClassifyWheelOptions {
  /** `|deltaY|` is clamped to this before being turned into a zoom factor,
   * so one unusually large wheel tick (some mice/trackpads report huge
   * spikes) can't produce a jarring single-event zoom jump. Mirrors
   * `edit-mode-layer.tsx`'s own `handleWheel`'s `ZOOM_STEP_CLAMP = 10`
   * (that file's doc comment: replicating `@tldraw/editor`'s unexported
   * `normalizeWheel` helper, which folds a modifier-held `deltaY` into a
   * clamped `deltaZ`). Default 10, same value, for consistency with that
   * already-verified-against-tldraw constant. */
  zoomDeltaClamp?: number;
}

const DEFAULT_ZOOM_DELTA_CLAMP = 10;

/**
 * Classifies one wheel event into a camera action.
 *
 * - ctrl/meta held -> zoom-at-cursor. The zoom `factor` is derived the same
 *   way `edit-mode-layer.tsx`'s `handleWheel` derives its `deltaZ`
 *   (`clamp(deltaY, ±zoomDeltaClamp) / 100`), then applied multiplicatively
 *   as `factor = 1 - deltaZ` — deltaY > 0 (scroll/pinch "out") shrinks the
 *   zoom, deltaY < 0 (scroll/pinch "in") grows it, matching standard
 *   trackpad-pinch-to-zoom conventions. FLAG: the exact clamp VALUE (10)
 *   and the `/100` divisor are verified against this codebase's own
 *   `edit-mode-layer.tsx` (itself verified against installed tldraw), but
 *   how that `deltaZ` is ultimately turned into a zoom multiplier inside
 *   tldraw's `Editor.dispatch` is NOT independently verified here (that
 *   internal isn't exported) — `factor = 1 - deltaZ` is this module's own
 *   reasonable multiplicative model, not a confirmed match to tldraw's
 *   exact per-event zoom curve. Needs a parity-verification pass.
 * - shift held (and no zoom modifier) -> horizontal pan, via
 *   `shiftPanDelta` (reused, not reimplemented) so the platform-dependent
 *   deltaX/deltaY gap (see `wheel-gesture.ts`'s module doc) is handled
 *   identically to today.
 * - otherwise -> plain 2-axis pan, using BOTH raw deltas directly
 *   (`dx: -deltaX, dy: -deltaY`). Phase 3b resolved the parity question this
 *   doc used to FLAG as deferred ("plain wheel = vertical pan only, dx: 0"):
 *   tldraw's own bubble-phase handler for an unmodified wheel event pans
 *   using both raw deltas (a real trackpad two-finger diagonal scroll pans
 *   diagonally, not just vertically), and `p2-selection.spec.ts`'s test (l)
 *   (Esc-exit -> ordinary wheel pan still works) exercises exactly a
 *   horizontal-only wheel (`page.mouse.wheel(300, 0)`, i.e. `deltaX=300,
 *   deltaY=0`) expecting real on-screen movement — confirmed empirically
 *   that the old `dx: 0` simplification made that a silent no-op on this
 *   engine (only reachable/verified once Phase 3b's double-click fix let
 *   this file's `test.describe.configure({mode:'serial'})` suite actually
 *   reach test (l) instead of skipping it after (f)/(g) failed). No
 *   modifier-branch behavior changes: shift-held and ctrl/meta-held wheels
 *   are unaffected, only the plain (no-modifier) case gains its `dx`.
 *
 * For BOTH pan branches, the returned `dx`/`dy` are the negation of the
 * wheel delta (`-deltaX`/`-deltaY`) — standard "scroll" convention:
 * scrolling down/right reveals content below/to the right, i.e. the
 * content itself visually moves up/left. This is the opposite sign
 * convention from `createPanDragController`'s drag-pan (which moves
 * content WITH the pointer, unnegated) — both are individually correct for
 * their respective real-world gesture, not a bug.
 */
export function classifyWheelGesture(event: WheelEventLike, options: ClassifyWheelOptions = {}): WheelGestureAction {
  if (event.ctrlKey || event.metaKey) {
    const clamp = options.zoomDeltaClamp ?? DEFAULT_ZOOM_DELTA_CLAMP;
    const clampedDeltaY = Math.abs(event.deltaY) > clamp ? clamp * Math.sign(event.deltaY) : event.deltaY;
    const deltaZ = clampedDeltaY / 100;
    return { type: 'zoom', factor: 1 - deltaZ, point: { x: event.clientX, y: event.clientY } };
  }
  if (event.shiftKey) {
    const delta = shiftPanDelta(event.deltaX, event.deltaY);
    return { type: 'pan', dx: -delta.x, dy: -delta.y };
  }
  // `|| 0` normalizes a `-0` result (when `deltaX`/`deltaY` is exactly `0`)
  // to plain `0` — otherwise `-event.deltaX`/`-event.deltaY` produces
  // negative zero, which `toEqual`'s `Object.is`-based comparison treats as
  // distinct from `0` (caught by this file's own unit tests).
  return { type: 'pan', dx: -event.deltaX || 0, dy: -event.deltaY || 0 };
}

// --- space+drag / middle-drag panning --------------------------------

/** Plain-object stand-in for a DOM `PointerEvent` — only the fields this
 * controller needs, for the same jsdom-independence reason as
 * {@link WheelEventLike}. */
export interface PanDragPointerEventLike {
  pointerId: number;
  /** `0` = left, `1` = middle, `2` = right — matches the DOM
   * `PointerEvent.button` convention. */
  button: number;
  clientX: number;
  clientY: number;
}

/** DOM `PointerEvent.button` value for the middle mouse button. */
export const MIDDLE_MOUSE_BUTTON = 1;

export interface PanDragControllerOptions {
  /** Called with the raw screen-space pointer delta `(dx, dy)` on every
   * pointer-move while a drag is active — the caller passes this straight
   * to `useCameraStore.getState().pan(dx, dy)`. Injected (rather than this
   * module importing the store directly) so the controller stays
   * store-agnostic and trivially testable with a spy. */
  onPan: (dx: number, dy: number) => void;
  /** Polled at `onPointerDown` time to decide whether a LEFT-button
   * pointer-down should start a space-drag pan (middle-button always
   * starts one regardless of this). Injected because keyboard "is space
   * currently held" state is owned by whatever component wires this up,
   * not by this pure controller. Omit to disable the space+drag trigger
   * entirely (middle-drag still works). */
  isSpaceHeld?: () => boolean;
}

export interface PanDragController {
  /** Returns `true` if this pointer-down started a drag (caller should
   * capture the pointer / suppress its default action), `false` if this
   * controller isn't interested in this event (e.g. a plain left-click
   * with space not held). */
  onPointerDown(event: PanDragPointerEventLike): boolean;
  /** No-op if no drag is currently active, or if `event.pointerId` doesn't
   * match the pointer that started the active drag (a second, unrelated
   * pointer moving mid-drag, e.g. multi-touch). */
  onPointerMove(event: PanDragPointerEventLike): void;
  /** Ends the drag if `event.pointerId` matches; no-op otherwise. */
  onPointerUp(event: PanDragPointerEventLike): void;
  isDragging(): boolean;
}

/**
 * Small state machine for space-held-drag / middle-mouse-drag canvas
 * panning (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s `camera-gestures.ts`
 * module list entry). Deliberately a factory returning plain handler
 * functions closed over private mutable state, rather than a class or a
 * zustand store — this is transient per-gesture state (which pointer
 * started the drag, its last-seen position), not app state anything else
 * needs to read/subscribe to, so a zustand store would be the wrong tool
 * (same reasoning `selection-store.ts`'s module doc gives for what SHOULD
 * be a store: things other components need to read).
 */
export function createPanDragController(options: PanDragControllerOptions): PanDragController {
  let activePointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(event: PanDragPointerEventLike): boolean {
    const isMiddleButton = event.button === MIDDLE_MOUSE_BUTTON;
    const isSpaceDrag = event.button === 0 && (options.isSpaceHeld?.() ?? false);
    if (!isMiddleButton && !isSpaceDrag) return false;
    activePointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    return true;
  }

  function onPointerMove(event: PanDragPointerEventLike): void {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx !== 0 || dy !== 0) options.onPan(dx, dy);
  }

  function onPointerUp(event: PanDragPointerEventLike): void {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
  }

  function isDragging(): boolean {
    return activePointerId !== null;
  }

  return { onPointerDown, onPointerMove, onPointerUp, isDragging };
}
