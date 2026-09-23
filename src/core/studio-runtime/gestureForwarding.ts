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
 */
import type { OutboundRuntimeMessage, RuntimeMode } from './messages'
import { NODE_ID_ATTR, occurrenceIndexOf } from './nodeIdIndexing'
import { nearestNodeOccurrence, rectRelativeToBody } from './nodeDom'
import { SELECTION_OVERLAY_ROOT_ID } from './selectionChromeCss'

/** How many stamped ancestors a pointer message carries — deeper than any real component nesting, small enough to never matter on the wire. */
const MAX_ANCESTORS = 32

/** Every stamped ancestor of `el` (inclusive), innermost first, each with its own occurrence index. */
function stampedAncestors(doc: Document, el: Element | null): { nodeId: string; occurrenceIndex: number }[] {
  const chain: { nodeId: string; occurrenceIndex: number }[] = []
  let current = el?.closest(`[${NODE_ID_ATTR}]`) ?? null
  while (current && chain.length < MAX_ANCESTORS) {
    const occurrence = occurrenceIndexOf(doc, current)
    if (occurrence) chain.push(occurrence)
    current = current.parentElement?.closest(`[${NODE_ID_ATTR}]`) ?? null
  }
  return chain
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
function forwardPointer(phase: 'down' | 'move' | 'up' | 'click', ev: PointerEvent | MouseEvent): void {
  const target = ev.target instanceof Element ? ev.target : null
  if (isRuntimeChrome(target)) return
  const anchor = target?.closest(`[${NODE_ID_ATTR}]`) ?? null
  const rect = anchor && doc.body ? rectRelativeToBody(anchor, doc.body) : null
  const occurrence = nearestNodeOccurrence(doc, target)
  post({
    type: 'pointer',
    phase,
    nodeId: occurrence?.nodeId ?? null,
    occurrenceIndex: occurrence?.occurrenceIndex ?? 0,
    rect,
    clientX: ev.clientX,
    clientY: ev.clientY,
    modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
    ancestors: stampedAncestors(doc, target),
    ...pointerIdentity(ev),
  })
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
  forwardPointer('down', ev)
  if (editorOwnsGesture(ev)) {
    ev.preventDefault()
    ev.stopPropagation()
  }
}
const onPointerMove = (ev: PointerEvent) => forwardPointer('move', ev)
const onPointerUp = (ev: PointerEvent) => {
  forwardPointer('up', ev)
  if (editorOwnsGesture(ev)) ev.stopPropagation()
}
const onClick = (ev: MouseEvent) => {
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
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointermove', onPointerMove, true)
    doc.removeEventListener('pointerup', onPointerUp, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('wheel', onWheel, true)
  }
}
