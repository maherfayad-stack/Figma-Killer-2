/**
 * htmlToJsx - turns pasted HTML into the intrinsic-JSX subtree the `insert`
 * edit writes into the user's source, plus the stylesheet text that came with it.
 *
 * G-10. A block of HTML used to be refused on a board backed by real files
 * ("a block of HTML has no single honest form to write there"). It has one:
 * the tags it uses (`a`, `button`, `img`, `input`, `ul`, ...) are all
 * intrinsic JSX elements, and its CSS belongs in the page's stylesheet. This is
 * the first half - markup to a tree. The second half, deciding where the CSS
 * goes and how the elements reach it, is the server's
 * (`studioInsertHtmlStyles.ts`): it is the only side that can read the page's
 * imports and the project's stylesheets.
 *
 * ## Markup is not JSX: what is rewritten on the way
 *
 *  - **Attribute names** go through `@core/vector`'s ONE markup <-> JSX table
 *    (`class` -> `className`, `for` -> `htmlFor`, `maxlength` -> `maxLength`,
 *    SVG `stroke-width` -> `strokeWidth`, `data-*` / `aria-*` unchanged).
 *  - **`style="a:b"` strings** become `style={{ a: "b" }}` objects. React
 *    throws on a string `style`, in the user's real app, on a page the canvas
 *    drew fine.
 *  - **Boolean attributes** (`disabled`, `checked`, ...) become bare props.
 *  - **Form state** becomes the uncontrolled spelling: `value` -> `defaultValue`,
 *    `checked` -> `defaultChecked`, `<option selected>` -> the select's
 *    `defaultValue`, `<textarea>text</textarea>` -> `defaultValue`. A controlled
 *    `value` with no `onChange` is a React warning and a frozen field.
 *  - **Void elements** (`br`, `img`, `input`, ...) carry no children, so they
 *    render self-closed.
 *  - **Text** is read from the DOM, so entities arrive decoded (`&amp;` is `&`)
 *    and the renderer escapes what JSX needs escaped. Whitespace is collapsed
 *    the way HTML collapses it. A run of text beside elements (mixed content has
 *    no stable identity for the parser, `InsertJsxChildren`) is wrapped in a
 *    `<span>`, which renders the same.
 *  - **`<svg>`** is cut out first and converted by the SVG importer
 *    (`svgToJsxNode`): its sanitizer keeps `<use href="#...">` references,
 *    remaps ids so two pastes never collide, and resolves `<style>` classes.
 *
 * ## Sanitized first, and again at the edge
 *
 * Nothing here runs, renders or evaluates the markup. It is parsed inert
 * (`DOMParser`), its `<style>` text is lifted out, and the rest goes through the
 * DOMPurify boundary (`sanitizePastedHtml`): no `<script>`, no handlers, no
 * `javascript:` URLs. The converter then re-checks what it reads - an `on*`
 * name, an unsafe URL scheme, a CSS value `sanitiseCssValue` refuses is dropped
 * and COUNTED - so a sanitizer bypass would still not reach the file, and the
 * server runs the same checks on what arrives (`studioInsertHtmlStyles.ts`).
 * The report says what was left out; nothing is dropped silently.
 */
import { sanitiseCssValue } from '@core/css-sanitize'
import { cssPropertyToStyleKey } from '@core/css-codemods/browser'
import { isSafeUrl } from '@core/html-sanitize'
import { isEventHandlerAttributeName, isReservedRuntimeDataAttributeName } from '@core/htmlAttributes'
import { sanitizePastedHtml } from '@core/sanitize'
import { isSafeIntrinsicTagName, VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'
import { MAX_PASTED_CSS_CHARS, MAX_PASTED_DEPTH, MAX_PASTED_ELEMENTS, MAX_PASTED_HTML_CHARS } from '@core/utils/pastedHtmlLimits'
import type { JsonDataValue } from '@core/utils/jsonData'
import { cssValueLoadsExternalResource, markupToJsxAttributeName } from '@core/vector'
import type { HtmlToJsxReport } from './htmlToJsxReport'
import type { SlotJsxNode } from './studioSaveRequests'
import { parseDeclarations } from './svgImportStyles'
import { svgToJsxNode } from './svgToJsxNode'

export type HtmlToJsxResult =
  | { ok: true; nodes: SlotJsxNode[]; css: string; report: HtmlToJsxReport }
  | { ok: false; message: string }

const WHITESPACE = /[ \t\r\n\f]+/g

/** Elements whose edges end a line of text - leading/trailing spaces beside them do not render. */
const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul', 'br', 'video', 'audio', 'canvas', 'picture', 'select', 'textarea',
])

