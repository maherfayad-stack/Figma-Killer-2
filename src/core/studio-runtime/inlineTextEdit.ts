/**
 * inlineTextEdit — double-click-to-edit text inside a Tier 2 bridge frame
 * (`live-18`). Split out of `runtime.ts` (module-size-budgets gate) —
 * "own the double-click-to-contentEditable session" is a distinct
 * responsibility from "be the postMessage bridge", the same reasoning
 * `resizeHandles.ts` gives for its own split.
 *
 * ## The frame asks, the parent decides
 *
 * The runtime has no page-tree or module-registry knowledge — it cannot tell
 * a locked node from a writable one, or a container from a text leaf. A
 * double-click on any stamped element posts {@link TextEditStartMessageSchema}
 * and waits; the parent runs the SAME predicate the portal editor's
 * `startInlineEdit` applies and replies with {@link TextEditReplyMessageSchema}
 * — `allowed: false` is a silent no-op here, exactly matching the portal's
 * own silence for "double-clicking a container has no inline-edit contract
 * at all" (the parent still toasts the one case a user could mistake for a
 * bug — locked source copy — from its own side).
 *
 * ## Nothing is written to the store until commit
 *
 * Unlike the portal editor (which live-commits every keystroke through
 * `applyInlineEditValue`, coalesced into one undo entry), this module keeps
 * the typed text ENTIRELY inside the frame's own DOM — the user is typing
 * directly into the real `contentEditable` element, which already is the
 * final text. Only the FINAL value crosses the wire, once, on commit. That
 * is what makes an HMR update landing mid-edit safe to treat as a plain
 * cancel: nothing was ever written to the store to undo.
 *
 * ## Never `innerHTML`, and the element is never detached or moved
 *
 * The edited element is a real node React owns (`live-14`'s rule): this
 * module only ever toggles its `contenteditable` attribute and reads/writes
 * `textContent`, never restructures it, and never removes it from the DOM.
 */
import { TEXT_EDIT_MAX_LENGTH, type OutboundRuntimeMessage, type RuntimeMode, type TextEditReplyMessage } from './messages'
import { stampedAncestors } from './nodeDom'
import { findNthNodeById, type NodeIdOccurrence } from './nodeIdIndexing'
import { SELECTION_OVERLAY_ROOT_ID } from './selectionChromeCss'

export interface InlineTextEditOptions {
  doc: Document
  getMode: () => RuntimeMode | null
  post: (message: OutboundRuntimeMessage) => void
}

export interface InlineTextEditController {
  /** Dispatches the parent's reply to an outstanding `text:editStart` request. */
  handleReply(message: TextEditReplyMessage): void
  /**
   * `vite:beforeUpdate` — React is about to reconcile. An edit still open is
   * cancelled (never committed): nothing was written to the store yet (see
   * the module doc), so this is a plain, safe revert before the DOM it
   * touches may be replaced out from under it.
   */
  onHmrBefore(): void
  dispose(): void
}

/** The runtime's own chrome (rings, resize handles) lives inside the selection overlay root — a double-click there is never a text edit. Mirrors `gestureForwarding.ts`'s identical check (kept as a second, deliberately tiny copy rather than threading it as another dependency across the two modules). */
function isRuntimeChrome(target: Element | null): boolean {
  return target !== null && target.closest(`#${SELECTION_OVERLAY_ROOT_ID}`) !== null
}

/**
 * Sets `contenteditable="plaintext-only"`, falling back to `"true"` when the
 * browser doesn't recognise the value — some browsers throw a `SyntaxError`
 * on the IDL setter for an unrecognised keyword rather than ignoring it, so
 * the fallback path is wrapped in a `try`, not just a readback check.
 */
function beginContentEditable(el: HTMLElement): void {
  try {
    el.contentEditable = 'plaintext-only'
  } catch {
    el.contentEditable = 'true'
    return
  }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true'
}

