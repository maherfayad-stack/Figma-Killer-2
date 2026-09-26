/**
 * gestureForwarding — the in-frame half of pointing and scrolling on a Tier 2
 * bridge frame (`live-12`), split from `runtime.ts` by responsibility.
 *
 * Every pointer phase is forwarded to the parent as a `pointer` message with
 * the stamped node it landed on, in both modes: that is how the parent's
 * `useBridgeFrameInteraction` selects, hovers and follows prototype links. In
 * DESIGN mode the gesture is then the editor's — cancelled and stopped before
 * the app's own handlers — and the wheel is forwarded too, with the frame's
 * own scroll cancelled, so the parent canvas can zoom and pan. In LIVE mode
 * the app keeps every event and scrolls itself. `getMode` is read per event,
 * never captured: the parent declares the mode after the listeners exist.
 *
 * `speed-03` — a native `pointermove` fires far faster than the parent can
 * usefully act on it (measured ≈120/s while idly hovering a live frame, each
 * one a `postMessage` plus an unconditional store write). `move` is now
 * coalesced to at most one post per animation frame, carrying the LAST event
 * of the batch, and the post is skipped entirely when it would resolve to the
 * SAME node + rect as the last one actually posted — that is the "idle
 * hover" case the store write existed to guard against and doesn't exist for.
 * The skip only applies while no button is held: a held button is an active
 * drag (a pan replay in particular — see `useBridgeFrameInteraction`'s
 * `panPointerId` branch), where the resolved node commonly does NOT change
 * (e.g. panning across one full-bleed background element) but the position
 * still has to reach the parent every frame. `down`/`up`/`click` stay
 * immediate and always flush a pending move first, so the parent never sees
 * a press arrive before the move that preceded it.
 */
import type { OutboundRuntimeMessage, RuntimeMode } from './messages'
import { NODE_ID_ATTR } from './nodeIdIndexing'
import { nearestNodeOccurrence, rectRelativeToBody, stampedAncestors } from './nodeDom'
import { SELECTION_OVERLAY_ROOT_ID } from './selectionChromeCss'

type PointerRect = { x: number; y: number; width: number; height: number } | null

function rectsEqual(a: PointerRect, b: PointerRect): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export interface GestureForwardingOptions {
  getMode: () => RuntimeMode | null
  post: (message: OutboundRuntimeMessage) => void
}

/**
 * `live-13` — the runtime's own chrome (rings, resize handles) lives inside
 * the selection overlay root. A press on a resize handle is the handle's
 * gesture, not the page's: it is neither forwarded as a pointer on some node
 * nor cancelled before the handle's own listener can see it.
 */
function isRuntimeChrome(target: Element | null): boolean {
  return target?.closest(`#${SELECTION_OVERLAY_ROOT_ID}`) !== null && target !== null
}

const POINTER_TYPES = new Set(['mouse', 'pen', 'touch'])

/** The button/pointer identity fields of `ev` — a `click` is a plain `MouseEvent` and carries no pointer id. */
function pointerIdentity(ev: PointerEvent | MouseEvent): { button: number; buttons: number; pointerId: number; pointerType: 'mouse' | 'pen' | 'touch' | '' } {
  const pointer = ev as Partial<PointerEvent>
  const pointerType = typeof pointer.pointerType === 'string' && POINTER_TYPES.has(pointer.pointerType) ? (pointer.pointerType as 'mouse' | 'pen' | 'touch') : ''
  const pointerId = typeof pointer.pointerId === 'number' && Number.isInteger(pointer.pointerId) && pointer.pointerId >= 0 ? pointer.pointerId : 0
  return { button: ev.button, buttons: ev.buttons, pointerId, pointerType }
}

/** Installs the capture-phase listeners on `doc`; the returned function removes them. */
export function installGestureForwarding(doc: Document, { getMode, post }: GestureForwardingOptions): () => void {
const view = doc.defaultView
// `view.requestAnimationFrame` when the frame has one; a bare global next
// (tests that construct `doc` without a `defaultView`); `setTimeout(…, 16)`
// last so the module never throws in a headless environment with neither —
// same fallback order `runtime.ts`/`resizeHandles.ts` already use for rAF.
const scheduleFrame: (cb: () => void) => number =
  view?.requestAnimationFrame?.bind(view) ??
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : ((cb: () => void) => setTimeout(cb, 16) as unknown as number))
const cancelFrame: (id: number) => void =
  view?.cancelAnimationFrame?.bind(view) ??
  (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : ((id: number) => clearTimeout(id)))

function buildPointerMessage(phase: 'down' | 'move' | 'up' | 'click', ev: PointerEvent | MouseEvent): Extract<OutboundRuntimeMessage, { type: 'pointer' }> {
  const target = ev.target instanceof Element ? ev.target : null
  const anchor = target?.closest(`[${NODE_ID_ATTR}]`) ?? null
  const rect = anchor && doc.body ? rectRelativeToBody(anchor, doc.body) : null
  const occurrence = nearestNodeOccurrence(doc, target)
  return {
    type: 'pointer',
    phase,
    nodeId: occurrence?.nodeId ?? null,
    occurrenceIndex: occurrence?.occurrenceIndex ?? 0,
    rect,
    clientX: ev.clientX,
    clientY: ev.clientY,
    // `live-19` — `ev` is a `PointerEvent` for down/move/up and a plain
    // `MouseEvent` for click; both carry `screenX`/`screenY`. See the field's
    // own schema doc (`messages.ts`) for why the parent needs it.
    screenX: ev.screenX,
    screenY: ev.screenY,
    modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
    ancestors: stampedAncestors(doc, target),
    ...pointerIdentity(ev),
  }
}

