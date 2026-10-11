/**
 * editorKeyGuards — the stand-down predicates every editor key scope shares.
 *
 * Before `K1` these lived in three places at once: `isTextInputTarget` was
 * exported from `useCanvasKeyboardShortcuts.ts` (a file about canvas shortcuts,
 * not about guards) and imported by seven hooks, while the "an overlay owns the
 * keyboard" selector was copy-pasted into FOUR of them under two different
 * names (`OVERLAY_SELECTOR`, `ESCAPE_OWNING_OVERLAY_SELECTOR`). Four copies of
 * one rule is four chances for a new `role="dialog"`-like surface to be added
 * to three of them.
 *
 * They are guards, not handlers, so they live in their own leaf module with no
 * store and no React import — the dispatcher, every scope handler, and the
 * tests can all reach them without pulling a hook in.
 */

/**
 * `<input type>` values whose keystrokes are TEXT ENTRY — Delete deletes a
 * character, ⌘A selects the value, an arrow moves the caret. Every other type
 * (checkbox, radio, range, color, file, button, …) has no caret, so a Delete or
 * a ⌘D pressed while one is focused is a canvas shortcut, not typing. Unknown
 * and missing types read back as `'text'` from `HTMLInputElement.type`.
 */
const TEXT_ENTRY_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
])

interface TextEntryCandidate {
  tagName?: unknown
  type?: unknown
  readOnly?: unknown
  isContentEditable?: unknown
}

/**
 * The one definition of "the user is typing" in the canvas key layer: a
 * text-entry `<input>` or a `<textarea>` that is NOT read-only, or any
 * contentEditable surface. Such a field lets the browser own the keystroke.
 *
 * ERR-21: this used to be "any `<input>` or `<textarea>`". The `Select`
 * primitive's trigger is a READ-ONLY `<input role="combobox">`, and range
 * inputs and checkboxes are inputs too — so after picking a value in the
 * inspector, Delete, ⌘D and ⌘C silently did nothing until the user clicked
 * the canvas again. Nothing can be typed into any of them.
 *
 * Duck-typed on `tagName` rather than `instanceof HTMLElement`: a target raised
 * inside a frame iframe is an instance of THAT realm's constructors, and
 * `instanceof` against the editor's said "not an element" for every one of
 * them (`canvasEventTargets.ts`'s `isElementLike` has the same reason).
 *
 * It answers about the EVENT TARGET only. A keystroke bridged out of a frame
 * iframe (`useIframeEventForwarding`) is re-dispatched on the parent
 * `document`, so its target is `document` and this returns false — which is
 * correct, and is why the dispatcher's `inline-edit` scope exists as a
 * separate, store-backed halt rather than being folded in here.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as TextEntryCandidate
  if (element.tagName === 'TEXTAREA') return element.readOnly !== true
  if (element.tagName === 'INPUT') {
    return (
      element.readOnly !== true &&
      typeof element.type === 'string' &&
      TEXT_ENTRY_INPUT_TYPES.has(element.type.toLowerCase())
    )
  }
  return element.isContentEditable === true
}

/**
 * Space's own stand-down, deliberately WIDER than {@link isTextInputTarget}:
 * any form control. Space is the activation key of a checkbox, a radio and a
 * native `<select>`, so a focused one keeps it even though nothing can be
 * typed into it — Space-to-pan on a focused checkbox would make the checkbox
 * unreachable from the keyboard. (Buttons are NOT exempt, as before P2-B: a
 * toolbar button keeps focus after a click, and Space+drag straight after it
 * must still pan.)
 */
export function isSpaceOwningControlTarget(target: EventTarget | null): boolean {
  if (isTextInputTarget(target)) return true
  if (target === null || typeof target !== 'object') return false
  const tagName = (target as TextEntryCandidate).tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

export const CANVAS_ROOT_SELECTOR = '[data-studio-canvas-root="true"]'

/**
 * True when the keystroke belongs to the CANVAS as a surface — focus is on the
 * canvas root, inside a frame (whose keystrokes arrive as a clone targeted at
 * `document`, with the frame's `<iframe>` as the parent's active element), or
 * nowhere at all (`body`).
 *
 * Most canvas keys are scoped by INTENT, not focus (`K1`, and `board-02` /
 * `select-01` before it): Delete must work from the Properties panel. Tab is
 * the exception (IX-3): inside a panel it walks the fields, which is its
 * accessibility role, so the sibling-cycling binding asks this instead.
 */
export function isCanvasKeyboardSurface(event: KeyboardEvent): boolean {
  const doc = typeof document === 'undefined' ? null : document
  const target = event.target
  const element =
    target !== null && typeof (target as { closest?: unknown }).closest === 'function'
      ? (target as Element)
      : doc?.activeElement ?? null
  if (!element) return true
  if (doc && (element === doc.body || element === doc.documentElement)) return true
  return element.closest(CANVAS_ROOT_SELECTOR) !== null
}

/**
 * Overlays that own the keyboard while open and move focus into their own
 * subtree. While one is up, Escape means "close me" and Delete means whatever
 * the overlay says — never "act on the canvas selection underneath it".
 */
const KEY_OWNING_OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

/**
 * True when the keystroke belongs to an open dialog / menu / listbox.
 *
 * The bridged iframe clone targets `document` rather than an element, so the
 * active element is the honest fallback question there.
 */
export function isInsideKeyOwningOverlay(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest(KEY_OWNING_OVERLAY_SELECTOR) !== null
}