const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'disablepictureinpicture', 'disableremoteplayback', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope',
  'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed',
  'selected',
])

/** Attributes whose value is a URL (or a list of them) the browser may follow or load. */
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'longdesc', 'ping', 'srcset',
  'xlink:href', 'codebase', 'manifest',
])

/** Attributes where an inline raster image (`data:image/png;base64,...`) is a legitimate value. */
const IMAGE_URL_ATTRIBUTES = new Set(['src', 'srcset', 'poster'])
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i

/** React props that mean something to React and nothing to HTML - never written from a paste. */
const RESERVED_PROPS = new Set(['key', 'ref', 'children', 'dangerouslySetInnerHTML', 'suppressHydrationWarning'])

const JSX_ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** `<input type>` values whose `value` is a LABEL or an identifier, not text the user edits. */
const FIXED_VALUE_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio'])

/** Counter for the placeholder that carries a cut-out `<svg>` through the sanitizer. */
const SVG_MARK_ATTRIBUTE = 'data-studio-svg'

interface ConversionContext {
  report: HtmlToJsxReport
  elements: number
  tooLarge: boolean
  svgs: readonly SvgSlot[]
  nonce: string
}

type SvgSlot = { ok: true; node: SlotJsxNode } | { ok: false; message: string }

export function htmlToJsx(html: string): HtmlToJsxResult {
  if (!html.trim()) return { ok: false, message: 'There is no HTML to paste.' }
  if (html.length > MAX_PASTED_HTML_CHARS) {
    return {
      ok: false,
      message: 'That HTML is too large to write into your source in one paste. Paste a section at a time.',
    }
  }

  const report: HtmlToJsxReport = { scripts: 0, handlers: 0, unsafeUrls: 0, styleDeclarations: 0, svgRefusals: [] }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  report.scripts = parsed.querySelectorAll('script').length
  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (isEventHandlerAttributeName(name)) report.handlers += 1
      else if (URL_ATTRIBUTES.has(name) && !isAcceptableUrl(name, attribute.value)) report.unsafeUrls += 1
    }
  }

  const nonce = randomNonce()
  const svgs = cutOutSvgs(parsed, nonce)
  const css = takeStyleText(parsed)
  if (css.length > MAX_PASTED_CSS_CHARS) {
    return { ok: false, message: 'The stylesheet in that HTML is too large to write into your project in one paste.' }
  }

  const sanitized = sanitizePastedHtml(parsed.body.innerHTML)
  if (!sanitized.trim()) {
    return {
      ok: false,
      message: parsed.body.innerHTML.trim()
        ? 'Studio could not make that HTML safe to write into your source, so nothing was pasted.'
        : css.trim()
          ? 'That HTML is only a stylesheet - there are no elements to place.'
          : 'There is no HTML to paste.',
    }
  }

  const clean = new DOMParser().parseFromString(sanitized, 'text/html')
  const context: ConversionContext = { report, elements: 0, tooLarge: false, svgs, nonce }
  const nodes = convertChildren(clean.body, context, 0, false)
    .filter((child) => typeof child !== 'string' || child.trim() !== '')
    .flatMap(asSpans(context))

  if (context.tooLarge) {
    return {
      ok: false,
      message: `That HTML has more than ${MAX_PASTED_ELEMENTS} elements, or nests deeper than ${MAX_PASTED_DEPTH} levels - too large to write into your source in one paste. Paste a section at a time.`,
    }
  }
  if (nodes.length === 0) {
    return {
      ok: false,
      message: report.svgRefusals[0] ?? 'That HTML has no elements Studio can write into your source.',
    }
  }
  return { ok: true, nodes, css, report }
}

function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join('')
}

/**
 * Every outermost `<svg>`, converted by the SVG importer and replaced in the
 * document by a placeholder the sanitizer keeps (a `data-*` attribute) and the
 * walk below swaps back. The nonce makes the placeholder unforgeable by the
 * pasted markup itself.
 */
function cutOutSvgs(doc: Document, nonce: string): SvgSlot[] {
  const slots: SvgSlot[] = []
  for (const svg of Array.from(doc.body.querySelectorAll('svg'))) {
    if (svg.parentElement?.closest('svg')) continue
    const converted = svgToJsxNode(new XMLSerializer().serializeToString(svg))
    slots.push(converted.ok ? { ok: true, node: converted.node } : { ok: false, message: converted.message })
    const placeholder = doc.createElement('span')
    placeholder.setAttribute(SVG_MARK_ATTRIBUTE, `${nonce}:${slots.length - 1}`)
    svg.replaceWith(placeholder)
  }
  return slots
}