// `speed-03` coalescing state for `move` — see the module doc.
// `lastPostedMove` is the node+rect of the last MOVE actually posted (not
// every candidate), which is what the "unchanged since the last posted move"
// skip compares against.
let pendingMove: PointerEvent | null = null
let pendingMoveFrame: number | null = null
let lastPostedMove: { nodeId: string | null; rect: PointerRect } | null = null

function postMove(ev: PointerEvent): void {
  const target = ev.target instanceof Element ? ev.target : null
  if (isRuntimeChrome(target)) return
  const message = buildPointerMessage('move', ev)
  // A held button is an active drag (pan replay in particular) — position
  // has to keep flowing even when the resolved node doesn't change.
  if (ev.buttons === 0 && lastPostedMove && lastPostedMove.nodeId === message.nodeId && rectsEqual(lastPostedMove.rect, message.rect)) {
    return
  }
  lastPostedMove = { nodeId: message.nodeId, rect: message.rect }
  post(message)
}

/** Posts the last buffered move now, cancelling its scheduled frame — called before any `down`/`up`/`click` so the parent never sees a press before the move that preceded it. */
function flushPendingMove(): void {
  if (pendingMoveFrame !== null) {
    cancelFrame(pendingMoveFrame)
    pendingMoveFrame = null
  }
  const ev = pendingMove
  pendingMove = null
  if (ev) postMove(ev)
}

function forwardPointer(phase: 'down' | 'up' | 'click', ev: PointerEvent | MouseEvent): void {
  const target = ev.target instanceof Element ? ev.target : null
  if (isRuntimeChrome(target)) return
  post(buildPointerMessage(phase, ev))
}
/**
 * `live-12` — on a DESIGN frame the click belongs to the editor, as it does
 * on a portal frame (`NodeRenderer`'s `ownsAuthoredEvents`): the gesture has
 * been forwarded, and nothing below this document-level capture listener —
 * the app's own React root included — gets to act on it, so a `<button>`
 * does not fire and an `<input>` does not take focus while the user is
 * selecting it. Cancelling `pointerdown` is what stops the focus (the
 * compatibility `mousedown` is suppressed with it); stopping propagation is
 * what keeps the handlers quiet. A live frame is the page as a visitor gets
 * it and owns every event. An editable text run is the one exception on a
 * design frame: the caret has to land for the inline edit (`onInput`) to
 * mean anything.
 */
function editorOwnsGesture(ev: Event): boolean {
  if (getMode() !== 'design') return false
  const target = ev.target instanceof Element ? ev.target : null
  if (isRuntimeChrome(target)) return false
  return !target?.closest('[contenteditable]')
}
const onPointerDown = (ev: PointerEvent) => {
  flushPendingMove()
  forwardPointer('down', ev)
  if (editorOwnsGesture(ev)) {
    ev.preventDefault()
    ev.stopPropagation()
  }
}
const onPointerMove = (ev: PointerEvent) => {
  pendingMove = ev
  if (pendingMoveFrame === null) {
    pendingMoveFrame = scheduleFrame(() => {
      pendingMoveFrame = null
      const queued = pendingMove
      pendingMove = null
      if (queued) postMove(queued)
    })
  }
}
const onPointerUp = (ev: PointerEvent) => {
  flushPendingMove()
  forwardPointer('up', ev)
  if (editorOwnsGesture(ev)) ev.stopPropagation()
}
const onClick = (ev: MouseEvent) => {
  flushPendingMove()
  forwardPointer('click', ev)
  if (editorOwnsGesture(ev)) {
    ev.preventDefault()
    ev.stopPropagation()
  }
}
/**
 * `live-12` — zoom and pan live on the PARENT canvas, and a cross-origin
 * frame's wheel never reaches it. Forwarded in design mode only, with the
 * frame's own scroll cancelled (the frame is unrolled to its content anyway);
 * a live frame scrolls itself.
 */
const onWheel = (ev: WheelEvent) => {
  if (getMode() !== 'design') return
  ev.preventDefault()
  post({
    type: 'wheel',
    deltaX: ev.deltaX,
    deltaY: ev.deltaY,
    deltaMode: ev.deltaMode,
    clientX: ev.clientX,
    clientY: ev.clientY,
    modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
  })
}
doc.addEventListener('pointerdown', onPointerDown, true)
doc.addEventListener('pointermove', onPointerMove, true)
doc.addEventListener('pointerup', onPointerUp, true)
doc.addEventListener('click', onClick, true)
// `passive: false` — the frame's own scroll must be cancellable, or Chrome
// scrolls the frame first and the canvas zooms second.
doc.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    if (pendingMoveFrame !== null) cancelFrame(pendingMoveFrame)
    pendingMove = null
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointermove', onPointerMove, true)
    doc.removeEventListener('pointerup', onPointerUp, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('wheel', onWheel, true)
  }
}
