/**
 * canvasEventTargets — deciding, for a DOM event inside a canvas frame, WHOSE
 * event it is: the editor's (select this node, open this menu) or the authored
 * page's (type in this field, expand this disclosure).
 *
 * Extracted from `NodeRenderer.tsx`, which had grown past the 700-line module
 * ceiling. It is a genuinely separate reason to change: every predicate here is
 * about classifying a DOM target, and none of them know anything about node
 * rendering, module lookup, or the editor store. `NodeRenderer` keeps the one
 * piece that is NOT pure — `latestSuppressedPointerTarget`, the mutable
 * pointer-suppression latch its own handlers write.
 *
 * Everything here is cross-document by necessity: each breakpoint frame renders
 * inside its own iframe, so a target is an instance of THAT iframe's `Element`
 * constructor, never the editor window's — see `isElementLike`.
 */

export const CANVAS_EDITOR_CONTROL_SELECTOR = '[data-canvas-interactive="true"]'
export const CANVAS_NODE_SELECTOR = '[data-node-id]'
export const CANVAS_FORM_CONTROL_SELECTOR = 'input, textarea, select, button, option, optgroup'

/**
 * Duck-type "is this an Element?" check that works across documents. The
 * canvas now renders each breakpoint frame inside an iframe, and click
 * targets inside the iframe are instances of the iframe's own `Element`
 * constructor — `target instanceof Element` (where `Element` resolves to
 * the EDITOR window's class) returns false for them. Using a structural
 * check (`closest` callable) sidesteps that, since both the editor's and
 * the iframe's Elements expose the same DOM API.
 */
export function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}

/**
 * True when the event target sits inside a form input or contentEditable —
 * i.e. the user is actively typing into something. Canvas keyboard
 * shortcuts (Enter / Space / Delete / Ctrl+D / ...) must NOT hijack those
 * keystrokes because that would defeat the author-rendered form fields
 * inside the preview. `INPUT` / `TEXTAREA` cover normal form fields;
 * `closest('[contenteditable]')` covers any author-rendered rich-text
 * surfaces (none ship with the first-party module pack today, but third-
 * party modules may use them).
 */
export function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!isElementLike(target)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  return target.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]') !== null
}

/**
 * Focus the node the browser is about to focus anyway, but with
 * `preventScroll` — the one thing the native focus step will not do.
 *
 * Every node element carries `tabIndex: 0` (keyboard selection), so a plain
 * click focuses it. The canvas root is `overflow: hidden` WITH real scroll
 * extents, and a clipped ancestor is exactly what the browser scrolls to reveal
 * a newly-focused element: clicking anything in the lower half of a tall frame
 * yanked the whole board upward by however far that node sat past the viewport
 * (measured: 410px on one click), which reads as the canvas throwing you out of
 * the screen you were working in.
 *
 * Focusing FIRST makes the element already-active by the time the default
 * action runs, so there is no focus change left to scroll for.
 *
 * Skipped when the pointer landed on something focusable in its own right (an
 * authored `<input>`, the inline-text editor) — stealing focus from those would
 * break typing, and they are the browser's to focus.
 */
export function focusNodeWithoutScrolling(
  currentTarget: EventTarget | null,
  target: EventTarget | null,
  isInlineEditing: boolean,
): void {
  if (isInlineEditing) return
  if (!isClosestCanvasNodeTarget(target, currentTarget)) return
  if (!isElementLike(currentTarget)) return
  // A descendant that is focusable in its own right (`tabIndex >= 0`, or
  // `contentEditable`) keeps the focus the browser would give it.
  if (target !== currentTarget && isElementLike(target)) {
    const inner = target as HTMLElement
    if (inner.tabIndex >= 0 || inner.isContentEditable) return
  }
  ;(currentTarget as HTMLElement).focus?.({ preventScroll: true })
}

export function isClosestCanvasNodeTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) {
    return true
  }

  const closestNode = target.closest(CANVAS_NODE_SELECTOR)
  return closestNode === currentTarget
}

export function isCanvasEditorControlTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) {
    return false
  }

  const interactive = target.closest(CANVAS_EDITOR_CONTROL_SELECTOR)
  return Boolean(interactive && currentTarget.contains(interactive))
}

export function shouldSuppressAuthoredFormControlEvent(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isClosestCanvasNodeTarget(target, currentTarget)) return false
  if (isCanvasEditorControlTarget(target, currentTarget)) return false
  return isAuthoredFormControlTarget(target, currentTarget)
}

export function isAuthoredFormControlTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) return false
  const control = target.closest(CANVAS_FORM_CONTROL_SELECTOR)
  return Boolean(control && currentTarget.contains(control))
}

export function isFocusableElement(target: EventTarget | null): target is HTMLElement {
  return isElementLike(target) && typeof (target as HTMLElement).blur === 'function'
}
