/**
 * studioPastedHtmlGuard - the server's own check of a pasted HTML fragment
 * before a byte of it is written (G-10).
 *
 * The editor sanitizes and converts the markup (`htmlToJsx.ts`), but a request
 * body is not the editor: `studio_apply_edits` and any hand-built POST reach
 * the same `insert` edit, and Bun has no DOM to sanitize with. So the server
 * does the part that needs no DOM - it validates the converted TREE against
 * what a pasted design may contain, and REFUSES the whole paste on the first
 * violation (never repairs it: a fragment that is half what was sent is not
 * what anyone asked to write).
 *
 * What a pasted tree may hold:
 *   - intrinsic, safe tags only (no component, no `script`, no `iframe`);
 *   - props on the shared ALLOWLIST (`pastedHtmlProps.ts`), compared lowercased:
 *     no event handler, nothing React treats as its own, no `srcDoc`, no
 *     runtime-reserved `data-*`; every URL-bearing prop (`href`, `xlinkHref`,
 *     `action`, `formAction`, ...) is judged whatever its case, and so are the
 *     `values`/`to`/`from`/`by` of SVG animation;
 *   - scalar values, one list of strings (a multiple `<select>`'s default), and
 *     a `style` object of strings that pass the CSS value sanitizer;
 *   - a URL that is not `javascript:` / `vbscript:` / a non-image `data:`;
 *   - at most `MAX_PASTED_ELEMENTS` elements nested `MAX_PASTED_DEPTH` deep.
 */
import { sanitiseCssValue } from '@core/css-sanitize'
import { isSafeUrl } from '@core/html-sanitize'
import { isEventHandlerAttributeName, isReservedRuntimeDataAttributeName } from '@core/htmlAttributes'
import { isSafeIntrinsicTagName } from '@core/utils/htmlTags'
import { MAX_PASTED_DEPTH, MAX_PASTED_ELEMENTS, MAX_PASTED_HTML_CHARS } from '@core/utils/pastedHtmlLimits'
import { isAllowedPastedProp } from '@core/utils/pastedHtmlProps'
import { cssValueLoadsExternalResource, isSvgFragmentReference } from '@core/vector'

/** The structural subset of the wire's insert node this module reads. */
export interface PastedNode {
  name: string
  importSpecifier?: string
  designSystemImport?: true
  props?: Record<string, unknown>
  children?: string | readonly PastedNode[]
}

export type PastedGuardResult = { ok: true } | { ok: false; message: string }

const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Props whose value is a URL (or a list of them) a browser may follow or load. */
const URL_PROPS = new Set([
  'href', 'xlinkhref', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'longdesc', 'ping',
  'srcset', 'imagesrcset', 'manifest', 'codebase', 'xmlbase',
])
const IMAGE_URL_PROPS = new Set(['src', 'srcset', 'poster'])
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i

/** Elements a pasted design never needs and whose content is a script or document host. */
const REFUSED_TAGS = new Set(['math', 'foreignobject'])
/** SVG elements whose `href` may only point at a fragment of the same document. */
const FRAGMENT_HREF_TAGS = new Set(['use', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'textpath', 'mpath', 'feimage'])
/** SVG animation: it can set ANY attribute, `href` included, from `values`/`to`/`from`/`by`. */
const ANIMATION_TAGS = new Set(['animate', 'set', 'animatemotion', 'animatetransform'])
const ANIMATION_VALUE_PROPS = ['values', 'to', 'from', 'by']

const refuse = (message: string): PastedGuardResult => ({ ok: false, message })

