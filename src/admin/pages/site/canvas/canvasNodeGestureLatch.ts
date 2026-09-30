/**
 * canvasNodeGestureLatch — what ONE press-and-release means, across the several
 * events a browser raises for it.
 *
 * A single press on a canvas node can raise `pointerdown`, a compatibility
 * `mousedown`, `pointerup`, `mouseup` and a `click`, and `NodeRenderer` listens
 * to most of them. Activating the node once per EVENT was invisible while
 * activation only meant "select this node" — the same node twice looks like
 * once — and became a real bug the moment the prototype player made a click
 * mean "follow this link": one press pushed the same screen twice, so going
 * back once landed on the screen you were already looking at.
 *
 * The two latches below are the state that collapses those events back into one
 * gesture. They live here, and not in `canvasEventTargets.ts`, because that
 * module is pure classification of a DOM target and these are mutable
 * per-gesture state; and not in `NodeRenderer.tsx`, because that file sits on
 * the 700-line module ceiling and "how many events is one press" is a different
 * reason to change from "how a node renders".
 *
 * Module scope, not per-node: a gesture belongs to the frame, and only one is
 * ever in flight.
 */

/**
 * The node whose AUTHORED CONTROL the current pointer gesture suppressed.
 *
 * Design frames cancel a press on an authored `<input>` / `<select>` /
 * `<button>` at `pointerdown`, before the browser can focus it or open a
 * picker — but they do NOT select anything there: a press can still turn into
 * a drag, and which layer it selects is decided on RELEASE
 * (`canvasPressTarget.ts`). The release (`pointerup`, or the `click` when no
 * pointer events were raised) activates the node once; the `click` that ends
 * the same gesture must then not activate it a second time.
 */
let suppressedPointerTarget: EventTarget | null = null
let suppressedPointerActivated = false

/** Open (or clear, with `null`) the suppressed-control gesture. */
export function setSuppressedPointerTarget(target: EventTarget | null): void {
  suppressedPointerTarget = target
  suppressedPointerActivated = false
}

/** Whether this element's press is the suppressed one in flight. */
export function isSuppressedPointerTarget(target: EventTarget | null): boolean {
  return target !== null && suppressedPointerTarget === target
}

/**
 * Claim the one activation of the suppressed gesture this element opened.
 * True exactly once per gesture — the caller activates the node; false means
 * "not this gesture, or already activated".
 */
export function claimSuppressedPointerActivation(target: EventTarget | null): boolean {
  if (!isSuppressedPointerTarget(target) || suppressedPointerActivated) return false
  suppressedPointerActivated = true
  return true
}

/**
 * Whether the CURRENT press turned into an element drag.
 *
 * A body drag starts as a press on some element, and the `click` the browser
 * raises at its release is still a click — on the common ancestor of where the
 * press started and where it ended. Left alone, that click re-selected
 * whatever it landed on and replaced the layer the user had just moved (a
 * bridge frame's runtime forwards the same click). Set when the drag session
 * ACTIVATES (`useCanvasReorderDrag`), cleared by the next press in any frame
 * (`beginCanvasPress`), and read by every click and release path: a press that
 * became a drag selects nothing on release.
 */
let pressBecameDrag = false

/** A new press started in a frame: whatever the previous one became is over. */
export function beginCanvasPress(): void {
  pressBecameDrag = false
}

/** The current press cleared the drag threshold. */
export function markCanvasPressDragged(): void {
  pressBecameDrag = true
}

/** True when the current press is (or was) a drag — its release is not a click. */
export function canvasPressBecameDrag(): boolean {
  return pressBecameDrag
}

/**
 * The CLICK half: true when this click is the one ending a drag, and the
 * drag's claim is spent with it — a gesture raises one click, and a later
 * click with no press of its own (a keyboard activation) must not be eaten.
 */
export function takeCanvasPressDrag(): boolean {
  const dragged = pressBecameDrag
  pressBecameDrag = false
  return dragged
}

/**
 * The NATIVE click a capture-phase activation already handled.
 *
 * A live frame does not stop propagation — the authored component's own
 * handlers have to run — so the same node's bubble-phase `onClick` sees the
 * gesture again a moment later. It is the native event that identifies it, not
 * the synthetic one: React dispatches each phase from its own root listener and
 * mints a separate `SyntheticEvent` for each, so synthetic identities never
 * match across the two.
 */
let activatedClick: Event | null = null

/** Record (or clear, with `null`) the native click a capture handler acted on. */
export function markClickActivated(nativeEvent: Event | null): void {
  activatedClick = nativeEvent
}

/** True when this native click was already activated in the capture phase. */
export function takeActivatedClick(nativeEvent: Event): boolean {
  if (activatedClick !== nativeEvent) return false
  activatedClick = null
  return true
}
