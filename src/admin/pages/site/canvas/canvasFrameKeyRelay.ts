/**
 * canvasFrameKeyRelay — how a keystroke raised INSIDE a frame reaches the
 * editor's key layer. One implementation, two callers:
 *
 *   - a PORTAL frame (`useIframeEventForwarding`) hears the native event in
 *     its same-origin document;
 *   - a BRIDGE frame (`useBridgeFrameInteraction`) hears it as a `key` message
 *     its runtime posted (`@core/studio-runtime`'s `keyForwarding.ts`), because
 *     a Tier 2 frame is cross-origin and nothing native crosses.
 *
 * Both used to differ in a way that mattered: the portal relay forwarded
 * keydown and dropped Tab, and the bridge relayed nothing at all — so after an
 * inline text edit in a live frame (the one thing that leaves focus inside it)
 * Delete, ⌘Z and every tool letter went nowhere.
 *
 * ## keydown → a clone on the parent `document`
 *
 * Never on the iframe element: that would double-fire anything listening via
 * React's fiber bubbling (`docs/agent-refs/canvas-internals.md`, "Native
 * events do not cross the iframe boundary"). On `document` the clone reaches
 * THE dispatcher (`useEditorKeyDispatcher`) and the window-level ⌘S / ⌘K
 * listeners alike. Tab is forwarded like any other key since P2-B (IX-3): the
 * caller cancels it inside the frame so it cannot walk the authored page's
 * links, and the `node` rung decides whether it means "next sibling".
 *
 * ## keyup → the dispatcher's release broadcast, NOT a clone
 *
 * A keyup has exactly one job on the editor side: ending a hold (the nudge
 * undo burst, Space-pan). `dispatchEditorKeyUp` is that broadcast. A cloned
 * keyup on `document` would ALSO reach the Alt-hold tree ladder and the
 * Alt-measure layer, which already listen in every frame document themselves
 * and would each act twice.
 *
 * ## Space and focus loss (ERR-11)
 *
 * Space held in a frame raises the `iframe` pan source; releasing it anywhere,
 * or the frame's window losing focus to another application, lowers BOTH
 * keyboard sources (`releaseCanvasKeyboardPan` says why both).
 */
import { releaseCanvasKeyboardPan, setCanvasSpacePanActive } from './canvasPanInput'
import { dispatchEditorKeyUp, releaseEditorKeysIfFocusLeft } from './editorKeyDispatcher'

/** Everything a relayed key carries — the fields `KeyboardEvent` and the runtime's `key` message share. */
export interface FrameKeyInit {
  key: string
  code: string
  location: number
  repeat: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** The fields of a native event worth relaying. */
export function frameKeyInitFrom(event: KeyboardEvent): FrameKeyInit {
  return {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  }
}

function isSpace(init: FrameKeyInit): boolean {
  return init.code === 'Space' || init.key === ' '
}

/**
 * Relays a frame keydown. Returns true when the editor claimed it (the clone
 * was `preventDefault`ed), so the caller can suppress the frame's own default.
 *
 * Space re-asserts the `iframe` source on EVERY keydown, auto-repeats
 * included — that is what heals an over-eager release (see
 * `releaseCanvasKeyboardPan`).
 */
export function relayFrameKeyDown(parentDocument: Document, init: FrameKeyInit): boolean {
  if (isSpace(init)) setCanvasSpacePanActive(parentDocument, 'iframe', true)
  const forwarded = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  parentDocument.dispatchEvent(forwarded)
  return forwarded.defaultPrevented
}

/** Relays a frame keyup: lowers the pan flags for Space, and ends any hold. */
export function relayFrameKeyUp(parentDocument: Document, init: FrameKeyInit): void {
  if (isSpace(init)) releaseCanvasKeyboardPan(parentDocument)
  dispatchEditorKeyUp(new KeyboardEvent('keyup', init))
}

/**
 * A frame's window lost focus. If focus left the editor entirely, every held
 * key is released; if it only came back to the editor document, the keys are
 * still held and their next events will arrive there.
 */
export function relayFrameBlur(parentDocument: Document): void {
  releaseEditorKeysIfFocusLeft(parentDocument)
}
