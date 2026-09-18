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
 * Inputs / textareas / contenteditable surfaces let the browser own the
 * keystroke. This is the one definition of "the user is typing" in the canvas
 * key layer.
 *
 * It answers about the EVENT TARGET only. A keystroke bridged out of a frame
 * iframe (`useIframeEventForwarding`) is re-dispatched on the parent
 * `document`, so its target is `document` and this returns false — which is
 * correct, and is why the dispatcher's `inline-edit` scope exists as a
 * separate, store-backed halt rather than being folded in here.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )
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