/** Validates every node under `roots`; the first violation refuses the paste. */
export function guardPastedNodes(roots: readonly PastedNode[]): PastedGuardResult {
  let count = 0
  let chars = 0
  const visit = (node: PastedNode, depth: number): PastedGuardResult => {
    count += 1
    if (count > MAX_PASTED_ELEMENTS || depth > MAX_PASTED_DEPTH) {
      return refuse(`A paste may write at most ${MAX_PASTED_ELEMENTS} elements nested ${MAX_PASTED_DEPTH} deep. Paste a section at a time.`)
    }
    if (node.importSpecifier !== undefined || node.designSystemImport !== undefined) {
      return refuse('Pasted HTML is written as plain HTML elements; a component import cannot come with it.')
    }
    if (!isSafeIntrinsicTagName(node.name) || REFUSED_TAGS.has(node.name.toLowerCase())) {
      return refuse(`"${node.name}" is not an HTML element Studio will write from a paste.`)
    }
    const tag = node.name.toLowerCase()
    // Text bounded BEFORE it is walked in depth: the wire schema caps one string, this caps the sum.
    chars += (typeof node.children === 'string' ? node.children.length : 0) + JSON.stringify(node.props ?? {}).length
    if (chars > MAX_PASTED_HTML_CHARS * 2) return refuse('That paste carries too much text to write in one go. Paste a section at a time.')
    for (const [name, value] of Object.entries(node.props ?? {})) {
      const refusal = guardProp(tag, name, value)
      if (refusal) return refusal
    }
    const animated = ANIMATION_TAGS.has(tag) ? guardAnimation(tag, node.props ?? {}) : null
    if (animated) return animated
    if (Array.isArray(node.children)) {
      for (const child of node.children as readonly PastedNode[]) {
        const result = visit(child, depth + 1)
        if (!result.ok) return result
      }
    }
    return { ok: true }
  }
  for (const root of roots) {
    const result = visit(root, 1)
    if (!result.ok) return result
  }
  return { ok: true }
}

function guardProp(tag: string, name: string, value: unknown): PastedGuardResult | null {
  const lower = name.toLowerCase().replace(/[-:]/g, '')
  if (!PROP_NAME.test(name) || !isAllowedPastedProp(name) || isEventHandlerAttributeName(name) || isReservedRuntimeDataAttributeName(name)) {
    return refuse(`"${name}" on <${tag}> is not an attribute Studio will write from a paste.`)
  }
  if (lower === 'style') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse(`The style on <${tag}> must be an object of CSS values.`)
    for (const [property, cssValue] of Object.entries(value)) {
      if (typeof cssValue !== 'string' || sanitiseCssValue(cssValue) === null || cssValueLoadsExternalResource(cssValue)) {
        return refuse(`The "${property}" value on <${tag}> is not a CSS value Studio will write from a paste.`)
      }
    }
    return null
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string') ? null : refuse(`"${name}" on <${tag}> must be a list of text values.`)
  }
  if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
    return refuse(`"${name}" on <${tag}> must be text, a number or a flag.`)
  }
  if (typeof value === 'string' && URL_PROPS.has(lower)) {
    if (!isAcceptableUrl(lower, value)) {
      return refuse(`The ${name} on <${tag}> is not a URL Studio will write from a paste (scripts and non-image data URLs are refused).`)
    }
    if ((lower === 'href' || lower === 'xlinkhref') && FRAGMENT_HREF_TAGS.has(tag) && !isSvgFragmentReference(value)) {
      return refuse(`The ${name} on <${tag}> may only point at a fragment of the same graphic.`)
    }
  }
  return null
}

/** `<animate>`/`<set>` assign an attribute from `values`/`to`/`from`/`by`: aimed at `href`, that is a script URL. Every such value is checked as a URL, whatever the target. */
function guardAnimation(tag: string, props: Record<string, unknown>): PastedGuardResult | null {
  for (const key of ANIMATION_VALUE_PROPS) {
    const value = Object.entries(props).find(([name]) => name.toLowerCase() === key)?.[1]
    if (typeof value !== 'string') continue
    if (value.split(';').some((part) => !isSafeUrl(part))) {
      return refuse(`The ${key} on <${tag}> carries a script URL, which Studio will not write from a paste.`)
    }
  }
  return null
}

function isAcceptableUrl(name: string, value: string): boolean {
  const urls = name === 'srcset' || name === 'imagesrcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value]
  return urls.every((url) => isSafeUrl(url) || (IMAGE_URL_PROPS.has(name) && INLINE_IMAGE.test(url.replace(/[\t\n\r]/g, '').trim())))
}
