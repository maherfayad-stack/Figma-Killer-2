/**
 * canvasGesture — "a pointer gesture is continuously mutating the page; hold
 * every derived geometry until it ends".
 *
 * ## The problem it solves
 *
 * Two subsystems recompute expensive geometry whenever the page's layout
 * changes, and both are correct to do so for an ordinary edit:
 *
 *   - `BreakpointSelectionOverlay`'s RAF tick marks the parent-document anchor
 *     dirty when the inspected node's rect changes, then re-runs the
 *     zoom-converting `createCanvasOverlayMeasureSession`. Its own docblock
 *     promises this runs "once per pan/zoom COMMIT (the debounced store
 *     values, never per pointermove)".
 *   - `useIframeFrameAutoHeight` observes the frame body with a
 *     `ResizeObserver` and refits the FRAME to its content — which resizes the
 *     iframe element in the parent document and relayouts the whole canvas.
 *
 * An element resize violates the assumption both are built on: it changes the
 * page's layout on *every frame of a drag*, so both "rare, expensive" paths
 * become per-frame paths, and the frame itself starts resizing under the
 * cursor while you are trying to size something inside it.
 *
 * ## Why a module-level flag and not store state
 *
 * The readers are a RAF tick and a `ResizeObserver` callback — neither is a
 * React render, and routing this through the store would add a re-render of
 * every subscriber at gesture start and end for a value no UI displays.
 * `canvasSelectionOverlayPositioning`'s own applied-placement cache is
 * module-level for the same reason.
 *
 * A gesture is global by nature: one pointer, one drag, so one flag. Callers
 * pass a token and only the caller that began a gesture can end it, which
 * keeps a stray `end` from unfreezing geometry mid-drag.
 */

let activeToken: symbol | null = null

/** Callbacks that need to run ONCE when the page settles after a gesture. */
const settleListeners = new Set<() => void>()

/** Whether a page-mutating pointer gesture is currently in flight. */
export function isCanvasGestureActive(): boolean {
  return activeToken !== null
}

/**
 * Begin a gesture. Returns the token needed to end it.
 *
 * A second `begin` while one is active replaces the token: the pointer can
 * only be doing one thing, and a stale gesture that never ended (a listener
 * torn down mid-drag) must not be able to freeze geometry forever.
 */
export function beginCanvasGesture(): symbol {
  activeToken = Symbol('canvas-gesture')
  return activeToken
}

/**
 * End the gesture `token` began, and let every settle listener recompute once.
 *
 * The settle pass is not optional bookkeeping: geometry was deliberately NOT
 * recomputed during the gesture, so at this moment every cached rect and every
 * frame fit is stale by exactly the size of the edit that was just made. A
 * `ResizeObserver` will not necessarily fire again — the layout already
 * finished changing while it was being ignored.
 */
export function endCanvasGesture(token: symbol): void {
  if (activeToken !== token) return
  activeToken = null
  for (const listener of settleListeners) listener()
}

/** Register a callback to run when a gesture ends. Returns an unsubscribe. */
export function onCanvasGestureSettle(listener: () => void): () => void {
  settleListeners.add(listener)
  return () => settleListeners.delete(listener)
}
