interface WheelPanEvent {
  deltaX: number
  deltaY: number
  shiftKey: boolean
}

interface PointerPanEvent {
  button: number
}

interface PointerPanState {
  buttons: number
}

interface PointerPanOptions {
  spaceHeld: boolean
}

/**
 * Who currently says "the canvas is panning".
 *
 * Three sources, one flag, because the browser gives each of them a different
 * event realm and there is exactly one answer:
 *
 * - `parentDocument` — Space held with focus in the editor document.
 * - `iframe` — Space held with focus inside a frame's iframe. A native keydown
 *   does not cross that boundary, so the frame reports its own.
 * - `handTool` — `K4`'s latched H tool. It is a LATCH, not a key state: no
 *   keyup ends it, only picking another tool does. Reusing this flag rather
 *   than adding a parallel "pan mode" is what keeps the cursor, the pointer
 *   gating and the iframe relay from having two definitions of panning.
 */
type CanvasSpacePanSource = 'parentDocument' | 'iframe' | 'handTool'

const CANVAS_SPACE_PAN_DATA_KEYS: Record<CanvasSpacePanSource, string> = {
  parentDocument: 'studioCanvasParentSpacePan',
  iframe: 'studioCanvasIframeSpacePan',
  handTool: 'studioCanvasHandTool',
}

const PRIMARY_MOUSE_BUTTON = 0
const MIDDLE_MOUSE_BUTTON = 1
const PRIMARY_MOUSE_BUTTON_MASK = 1
const MIDDLE_MOUSE_BUTTON_MASK = 4

export const CANVAS_DRAG_PAN_BUTTONS = [
  PRIMARY_MOUSE_BUTTON_MASK,
  MIDDLE_MOUSE_BUTTON_MASK,
] as const

export function panDeltaFromWheel(event: WheelPanEvent): { dx: number; dy: number } {
  const wheelX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
  const wheelY = event.shiftKey ? 0 : event.deltaY
  return { dx: invertWheelDelta(wheelX), dy: invertWheelDelta(wheelY) }
}

export function shouldStartCanvasPointerPan(
  event: PointerPanEvent,
  { spaceHeld }: PointerPanOptions,
): boolean {
  return event.button === MIDDLE_MOUSE_BUTTON || (spaceHeld && event.button === PRIMARY_MOUSE_BUTTON)
}

export function isCanvasPointerPanActive(
  event: PointerPanState,
  { spaceHeld }: PointerPanOptions,
): boolean {
  return (
    (event.buttons & MIDDLE_MOUSE_BUTTON_MASK) !== 0 ||
    (spaceHeld && (event.buttons & PRIMARY_MOUSE_BUTTON_MASK) !== 0)
  )
}

export function isMiddleMousePointerPan(event: PointerPanState): boolean {
  return (event.buttons & MIDDLE_MOUSE_BUTTON_MASK) !== 0
}

export function setCanvasSpacePanActive(
  doc: Document,
  source: CanvasSpacePanSource,
  active: boolean,
): void {
  const key = CANVAS_SPACE_PAN_DATA_KEYS[source]
  const { dataset } = doc.documentElement
  // No-op writes stay no-ops: a held Space re-asserts its source on every
  // auto-repeat keydown (see `releaseCanvasKeyboardPan`), and an attribute
  // write is a mutation record even when the value does not change.
  if (active) {
    if (dataset[key] !== '1') dataset[key] = '1'
    return
  }
  if (key in dataset) delete dataset[key]
}

/**
 * "Space is no longer held" — clears BOTH keyboard sources at once, and never
 * the hand tool (a deliberate latch that only another tool puts away).
 *
 * Why both, from wherever the release is observed (ERR-11): the key is one
 * physical fact, but its keydown and its keyup can land in different
 * documents. Hold Space over the editor, click into a frame, let go — the
 * press raised `parentDocument` and the release arrives in the FRAME. Clearing
 * only the source that saw the release left the other set forever, and a set
 * flag makes every frame `pointer-events: none` (`IframeFrameSurface`), so every
 * later click panned instead of selecting. The same goes for the window losing
 * focus mid-hold: the keyup is delivered to some other application.
 *
 * Over-clearing is self-healing: a Space still physically held keeps sending
 * auto-repeat keydowns, and every Space keydown re-asserts its source.
 */
export function releaseCanvasKeyboardPan(doc: Document): void {
  setCanvasSpacePanActive(doc, 'parentDocument', false)
  setCanvasSpacePanActive(doc, 'iframe', false)
}

export function isCanvasSpacePanActive(doc: Document): boolean {
  const { dataset } = doc.documentElement
  return (
    dataset[CANVAS_SPACE_PAN_DATA_KEYS.parentDocument] === '1' ||
    dataset[CANVAS_SPACE_PAN_DATA_KEYS.iframe] === '1' ||
    dataset[CANVAS_SPACE_PAN_DATA_KEYS.handTool] === '1'
  )
}

function invertWheelDelta(delta: number): number {
  return delta === 0 ? 0 : -delta
}
