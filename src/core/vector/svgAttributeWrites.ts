/**
 * svgAttributeWrites — the one rule for which SVG attributes Studio writes into
 * a user's `.tsx`, and what values it will write there.
 *
 * Two writers put SVG attributes into source, and both take their input from
 * places Studio does not control:
 *
 *   - the importer (`svgToJsxNode.ts`) — an SVG file or pasted markup;
 *   - the `svg-attr` edit (`setSvgPartAttributes`, P5-D SVG-4) — a name and a
 *     value that arrive over `POST /save` from the editor, a plugin or an
 *     agent.
 *
 * They share this module so there is ONE answer to "may this be written",
 * built on the reference policy in `svgReferences.ts` (fragment-only `href`,
 * no remote `url()`), which the canvas sanitizer applies too. A second, looser
 * copy on either path is how a beacon or a handler would get in.
 *
 * Pure string code, no DOM: it runs in the browser and on the server.
 */
import { cssValueLoadsExternalResource, isSvgFragmentReference } from './svgReferences'
import { isSvgPartStampAttribute } from './svgPartStamps'

/**
 * Markup attribute names never written, whatever the value: `xmlns`
 * declarations (XML plumbing React neither needs nor accepts on a child
 * element) and `on*` event handlers (script). Case-insensitive, as HTML reads
 * attribute names.
 */
export function isSvgAttributeNeverWritten(markupName: string): boolean {
  const name = markupName.toLowerCase()
  return name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('on')
}

/** Attributes whose value is text for people (`aria-label`, `data-*`), never a CSS value to vet. */
export function isSvgTextAttribute(name: string): boolean {
  return name.startsWith('aria-') || name.startsWith('data-')
}

/**
 * The SVG elements an `svg-attr` edit may write: shapes, groups, paint servers
 * and text. Everything a vector edit touches, and nothing that runs or loads:
 * no `script`, `foreignObject`, `a`, `image`, `feImage`, and no animation
 * element (`set`/`animate` can assign `href` at runtime through
 * `attributeName`/`to`).
 */
export const SVG_WRITABLE_PART_TAGS: ReadonlySet<string> = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'use',
  'mask', 'clipPath', 'symbol', 'pattern', 'title', 'desc',
])

/** JSX names React owns rather than the DOM: writing one as a string is a runtime error or a different element. */
const REACT_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'key', 'ref', 'children', 'style', 'dangerouslySetInnerHTML',
  'suppressContentEditableWarning', 'suppressHydrationWarning',
])

/** A JSX attribute name as it may be written: an identifier, hyphens allowed (`data-x`, `aria-label`), no namespace colon. */
const JSX_ATTRIBUTE_NAME = /^[A-Za-z_][\w-]*$/

/** The longest value one attribute write may carry (a 2,000-anchor `d` is ~40 KB). */
export const MAX_SVG_ATTRIBUTE_VALUE_LENGTH = 256 * 1024

export type SvgAttributeWriteRefusalReason = 'svg-attr-name' | 'svg-attr-value'

export interface SvgAttributeWriteRefusal {
  reason: SvgAttributeWriteRefusalReason
  message: string
}

/** `jsxName` as the markup attribute the browser sees (`xlinkHref` → `xlink:href`), lower-cased for the checks below. */
function markupSpelling(jsxName: string): string {
  if (jsxName === 'xlinkHref') return 'xlink:href'
  return jsxName.toLowerCase()
}

/**
 * Why one attribute may not be written with this value, or `null` when it may.
 * `jsxName` is the JSX spelling (`strokeWidth`), as it appears in source.
 */
export function svgAttributeWriteRefusal(jsxName: string, value: string | number): SvgAttributeWriteRefusal | null {
  if (!JSX_ATTRIBUTE_NAME.test(jsxName) || REACT_RESERVED_NAMES.has(jsxName) || isSvgPartStampAttribute(jsxName)) {
    return { reason: 'svg-attr-name', message: `"${jsxName.slice(0, 60)}" is not an SVG attribute Studio can write.` }
  }
  const markup = markupSpelling(jsxName)
  if (isSvgAttributeNeverWritten(markup)) {
    return { reason: 'svg-attr-name', message: `"${jsxName}" is an event handler or a namespace, and Studio does not write those.` }
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? null
      : { reason: 'svg-attr-value', message: `"${jsxName}" needs a finite number.` }
  }
  if (value.length > MAX_SVG_ATTRIBUTE_VALUE_LENGTH) {
    return { reason: 'svg-attr-value', message: `The value for "${jsxName}" is too long to write into your source.` }
  }
  if (markup === 'href' || markup === 'xlink:href') {
    return isSvgFragmentReference(value)
      ? null
      : { reason: 'svg-attr-value', message: `"${jsxName}" may only point inside the SVG (#name), so Studio will not write "${value.slice(0, 60)}".` }
  }
  if (!isSvgTextAttribute(markup) && cssValueLoadsExternalResource(value)) {
    return {
      reason: 'svg-attr-value',
      message: `"${jsxName}" would load something from outside the SVG, and Studio will not write a remote reference into your source.`,
    }
  }
  return null
}
