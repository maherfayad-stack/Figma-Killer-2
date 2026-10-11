/**
 * What an inline text edit does to the element it edits, and how to keep that
 * from showing.
 *
 * The editor is the real element made `contenteditable` (the canvas edits the
 * page's own box, not a copy), so the browser's editing rules apply to it:
 *
 *   - `contenteditable="plaintext-only"` is FORCED to `white-space: pre-wrap` by
 *     the engine's style adjustment, and an author rule cannot beat it. A
 *     centred or wrapped line then keeps its trailing space and the glyphs
 *     shift by its width the moment editing starts (R4 O3). So the editor uses
 *     `contenteditable="true"`, which only adds `overflow-wrap: break-word` and
 *     `line-break: after-white-space`, and {@link pinTextMetrics} writes the
 *     values the element had before back over those for the session.
 *   - `true` accepts formatting commands and pasted markup, which a plain-text
 *     field must not: {@link isRichTextShortcut} and {@link pastePlainText} are
 *     the two entry points the owner of the edit blocks.
 *
 * Shared by the portal canvas (`NodeRenderer`) and the live-frame runtime
 * (`inlineTextEdit.ts`), which must agree on this to the pixel.
 */

const PINNED_PROPERTIES = ['whiteSpace', 'overflowWrap', 'lineBreak'] as const

/**
 * Writes `from`'s computed `white-space`, `overflow-wrap` and `line-break` onto
 * `el` inline, and returns the function that puts back what was there. `from`
 * is the element itself before it became editable, or a non-editable clone of
 * it (lifting the attribute off a focused editor would blur it).
 */
export function pinTextMetrics(el: HTMLElement, from: Element): () => void {
  const view = el.ownerDocument.defaultView
  if (!view) return () => {}
  const computed = view.getComputedStyle(from)
  const pinned = PINNED_PROPERTIES.map((property) => [property, computed[property]] as const)
  const previous = PINNED_PROPERTIES.map((property) => [property, el.style[property]] as const)
  for (const [property, value] of pinned) el.style[property] = value
  return () => {
    for (const [property, value] of previous) el.style[property] = value
  }
}

/** Cmd/Ctrl+B, I, U: the formatting shortcuts a `contenteditable="true"` element honours. */
export function isRichTextShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && /^[biu]$/i.test(event.key)
}

/** Replaces a paste with its plain-text flavour, so no markup ever lands in the edited element. */
export function pastePlainText(event: ClipboardEvent): void {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (text === '') return
  const target = event.target
  if (target instanceof Node) target.ownerDocument?.execCommand('insertText', false, text)
}
