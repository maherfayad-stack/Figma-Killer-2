/**
 * pendingTextEdit — "does the focused text field still hold an uncommitted
 * draft?", the one fact Ctrl/⌘+Z routing turns on.
 *
 * `UndoRedoButtons` used to refuse the undo shortcut for ANY editable target:
 * an `<input>`, `<textarea>` or contentEditable under the caret meant the
 * editor's history was simply not reachable from the keyboard. That was
 * survivable while inspector fields were empty boxes nobody parked in. It
 * stopped being survivable once the panel began prefilling every style row
 * with the value the element actually renders (`styleFieldDisplay.ts`) — the
 * Properties panel is now wall-to-wall populated text inputs, and both field
 * primitives deliberately KEEP focus after a commit (Figma's model: Enter
 * commits and re-selects). So the ⌘Z a user presses right after an edit landed
 * on a React-controlled input, whose native undo stack has nothing useful in
 * it, and the keystroke died there. From the outside: "Ctrl+Z doesn't work."
 *
 * The honest rule is not "inputs never get the editor's undo" and not "inputs
 * always lose it" — it is **whoever has an edit in progress owns the
 * keystroke**:
 *
 *   - focus outside any text field              → editor undo
 *   - focus in a field with a pending draft      → native text undo
 *   - focus in a field with no pending draft     → editor undo
 *
 * "Pending" is tracked from real DOM events rather than from any component's
 * internal state, so it holds for every editable surface — the inspector's
 * fields, the agent prompt, a search box, a plugin's own input — without those
 * surfaces having to know this module exists:
 *
 *   - an `input` event marks its target pending (the user typed);
 *   - moving focus clears it (a draft belongs to the element that has focus);
 *   - Enter clears it on an `<input>` — that is the commit gesture for a
 *     single-line field, and both inspector primitives fire their commit
 *     there. Enter in a `<textarea>` inserts a newline and is NOT a commit, so
 *     a textarea's draft stays pending;
 *   - Escape clears it (the draft was abandoned).
 *
 * The listeners are installed once, lazily, on the first call and never torn
 * down — they are three passive document listeners for the life of the tab,
 * which is cheaper than reference-counting them across mounts.
 */

let installed = false
/** The element the user has typed into and not yet committed or left. */
let pendingElement: EventTarget | null = null

/** What the focused field held when it gained focus — see the `input` listener. */
let textAtFocus = ''

/** A field's text: an input's value, else (contentEditable) its text content. */
function fieldText(target: EventTarget | null): string {
  if (typeof target !== 'object' || target === null) return ''
  const field = target as { value?: unknown; textContent?: string | null }
  return typeof field.value === 'string' ? field.value : (field.textContent ?? '')
}

function isTextArea(target: EventTarget | null): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    'tagName' in target &&
    (target as Element).tagName === 'TEXTAREA'
  )
}

/**
 * Always installs against the ADMIN's own global `document` — this tracks
 * focus/typing in the admin chrome (inspector fields, agent prompt, search
 * boxes, …), never a canvas frame's document, so it has nothing to do with
 * `FrameDocumentAdapter` (`live-05`, STATE.md). No parameter, so this file
 * never writes an explicit `Document` type annotation — see
 * `EditorChromeInjector.tsx`'s `buildTokenBlock` for the same pattern and
 * why.
 */
function install(): void {
  if (installed) return
  installed = true

  document.addEventListener(
    'input',
    (event) => {
      // A native undo that walked the field back to what it held when focus
      // arrived has consumed the whole draft: there is nothing left for the
      // browser's undo to do, so the NEXT ⌘Z is the editor's (a note typed
      // into right after it was created, then undone, reaches its creation).
      const walkedBackToStart =
        (event as InputEvent).inputType === 'historyUndo' && fieldText(event.target) === textAtFocus
      pendingElement = walkedBackToStart ? null : event.target
    },
    true,
  )

  document.addEventListener(
    'focusin',
    (event) => {
      pendingElement = null
      textAtFocus = fieldText(event.target)
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (event) => {
      const e = event as KeyboardEvent
      if (e.key === 'Escape') pendingElement = null
      // Enter commits a single-line field and keeps focus; in a textarea it is
      // just a newline, so the draft there is still pending.
      else if (e.key === 'Enter' && !isTextArea(e.target)) pendingElement = null
    },
    true,
  )
}

/**
 * True when `target` is a text-editing surface that currently holds an
 * uncommitted draft — the one case where Ctrl/⌘+Z belongs to the browser's
 * text undo rather than to the editor's history.
 *
 * Call sites must pass the keydown's own target; a keystroke forwarded from a
 * canvas iframe re-targets to `document` (see `useIframeEventForwarding.ts`)
 * and correctly reads as "not a text field".
 */
export function hasPendingTextEdit(target: EventTarget | null): boolean {
  if (typeof document !== 'undefined') install()
  return target !== null && target === pendingElement && isTextEntry(target)
}

/** `<input>` types that take typed text; every other type (checkbox, range, color, button...) has no text undo of its own. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''])

/**
 * Whether `target` is a surface with a native text undo: a text-like `<input>`,
 * a `<textarea>`, or contentEditable. A button, a checkbox, a range or a
 * `<select>` fires `input` events too, and holding the editor's undo hostage to
 * one of those would leave Ctrl+Z dead for as long as the control keeps focus,
 * which is exactly where focus stays after clicking one.
 */
function isTextEntry(target: EventTarget): boolean {
  const element = target as Partial<HTMLElement> & { type?: string }
  if (element.isContentEditable === true) return true
  if (element.tagName === 'TEXTAREA') return true
  if (element.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((element.type ?? '').toLowerCase())
  return false
}

/** Test seam — drops the tracked draft without waiting for a focus change. */
export function clearPendingTextEdit(): void {
  pendingElement = null
}