/** The text of every `<style>` block, in document order; the blocks are removed from the tree. */
function takeStyleText(doc: Document): string {
  const parts: string[] = []
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const text = style.textContent ?? ''
    if (text.trim()) parts.push(text.trim())
    style.remove()
  }
  return parts.join('\n')
}

type Converted = SlotJsxNode | string

/**
 * The children of `parent` as JSX nodes. A text run that sits beside elements
 * is returned as a `<span>`; a lone text run is returned as a bare string for
 * the caller to use as the element's text.
 */
function convertChildren(parent: Element, context: ConversionContext, depth: number, preserveWhitespace: boolean): Converted[] {
  const children = Array.from(parent.childNodes)
  const parentIsBlock = BLOCK_LEVEL.has(parent.localName)
  const out: Converted[] = []
  children.forEach((child, index) => {
    if (child.nodeType === 3) {
      const text = preserveWhitespace
        ? (child.nodeValue ?? '')
        : spaceFor(child.nodeValue ?? '', neighbour(children, index, -1), neighbour(children, index, 1), parentIsBlock)
      if (text) out.push(text)
      return
    }
    if (child.nodeType !== 1) return
    const converted = convertElement(child as Element, context, depth + 1)
    out.push(...converted)
  })
  return out
}

function neighbour(nodes: readonly ChildNode[], index: number, step: -1 | 1): ChildNode | null {
  return nodes[index + step] ?? null
}

/**
 * A text node's rendered text: whitespace collapsed to single spaces, and the
 * edges trimmed where HTML would not render them (against a block, or at the
 * edge of a block parent).
 */
function spaceFor(raw: string, before: ChildNode | null, after: ChildNode | null, parentIsBlock: boolean): string {
  let text = raw.replace(WHITESPACE, ' ')
  if (before ? isBlock(before) : parentIsBlock) text = text.replace(/^ /, '')
  if (after ? isBlock(after) : parentIsBlock) text = text.replace(/ $/, '')
  return text
}

function isBlock(node: ChildNode): boolean {
  return node.nodeType === 1 && BLOCK_LEVEL.has((node as Element).localName)
}

function convertElement(element: Element, context: ConversionContext, depth: number): SlotJsxNode[] {
  const mark = element.getAttribute(SVG_MARK_ATTRIBUTE)
  if (mark?.startsWith(`${context.nonce}:`)) {
    const slot = context.svgs[Number(mark.slice(context.nonce.length + 1))]
    if (slot?.ok) {
      context.elements += 1
      return [slot.node]
    }
    if (slot) context.report.svgRefusals.push(slot.message)
    return []
  }

  if (depth > MAX_PASTED_DEPTH || context.elements >= MAX_PASTED_ELEMENTS) {
    context.tooLarge = true
    return []
  }

  const tag = element.localName.toLowerCase()
  // A tag Studio will not write (a custom element, anything unsafe): its
  // content still reads, so it is hoisted rather than lost with its wrapper.
  if (!isSafeIntrinsicTagName(tag)) {
    return convertChildren(element, context, depth, false).flatMap(asSpans(context))
  }
  context.elements += 1

  const props = convertAttributes(element, tag, context)
  const node: SlotJsxNode = { name: tag }

  if (VOID_HTML_ELEMENTS.has(tag)) {
    if (Object.keys(props).length > 0) node.props = props
    return [node]
  }

  if (tag === 'textarea') {
    const text = element.textContent ?? ''
    if (text && props.defaultValue === undefined) props.defaultValue = text.replace(/^\n/, '')
    if (Object.keys(props).length > 0) node.props = props
    return [node]
  }

  if (tag === 'select') {
    const chosen = selectedOptionValues(element)
    if (chosen.length === 1) props.defaultValue = chosen[0]!
    else if (chosen.length > 1) props.defaultValue = chosen
  }

  const preserve = tag === 'pre'
  const converted = convertChildren(element, context, depth, preserve)
  const hasElements = converted.some((child) => typeof child !== 'string')
  if (Object.keys(props).length > 0) node.props = props

  if (!hasElements) {
    const text = converted.join('')
    if (text && !preserve && !text.trim()) return [node]
    if (text && !text.includes('\n')) node.children = text
    else if (text) node.children = preservedLines(text)
    return [node]
  }
  const children = converted.flatMap(asSpans(context))
  node.children = preserve ? children.flatMap(splitPreformattedSpans) : children
  return [node]
}

