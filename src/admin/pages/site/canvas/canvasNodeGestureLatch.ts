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
 * Design frames cancel a press on an authored `<input>` / `<select>` / `<button>`
 * before the browser can focus it or open a picker, and activate the node from
 * the `pointerdown` instead. The `click` that ends that same gesture must then
 * NOT activate it a second time.
 */
let suppressedPointerTarget: EventTarget | null = null

/** Open (or clear, with `null`) the suppressed-control gesture. */
export function setSuppressedPointerTarget(target: EventTarget | null): void {
  suppressedPointerTarget = target
}

/** Whether this element's press is the one already acted on. */
export function isSuppressedPointerTarget(target: EventTarget | null): boolean {
  return suppressedPointerTarget === target
}

/**
 * Close the gesture this element opened, reporting whether there was one. True
 * means "already activated — do nothing".
 */
export function takeSuppressedPointerTarget(target: EventTarget | null): boolean {
  if (suppressedPointerTarget !== target) return false
  suppressedPointerTarget = null
  return true
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
