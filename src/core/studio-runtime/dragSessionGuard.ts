/**
 * dragSessionGuard — the self-heal every pointer drag on the canvas shares
 * (ERR-12). One implementation for the editor's own drags (resize, reorder,
 * insertion, ruler guides, prototype links, comment pins) and the in-frame
 * runtime's resize handles, so "what ends a drag nobody finished" has one
 * answer.
 *
 * ## The two ways a drag is orphaned
 *
 *  1. **The release never arrives.** The canvas is a stack of iframes: a
 *     `pointerup` over a frame is delivered to THAT document, and a listener
 *     on the parent never hears it unless a relay forwards it. The same
 *     happens when the button is released over the browser's own chrome or
 *     outside the window. The drag then keeps following a cursor whose button
 *     is up. The fix is to believe the pointer: a `pointermove` whose
 *     `buttons` no longer holds the drag's button means the release happened
 *     somewhere this session could not hear — so the session FINISHES, at the
 *     last point it saw, exactly as a heard release would have.
 *  2. **The window loses focus mid-drag** (Alt+Tab, a devtools click, an OS
 *     dialog). Whatever happens to the pointer next is not this gesture, so
 *     the session is ABANDONED: preview dropped, nothing committed.
 *
 * ## Focus moving INTO a frame is not focus loss
 *
 * A press inside a same-origin frame blurs the parent `window` while focus is
 * still on the page. So a `blur` is only a hint: the check runs one task
 * later (focus has settled by then) and asks the TOP-LEVEL document,
 * whose `hasFocus()` stays true while focus is in any of its child frames.
 * Only a genuine loss abandons the drag. A document turning `hidden` is always
 * genuine.
 *
 * Pointer moves are watched in the CAPTURE phase on each document, so the
 * check runs before the session's own `pointermove` handler; a session that
 * finishes from here removes that handler, and a listener removed during a
 * dispatch is not invoked for it.
 */

/** The primary (left) button in `PointerEvent.buttons`. */
export const PRIMARY_BUTTON_MASK = 1

export interface DragSessionGuardOptions {
  /** Every document this drag's `pointermove`s can be delivered to. */
  documents: readonly Document[]
  /**
   * The window whose focus the drag lives and dies with. For the editor, the
   * parent window; for a cross-origin frame's runtime, its own (the only one
   * it can read). Its own `blur` and every document's window `blur` are
   * watched.
   */
  focusWindow: Window
  /** The `buttons` bit the drag holds. Defaults to the primary button. */
  buttonMask?: number
  /** A move arrived with the button up (that move is passed): finish as if released at the last point. */
  onReleaseLost(event: PointerEvent): void
  /** The window lost focus or was hidden: cancel, commit nothing. */
  onAbandon(): void
}

/** Starts guarding a drag. Returns the disposer; call it when the drag ends for any reason. */
export function guardDragSession(options: DragSessionGuardOptions): () => void {
  const { documents, focusWindow, onReleaseLost, onAbandon } = options
  const buttonMask = options.buttonMask ?? PRIMARY_BUTTON_MASK
  let ended = false
  let focusCheck: ReturnType<typeof setTimeout> | null = null

  const end = (action: () => void) => {
    if (ended) return
    dispose()
    action()
  }

  const onPointerMove = (event: PointerEvent) => {
    if ((event.buttons & buttonMask) === 0) end(() => onReleaseLost(event))
  }
  const checkFocus = () => {
    focusCheck = null
    if (!focusWindow.document.hasFocus()) end(onAbandon)
  }
  const onBlur = () => {
    if (focusCheck !== null) return
    focusCheck = focusWindow.setTimeout(checkFocus, 0)
  }
  const onVisibility = () => {
    if (focusWindow.document.visibilityState === 'hidden') end(onAbandon)
  }

  const windows = new Set<Window>([focusWindow])
  for (const doc of documents) {
    doc.addEventListener('pointermove', onPointerMove, true)
    if (doc.defaultView) windows.add(doc.defaultView)
  }
  for (const view of windows) view.addEventListener('blur', onBlur)
  focusWindow.document.addEventListener('visibilitychange', onVisibility)

  function dispose(): void {
    if (ended) return
    ended = true
    if (focusCheck !== null) focusWindow.clearTimeout(focusCheck)
    for (const doc of documents) doc.removeEventListener('pointermove', onPointerMove, true)
    for (const view of windows) view.removeEventListener('blur', onBlur)
    focusWindow.document.removeEventListener('visibilitychange', onVisibility)
  }

  return dispose
}
