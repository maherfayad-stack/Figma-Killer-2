/**
 * docRichText — the editing commands behind a doc card's formatting toolbar.
 *
 * Built on `document.execCommand`. That API is formally deprecated and is
 * nonetheless the right tool here, for two reasons that are worth writing down
 * so this is not "fixed" into a regression:
 *
 *   1. It is the ONLY built-in that edits a contentEditable subtree *through
 *      the browser's own undo stack*. A hand-rolled Range/`insertHTML`
 *      implementation of bold or list-toggling silently breaks Cmd+Z inside
 *      the card, which is worse than the deprecation.
 *   2. Every evergreen browser Studio targets implements it, and no
 *      replacement (the `EditContext` API) is shipped across them yet.
 *
 * The alternative — pulling in ProseMirror/Lexical/TipTap — would add a
 * ~100KB editor framework to the admin bundle to format a canvas sticky's
 * bigger sibling. Not worth it; revisit if doc cards ever grow into real
 * documents.
 *
 * `styleWithCSS` is turned on for every command so the browser emits
 * `<span style="…">` rather than the legacy `<font>` element — `<font>` is not
 * in `sanitizeBoardDocHtml`'s allow-list and would be stripped on save, making
 * formatting silently vanish on reload.
 *
 * ## There is deliberately no font-family or font-size control
 *
 * `execCommand`'s own `fontName`/`fontSize` are unusable here — `fontSize`
 * accepts only the legacy 1–7 scale and both emit markup the sanitizer
 * profile does not allow. The replacement (wrap the selection in a styled span
 * via `insertHTML`) was tried and removed: it silently did nothing for the
 * common cases — a collapsed caret, a selection spanning more than one block —
 * so the control looked functional and was not. A control that lies about
 * whether it applied is worse than no control.
 *
 * Sizing is expressed through the BLOCK FORMAT instead (Body / Heading 1-3 /
 * Quote / Code / the two list kinds), which is what a doc card actually needs,
 * is one execCommand away, and always applies. If per-word typography is ever
 * genuinely needed, it needs a real editor model, not another span-wrapping
 * hack — see this module's note on editor frameworks above.
 *
 * ## Commands run against the document selection, not against a focused host
 *
 * Chrome applies `execCommand` to whatever the document selection is, even
 * while focus sits on some other control — so a blurred editable is NOT why a
 * toolbar command would fail. (This was measured, not assumed: `formatBlock`
 * applies correctly with focus parked on a button.) `DocToolbar`'s `run()`
 * still refocuses the editable when focus has left it, because that is what
 * keeps the caret usable for the NEXT keystroke, but do not reach for focus as
 * the explanation when a command appears not to work. Check first whether the
 * command applied and the RESULT is invisible — that is the failure this
 * module has actually had.
 */

/**
 * A block is exactly one of these at a time. Lists live in the same vocabulary
 * as headings on purpose: `execCommand` will happily nest them
 * (`<h1><ol><li>…</li></ol></h1>` — invalid, and it renders as a
 * heading-sized list item inside a heading), so the only safe model is one
 * where choosing any block format replaces whatever the block was. Expressing
 * that as a single control is what makes the rule visible instead of hidden in
 * a helper.
 */
export type DocBlockFormat = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | 'ul' | 'ol'

