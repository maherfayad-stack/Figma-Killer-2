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

function isTextArea(target: EventTarget | null): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    'tagName' in target &&
    (target as Element).tagName === 'TEXTAREA'
  )
}

function install(doc: Document): void {
  if (installed) return
  installed = true

  doc.addEventListener(
    'input',
    (event) => {
      pendingElement = event.target
    },
    true,
  )

  doc.addEventListener(
    'focusin',
    () => {
      pendingElement = null
    },
    true,
  )

  doc.addEventListener(
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
  if (typeof document !== 'undefined') install(document)
  return target !== null && target === pendingElement
}

/** Test seam — drops the tracked draft without waiting for a focus change. */
export function clearPendingTextEdit(): void {
  pendingElement = null
}
