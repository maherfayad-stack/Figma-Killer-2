/**
 * keyForwarding — the in-frame half of the keyboard on a Tier 2 bridge frame
 * (P2-B), split from `runtime.ts` by responsibility, beside its pointer twin
 * `gestureForwarding.ts`.
 *
 * A design-board frame is the editor's surface, and the editor's shortcuts —
 * Delete, ⌘D, ⌘Z, Tab to the next sibling, V, Space to pan — live in the
 * PARENT, which a cross-origin frame's native keyboard events never reach.
 * Focus lands inside a bridge frame whenever the user edits text in it (the
 * one gesture the runtime lets through, `inlineTextEdit.ts`), and it stays
 * there after the edit ends — so before this module every shortcut after a
 * text edit in a live frame went nowhere.
 *
 * In DESIGN mode every keydown and keyup is posted as a `key` message and the
 * frame's own default is cancelled (as `gestureForwarding.ts` cancels a press:
 * the gesture is the editor's), and the window losing focus is posted as
 * `blur` so a held Space cannot outlive an Alt-Tab (ERR-11). The parent replays
 * them through `canvasFrameKeyRelay.ts`, the same code a portal frame's
 * keyboard goes through.
 *
 * Two stand-downs, both "the user is typing, so the key is theirs":
 *   - the target is editable (an inline edit's `contentEditable`, or a text
 *     field) — the keystroke is never posted and never cancelled;
 *   - LIVE mode — the frame is the page as a visitor gets it, and a form
 *     field there is real. Nothing is posted; nothing is cancelled.
 *
 * Numbers and short strings only: `key`/`code` are bounded by the wire schema,
 * and nothing here names a node or reaches the DOM.
 */
import type { OutboundRuntimeMessage, RuntimeMode } from './messages'
import { KEY_NAME_MAX } from './keyMessages'

export interface KeyForwardingOptions {
  getMode: () => RuntimeMode | null
  post: (message: OutboundRuntimeMessage) => void
}

const TEXT_ENTRY_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'])

/** The user is typing into `target` — the same rule the editor's own `isTextInputTarget` applies, plus any `contentEditable` ancestor. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as { closest?: unknown }).closest !== 'function') return false
  const element = target as HTMLElement
  if (element.closest('[contenteditable]:not([contenteditable="false"])')) return true
  if (element.tagName === 'TEXTAREA') return !(element as HTMLTextAreaElement).readOnly
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement
    return !input.readOnly && TEXT_ENTRY_INPUT_TYPES.has(input.type)
  }
  return false
}

/** Installs the listeners on `doc` and its window; the returned function removes them. */
export function installKeyForwarding(doc: Document, { getMode, post }: KeyForwardingOptions): () => void {
  const view = doc.defaultView

  function forward(phase: 'down' | 'up', ev: KeyboardEvent): void {
    if (getMode() !== 'design') return
    if (isTypingTarget(ev.target)) return
    if (!ev.key || ev.key.length > KEY_NAME_MAX || ev.code.length > KEY_NAME_MAX) return
    // The editor owns the keyboard on a design frame: no Tab walk through the
    // app's links, no page scroll on Space or an arrow, no app shortcut.
    if (phase === 'down') {
      ev.preventDefault()
      ev.stopPropagation()
    }
    post({
      type: 'key',
      phase,
      key: ev.key,
      code: ev.code,
      location: ev.location,
      repeat: ev.repeat,
      modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
    })
  }

  const onKeyDown = (ev: KeyboardEvent) => forward('down', ev)
  const onKeyUp = (ev: KeyboardEvent) => forward('up', ev)
  const onBlur = () => {
    if (getMode() === 'design') post({ type: 'blur' })
  }

  // Capture phase, like the pointer listeners: the app's own handlers must
  // not see a design-mode keystroke first.
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('keyup', onKeyUp, true)
  view?.addEventListener('blur', onBlur)
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('keyup', onKeyUp, true)
    view?.removeEventListener('blur', onBlur)
  }
}
