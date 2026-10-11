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
 *   - props named like HTML attributes: no event handler, nothing React treats
 *     as its own (`key`, `ref`, `children`, `dangerouslySetInnerHTML`), no
 *     `srcDoc`, no runtime-reserved `data-*`;
 *   - scalar values, one list of strings (a multiple `<select>`'s default), and
 *     a `style` object of strings that pass the CSS value sanitizer;
 *   - a URL that is not `javascript:` / `vbscript:` / a non-image `data:`;
 *   - at most `MAX_PASTED_ELEMENTS` elements nested `MAX_PASTED_DEPTH` deep.
 */
import { sanitiseCssValue } from '@core/css-sanitize'
import { isSafeUrl } from '@core/html-sanitize'
import { isEventHandlerAttributeName, isReservedRuntimeDataAttributeName } from '@core/htmlAttributes'
import { isSafeIntrinsicTagName } from '@core/utils/htmlTags'
import { MAX_PASTED_DEPTH, MAX_PASTED_ELEMENTS } from '@core/utils/pastedHtmlLimits'
import { cssValueLoadsExternalResource } from '@core/vector'

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
const RESERVED_PROPS = new Set(['key', 'ref', 'children', 'dangerouslySetInnerHTML', 'suppressHydrationWarning', 'srcDoc'])
const URL_PROPS = new Set(['href', 'src', 'action', 'formAction', 'poster', 'data', 'cite', 'background', 'longDesc', 'ping', 'srcSet', 'manifest', 'codebase'])
const IMAGE_URL_PROPS = new Set(['src', 'srcSet', 'poster'])
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i

const refuse = (message: string): PastedGuardResult => ({ ok: false, message })

/** Validates every node under `roots`; the first violation refuses the paste. */
export function guardPastedNodes(roots: readonly PastedNode[]): PastedGuardResult {
  let count = 0
  const visit = (node: PastedNode, depth: number): PastedGuardResult => {
    count += 1
    if (count > MAX_PASTED_ELEMENTS || depth > MAX_PASTED_DEPTH) {
      return refuse(`A paste may write at most ${MAX_PASTED_ELEMENTS} elements nested ${MAX_PASTED_DEPTH} deep. Paste a section at a time.`)
    }
    if (node.importSpecifier !== undefined || node.designSystemImport !== undefined) {
      return refuse('Pasted HTML is written as plain HTML elements; a component import cannot come with it.')
    }
    if (!isSafeIntrinsicTagName(node.name)) {
      return refuse(`"${node.name}" is not an HTML element Studio will write from a paste.`)
    }
    for (const [name, value] of Object.entries(node.props ?? {})) {
      const refusal = guardProp(node.name, name, value)
      if (refusal) return refusal
    }
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
  if (!PROP_NAME.test(name) || RESERVED_PROPS.has(name) || isEventHandlerAttributeName(name) || isReservedRuntimeDataAttributeName(name)) {
    return refuse(`"${name}" on <${tag}> is not an attribute Studio will write from a paste.`)
  }
  if (name === 'style') {
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
  if (typeof value === 'string' && URL_PROPS.has(name) && !isAcceptableUrl(name, value)) {
    return refuse(`The ${name} on <${tag}> is not a URL Studio will write from a paste (scripts and non-image data URLs are refused).`)
  }
  return null
}

function isAcceptableUrl(name: string, value: string): boolean {
  const urls = name === 'srcSet' ? value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '') : [value]
  return urls.every((url) => isSafeUrl(url) || (IMAGE_URL_PROPS.has(name) && INLINE_IMAGE.test(url.replace(/[\t\n\r]/g, '').trim())))
}