function selectAllContent(view: Window, el: HTMLElement): void {
  const selection = view.getSelection?.()
  if (!selection) return
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

interface EditSession {
  element: HTMLElement
  nodeId: string
  occurrenceIndex: number
  originalText: string
}

export function installInlineTextEdit(options: InlineTextEditOptions): InlineTextEditController {
  const { doc, getMode, post } = options
  const view = doc.defaultView ?? window

  /**
   * The outstanding request's stamped chain, innermost first (canvas-24). The
   * parent answers with whichever of these it resolved the double-click to —
   * the innermost stamp, or the nearest ancestor its tree knows — so a reply
   * naming ANY ref in the chain answers it, and names the element to edit.
   */
  let pending: NodeIdOccurrence[] | null = null
  let session: EditSession | null = null

  function isInsideSession(target: EventTarget | null): boolean {
    return session !== null && target instanceof Node && session.element.contains(target)
  }

  function endSession(): void {
    if (!session) return
    session.element.removeEventListener('blur', onBlur)
    session.element.removeAttribute('contenteditable')
    session = null
  }

  function onBlur(): void {
    commit()
  }

  function commit(): void {
    if (!session) return
    const { element, nodeId, occurrenceIndex } = session
    const raw = element.textContent ?? ''
    const text = raw.length > TEXT_EDIT_MAX_LENGTH ? raw.slice(0, TEXT_EDIT_MAX_LENGTH) : raw
    endSession()
    post({ type: 'text:commit', nodeId, occurrenceIndex, text })
  }

  function cancel(): void {
    if (!session) return
    const { element, nodeId, occurrenceIndex, originalText } = session
    element.textContent = originalText
    endSession()
    post({ type: 'text:cancel', nodeId, occurrenceIndex })
  }

  function onDblClick(ev: MouseEvent): void {
    if (getMode() !== 'design') return
    if (session || pending) return // one edit request outstanding at a time
    const target = ev.target instanceof Element ? ev.target : null
    if (isRuntimeChrome(target)) return
    const chain = stampedAncestors(doc, target)
    const occurrence = chain[0]
    if (!occurrence) return
    // Speculatively claims the gesture — a refusal (the parent's reply below)
    // is a silent no-op, exactly matching the portal editor's own silence for
    // a container double-click.
    ev.preventDefault()
    ev.stopPropagation()
    pending = chain
    post({ type: 'text:editStart', nodeId: occurrence.nodeId, occurrenceIndex: occurrence.occurrenceIndex, ancestors: chain })
  }

  function handleReply(message: TextEditReplyMessage): void {
    if (!pending?.some((ref) => ref.nodeId === message.nodeId && ref.occurrenceIndex === message.occurrenceIndex)) return
    pending = null
    if (!message.allowed) return
    const element = findNthNodeById(doc, message.nodeId, message.occurrenceIndex)
    if (!(element instanceof HTMLElement)) return
    const seedText = message.text ?? element.textContent ?? ''
    element.textContent = seedText
    beginContentEditable(element)
    element.focus()
    selectAllContent(view, element)
    element.addEventListener('blur', onBlur)
    session = { element, nodeId: message.nodeId, occurrenceIndex: message.occurrenceIndex, originalText: seedText }
  }

  // Every keystroke/click inside the editor is the editor's, not the app's —
  // stopped at capture phase before it can reach the app's own handlers.
  // `click`/`pointerdown` already skip cancellation for a `[contenteditable]`
  // target in `gestureForwarding.ts` (the caret has to land), so this only
  // needs to stop PROPAGATION, never `preventDefault`, except for the two
  // keys that end the session.
  function onKeyDownCapture(ev: KeyboardEvent): void {
    if (!isInsideSession(ev.target)) return
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      ev.preventDefault()
      cancel()
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      commit()
    }
  }
  function onKeyUpCapture(ev: KeyboardEvent): void {
    if (isInsideSession(ev.target)) ev.stopPropagation()
  }
  function onInputCapture(ev: Event): void {
    if (isInsideSession(ev.target)) ev.stopPropagation()
  }
  function onClickCapture(ev: MouseEvent): void {
    if (isInsideSession(ev.target)) ev.stopPropagation()
  }

  doc.addEventListener('dblclick', onDblClick, true)
  doc.addEventListener('keydown', onKeyDownCapture, true)
  doc.addEventListener('keyup', onKeyUpCapture, true)
  doc.addEventListener('input', onInputCapture, true)
  doc.addEventListener('click', onClickCapture, true)

  return {
    handleReply,
    onHmrBefore() {
      pending = null
      cancel()
    },
    dispose() {
      cancel()
      pending = null
      doc.removeEventListener('dblclick', onDblClick, true)
      doc.removeEventListener('keydown', onKeyDownCapture, true)
      doc.removeEventListener('keyup', onKeyUpCapture, true)
      doc.removeEventListener('input', onInputCapture, true)
      doc.removeEventListener('click', onClickCapture, true)
    },
  }
}