/** A converted child as nodes: a text run becomes the `<span>` that holds it. */
function asSpans(context: ConversionContext): (child: Converted) => SlotJsxNode[] {
  return (child) => {
    if (typeof child !== 'string') return [child]
    context.elements += 1
    return [{ name: 'span', children: child }]
  }
}

/**
 * The lines of a preformatted block as nodes: one `<span>` per line, `<br />`
 * between them. JSX collapses newlines and trims indentation inside text, so
 * the only way to keep a code block's shape in source is to make each line its
 * own run - the browser renders `pre` whitespace as written inside a span.
 */
function preservedLines(text: string): SlotJsxNode[] {
  const nodes: SlotJsxNode[] = []
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push({ name: 'br' })
    if (line) nodes.push({ name: 'span', children: line })
  })
  return nodes
}

function splitPreformattedSpans(node: SlotJsxNode): SlotJsxNode[] {
  if (node.name !== 'span' || typeof node.children !== 'string' || !node.children.includes('\n')) return [node]
  return preservedLines(node.children)
}

/** The values of the `<option selected>`s under a select (the option's text when it has no `value`). */
function selectedOptionValues(select: Element): string[] {
  return Array.from(select.querySelectorAll('option'))
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.getAttribute('value') ?? (option.textContent ?? '').trim())
}

function convertAttributes(element: Element, tag: string, context: ConversionContext): Record<string, JsonDataValue> {
  const props: Record<string, JsonDataValue> = {}
  const inputType = (element.getAttribute('type') ?? 'text').toLowerCase()
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value

    if (isEventHandlerAttributeName(name)) {
      continue // counted from the raw document; the sanitizer removed it already
    }
    if (name === 'xmlns' || name.startsWith('xmlns:') || name === 'is' || name === SVG_MARK_ATTRIBUTE) continue
    if (isReservedRuntimeDataAttributeName(name)) continue // the canvas's own `data-node-id` / `data-studio-*`
    if (name === 'class') {
      const tokens = value.split(WHITESPACE).filter(Boolean)
      if (tokens.length > 0) props.className = tokens.join(' ')
      continue
    }
    if (name === 'style') {
      const style = convertInlineStyle(value, context)
      if (style) props.style = style
      continue
    }
    // Counted from the raw document above; the sanitizer has removed it already, this is the second lock.
    if (URL_ATTRIBUTES.has(name) && !isAcceptableUrl(name, value)) continue
    if (tag === 'option' && name === 'selected') continue // carried by the select's defaultValue

    const jsxName = jsxAttributeName(name, tag, inputType)
    if (!jsxName || RESERVED_PROPS.has(jsxName) || !JSX_ATTRIBUTE_NAME.test(jsxName)) continue

    if (BOOLEAN_ATTRIBUTES.has(name) && (value === '' || value.toLowerCase() === name)) {
      props[jsxName] = true
      continue
    }
    props[jsxName] = value
  }
  return props
}

/** The JSX prop an HTML attribute is written as, with the uncontrolled-form rewrite applied. */
function jsxAttributeName(name: string, tag: string, inputType: string): string | undefined {
  if (name === 'checked' && tag === 'input') return 'defaultChecked'
  if (name === 'value' && (tag === 'select' || tag === 'textarea')) return 'defaultValue'
  if (name === 'value' && tag === 'input' && !FIXED_VALUE_INPUTS.has(inputType)) return 'defaultValue'
  return markupToJsxAttributeName(name)
}

function isAcceptableUrl(name: string, value: string): boolean {
  const candidates = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value]
  return candidates.every(
    (url) => isSafeUrl(url) || (IMAGE_URL_ATTRIBUTES.has(name) && INLINE_IMAGE.test(url.replace(/[\t\n\r]/g, '').trim())),
  )
}

/** `style="a: b"` as a React style object; a declaration that loads a resource or fails the CSS sanitizer is dropped and counted. */
function convertInlineStyle(value: string, context: ConversionContext): Record<string, string> | undefined {
  const style: Record<string, string> = {}
  for (const declaration of parseDeclarations(value)) {
    const safe = sanitiseCssValue(declaration.value)
    if (safe === null || cssValueLoadsExternalResource(safe)) {
      context.report.styleDeclarations += 1
      continue
    }
    style[cssPropertyToStyleKey(declaration.property)] = safe
  }
  return Object.keys(style).length > 0 ? style : undefined
}