export const DOC_BLOCK_FORMATS: readonly { label: string; value: DocBlockFormat }[] = [
  { label: 'Body', value: 'p' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
  { label: 'Quote', value: 'blockquote' },
  { label: 'Code', value: 'pre' },
  { label: 'Bulleted list', value: 'ul' },
  { label: 'Numbered list', value: 'ol' },
]

const BLOCK_FORMAT_VALUES = new Set<string>(DOC_BLOCK_FORMATS.map((f) => f.value))

/**
 * `execCommand` acts on the document's CURRENT selection, so the caller must
 * make sure the card's editable element is focused first — clicking a toolbar
 * button moves focus to the button, which would otherwise collapse the
 * selection before the command ran. `DocToolbar`'s `run()` owns that.
 */
function exec(command: string, value?: string): void {
  try {
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(command, false, value)
  } catch (err) {
    // A command the engine refuses (an unsupported name, a selection outside
    // any editable host) must not take the card's editor down with it.
    console.error(`[docRichText] execCommand "${command}" failed:`, err)
  }
}

export function toggleBold(): void { exec('bold') }
export function toggleItalic(): void { exec('italic') }
export function toggleUnderline(): void { exec('underline') }
export function toggleStrikethrough(): void { exec('strikeThrough') }

/**
 * The block format the caret currently sits in — what the toolbar's block
 * `<Select>` displays, and what `setBlockFormat` diffs against.
 *
 * List membership is asked FIRST: inside a list item `formatBlock` still
 * reports the surrounding block, so a `queryCommandValue`-only reading would
 * call a bulleted list "Body".
 */
export function readBlockFormat(): DocBlockFormat {
  if (isCommandActive('insertUnorderedList')) return 'ul'
  if (isCommandActive('insertOrderedList')) return 'ol'
  let raw: string
  try {
    raw = document.queryCommandValue('formatBlock')
  } catch {
    return 'p'
  }
  // Engines disagree about the brackets: Chrome answers `h1`, others `<h1>`.
  const tag = raw.toLowerCase().replace(/[<>]/g, '')
  return BLOCK_FORMAT_VALUES.has(tag) ? (tag as DocBlockFormat) : 'p'
}

/**
 * SETS the block format — it does not toggle. The control it backs is a
 * `<Select>` showing the current format, so "choose Bulleted list" always
 * means "make this a bulleted list", never "flip it".
 *
 * Leaving a list is an explicit step: `insertUnorderedList` is itself a toggle,
 * so turning a list into a heading means turning the list off first and only
 * then formatting. Skipping that produces the invalid nesting described on
 * `DocBlockFormat`.
 */
export function setBlockFormat(format: DocBlockFormat): void {
  const current = readBlockFormat()
  if (current === format) return

  if (current === 'ul') exec('insertUnorderedList')
  else if (current === 'ol') exec('insertOrderedList')

  if (format === 'ul' || format === 'ol') {
    // `<div>`, not `<p>` — and this intermediate is not optional.
    //
    // Chrome nests the list INSIDE whatever block the selection is in, so
    // `insertUnorderedList` alone gives `<h1><ul>…</ul></h1>`, and flattening
    // to a paragraph first only trades that for `<p><ul>…</ul></p>` — which is
    // equally invalid, and happens even starting from an ordinary paragraph.
    // Reducing the block to a bare `<div>` first is the one sequence that
    // produces a clean `<ul><li>…</li></ul>`. Verified in Chrome across h1,
    // blockquote, p, and a multi-block selection.
    exec('formatBlock', '<div>')
    exec(format === 'ul' ? 'insertUnorderedList' : 'insertOrderedList')
    return
  }
  // Chrome/Safari want the tag name bracketed; Firefox accepts both.
  exec('formatBlock', `<${format}>`)
}

export type DocAlignment = 'left' | 'center' | 'right'

export function setAlignment(align: DocAlignment): void {
  exec(align === 'left' ? 'justifyLeft' : align === 'center' ? 'justifyCenter' : 'justifyRight')
}

/** Drives the tick in the toolbar's overflow menu. */
export function readAlignment(): DocAlignment {
  if (isCommandActive('justifyCenter')) return 'center'
  if (isCommandActive('justifyRight')) return 'right'
  return 'left'
}

export function setTextColor(color: string): void { exec('foreColor', color) }
export function clearFormatting(): void { exec('removeFormat') }

/** Turns the selection into a link. An empty/cancelled URL is a no-op rather than a link to nowhere. */
export function createLink(href: string): void {
  const trimmed = href.trim()
  if (!trimmed) return
  exec('createLink', trimmed)
}

export function removeLink(): void { exec('unlink') }

/**
 * Whether the caret/selection sits inside a link. Drives the toolbar's single
 * link button, which adds a link or removes one depending on where you are —
 * two separate buttons for that were pure width, and only ever one of them was
 * the action you wanted.
 */
export function isSelectionInLink(): boolean {
  const selection = window.getSelection()
  const node = selection?.anchorNode
  if (!node) return false
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('a') != null
}

/** Whether an inline command is currently active for the selection — drives the toolbar's pressed state. */
export function isCommandActive(command: string): boolean {
  try {
    return document.queryCommandState(command)
  } catch {
    return false
  }
}
