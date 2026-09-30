/**
 * splitSvgRoot — a literal `<svg>`'s markup split into the root element's
 * attributes (as React props) and its inner markup, so `SvgEditor` can render
 * the `<svg>` AS the node instead of injecting it into a Studio-owned wrapper.
 *
 * ## Why the canvas needs this
 *
 * `base.svg` stores the graphic as one markup string. The only way to put
 * markup into React is `dangerouslySetInnerHTML`, which fills an element's
 * CHILDREN — so rendering the string whole needs a parent element, and that
 * parent used to be a `<span style="display:contents">` carrying the node's
 * editor wiring. The canvas DOM was then `.row > span > svg` where the user's
 * app has `.row > svg`: `.row > svg`, `svg:first-child` and `svg + span` all
 * matched something different in the editor than in the app, and the resize
 * offer refused the node because its host had `display: contents` (audit
 * `08-svg.md` §2 defect 1).
 *
 * Splitting the root off lets `SvgEditor` create the `<svg>` itself — with the
 * root's attributes, the node's editor props, and the root's CHILDREN as its
 * `__html`. `innerHTML` on an element in the SVG namespace parses in SVG
 * context, so the children are exactly the elements the markup describes.
 *
 * ## Why parse with the HTML parser
 *
 * The markup reaching here has been through DOMPurify, which returns HTML
 * serialisation. That is not always well-formed XML (an `&nbsp;` in a
 * `<text>`, a valueless attribute), so the XML parser could refuse markup the
 * browser renders fine. The HTML parser reads it exactly as the browser would
 * when the user's app renders the same `<svg>`.
 *
 * ## Cost
 *
 * One parse per distinct markup string, cached in a bounded LRU keyed by the
 * sanitised markup. A board with a hundred copies of one icon parses it once,
 * and a React re-render of an unchanged node is a map lookup.
 */
import type { CSSProperties } from 'react'
import { markupToJsxAttributeName } from '@core/vector'

export interface SvgRootParts {
  /** The root `<svg>`'s attributes as React props, minus `class` and `style`. */
  readonly attributes: Readonly<Record<string, string>>
  /** The root's `class`, if it wrote one. */
  readonly className?: string
  /** The root's `style`, as a React style object. */
  readonly style?: Readonly<CSSProperties>
  /** Everything inside the root, as markup. */
  readonly inner: string
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const CACHE_LIMIT = 500
const cache = new Map<string, SvgRootParts | null>()

/** Splits on `;` outside quotes and parentheses, so `url(data:…;base64,…)` stays one declaration. */
function splitDeclarations(css: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]!
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      parts.push(css.slice(start, i))
      start = i + 1
    }
  }
  parts.push(css.slice(start))
  return parts
}

/** A CSS property's key in a React style object (`stroke-width` → `strokeWidth`, `-webkit-x` → `WebkitX`). */
function styleKey(property: string): string {
  if (property.startsWith('--')) return property
  const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  if (property.startsWith('-ms-')) return camel(property.slice(1))
  if (property.startsWith('-')) {
    const key = camel(property.slice(1))
    return key.charAt(0).toUpperCase() + key.slice(1)
  }
  return camel(property)
}

function styleObject(css: string): CSSProperties | undefined {
  const style: Record<string, string> = {}
  for (const declaration of splitDeclarations(css)) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const property = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim()
    if (!property || !value) continue
    style[styleKey(property.startsWith('--') ? property : property.toLowerCase())] = value
  }
  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined
}

function split(markup: string): SvgRootParts | null {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html')
  const body = doc.body
  const elements = Array.from(body.children)
  const strayText = Array.from(body.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '')
  const root = elements[0]
  if (elements.length !== 1 || strayText || !root || root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    return null
  }

  const attributes: Record<string, string> = {}
  let className: string | undefined
  let style: CSSProperties | undefined
  for (const attribute of Array.from(root.attributes)) {
    if (attribute.name === 'class') {
      className = attribute.value || undefined
      continue
    }
    if (attribute.name === 'style') {
      style = styleObject(attribute.value)
      continue
    }
    // An event handler never survives the sanitiser; refusing one here too
    // keeps a React prop that runs code off this element whatever arrives.
    if (/^on/i.test(attribute.name)) continue
    const name = markupToJsxAttributeName(attribute.name)
    if (name !== undefined) attributes[name] = attribute.value
  }
  return Object.freeze({
    attributes: Object.freeze(attributes),
    ...(className ? { className } : {}),
    ...(style ? { style: Object.freeze(style) } : {}),
    inner: root.innerHTML,
  })
}

/**
 * The root `<svg>` of `markup` split into props and inner markup, or
 * `undefined` when the markup is not exactly one `<svg>` element (loose text,
 * two graphics, some other root) or there is no DOM parser to ask.
 */
export function splitSvgRoot(markup: string): SvgRootParts | undefined {
  const cached = cache.get(markup)
  if (cached !== undefined) {
    // Refresh recency: a Map iterates in insertion order, so the first key is
    // always the least recently used.
    cache.delete(markup)
    cache.set(markup, cached)
    return cached ?? undefined
  }
  if (typeof DOMParser === 'undefined') return undefined
  const parts = split(markup)
  cache.set(markup, parts)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return parts ?? undefined
}
