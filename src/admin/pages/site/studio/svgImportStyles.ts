/**
 * svgImportStyles — the CSS half of turning an SVG file into JSX React can
 * render: `style="…"` strings and `<style>` blocks, resolved into
 * presentation attributes and a `style` OBJECT.
 *
 * ## Why this exists
 *
 * SVGs exported from Illustrator, Figma and Inkscape carry their paint as CSS,
 * and neither CSS form can be written into a `.tsx` as it stands:
 *
 * - `style="fill:#fff;stroke-width:2"` copied verbatim is `<path style="…"/>`,
 *   and React throws at render ("The `style` prop expects a mapping from style
 *   properties to values, not a string") — in the user's real app, on a page
 *   the canvas drew perfectly.
 * - `<style>.cls-1{fill:#f00}</style>` is not a tag Studio writes
 *   (`validateSubtree` refuses `style`), and even if it were, an inline SVG's
 *   `<style>` is a DOCUMENT-WIDE stylesheet: every icon exported from
 *   Illustrator names its classes `.cls-1`, `.cls-2`, …, so two of them on one
 *   page repaint each other, and both repaint anything else of the user's that
 *   happens to use the name.
 *
 * So both are resolved here, per element, into the cascade result the browser
 * would have computed from the SVG's own CSS, and written in the one shape
 * that means the same thing everywhere: a presentation attribute
 * (`fill="#fff"`, `strokeWidth="2"`) where SVG has one, and an entry in a
 * `style={{…}}` object where it does not.
 *
 * ## One precedence change, on purpose
 *
 * A presentation attribute is the weakest source in the cascade, so CSS from
 * the user's own page (`.toolbar svg path { fill: currentColor }`) now beats
 * paint that used to arrive as SVG-internal CSS. For an icon that is the
 * behaviour the user wants — it is how a hand-written icon lets the page
 * recolour it — and it is the same call Penpot's SVG import makes
 * (`common/src/app/common/svg.cljc`, `svg-presentation-attrs`).
 *
 * ## What a `<style>` block may contain
 *
 * Single-class rules (`.cls-1 { … }`, and comma lists of them — which is every
 * rule Illustrator writes). Anything else — a type or id selector, a
 * combinator, a pseudo-class, an `@media` or `@font-face` — has a meaning that
 * depends on the tree or the viewport, not on one element's own classes, and
 * cannot be pinned onto elements without guessing. That refuses with a
 * sentence the user can act on, before a byte is written.
 */

/** One `property: value` pair, `!important` split off. */
export interface CssDeclaration {
  /** Lowercased, except a custom property (`--x`), whose name is case-sensitive. */
  property: string
  value: string
  important: boolean
}

/** One rule of an SVG's `<style>` block, flattened to a single class. */
export interface ClassRule {
  className: string
  declarations: CssDeclaration[]
}

export type ClassStylesheetResult = { ok: true; rules: ClassRule[] } | { ok: false; message: string }

/**
 * CSS properties that have an SVG presentation attribute React knows how to
 * spell. The set is the SVG presentation attributes (Penpot's
 * `svg-presentation-attrs`) intersected with what React DOM aliases to the
 * dashed name (`strokeWidth` → `stroke-width`) or passes through unchanged
 * (`fill`) — anything outside React's list would render as a camelCase
 * attribute the browser silently ignores (`maskType` is not `mask-type`), so it
 * goes in the style object instead, where camelCase is the spelling.
 */
const PRESENTATION_PROPERTIES: ReadonlySet<string> = new Set([
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'cursor',
  'direction', 'display', 'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule',
  'filter', 'flood-color', 'flood-opacity', 'font-family', 'font-size', 'font-size-adjust',
  'font-stretch', 'font-style', 'font-variant', 'font-weight', 'image-rendering',
  'letter-spacing', 'lighting-color', 'marker-end', 'marker-mid', 'marker-start', 'mask',
  'opacity', 'overflow', 'paint-order', 'pointer-events', 'shape-rendering', 'stop-color',
  'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'text-anchor',
  'text-decoration', 'text-rendering', 'unicode-bidi', 'vector-effect', 'visibility',
  'word-spacing', 'writing-mode',
])

/**
 * Values only CSS can hold. A presentation attribute is parsed with the
 * property's grammar but WITHOUT the CSS-only machinery — `var()` and the math
 * functions do not resolve there, and the reset keywords mean nothing — so a
 * declaration using one stays in the style object, where it keeps working.
 */
const CSS_ONLY_VALUE = /\b(?:var|calc|env|attr|min|max|clamp)\s*\(|^\s*(?:initial|unset|revert|revert-layer)\s*$/i

/** A property name worth keeping. Anything else a browser would drop as invalid, so this drops it too. */
const PROPERTY_NAME = /^(?:--[\w-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/

/** One class selector — the only selector a rule may use to be inlined. */
const CLASS_SELECTOR = /^\.(-?[_a-zA-Z][\w-]*)$/

/** Sentence tail every `<style>` refusal ends with: what the user can do about it. */
const REEXPORT_HINT =
  'Re-export the SVG with presentation attributes instead of internal CSS (Illustrator: Styling → Presentation Attributes), then try again.'

/**
 * Splits `text` on `separator` wherever it is not inside quotes or
 * parentheses — so `fill:url(data:image/png;base64,…)` stays one declaration
 * and `font-family:"A;B"` stays one value.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** The index of the first `target` in `text` at or after `from` that is not inside quotes, or -1. */
function indexOutsideQuotes(text: string, target: string, from: number): number {
  let quote: string | undefined
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === target) return i
  }
  return -1
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--|-->/g, ' ')
}

/**
 * A declaration block (`fill:#fff; stroke-width: 2 !important`) as a list, in
 * source order. A declaration with no colon, no value or an invalid property
 * name is dropped — exactly what a browser does with it — so nothing here can
 * invent paint the original never showed.
 */
export function parseDeclarations(block: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = []
  for (const raw of splitTopLevel(stripComments(block), ';')) {
    const colon = raw.indexOf(':')
    if (colon === -1) continue
    const name = raw.slice(0, colon).trim()
    let value = raw.slice(colon + 1).trim()
    if (!PROPERTY_NAME.test(name)) continue
    const important = /!\s*important\s*$/i.test(value)
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim()
    if (!value) continue
    declarations.push({ property: name.startsWith('--') ? name : name.toLowerCase(), value, important })
  }
  return declarations
}

/**
 * An SVG `<style>` block's rules, flattened to one {@link ClassRule} per class
 * selector and kept in source order (which is what decides between two rules
 * of equal specificity), or the refusal sentence for the first thing in it that
 * cannot be inlined. See this module's doc for why only class rules can be.
 */
export function parseClassStylesheet(css: string): ClassStylesheetResult {
  const text = stripComments(css)
  const rules: ClassRule[] = []
  let cursor = 0
  while (cursor < text.length) {
    const rest = text.slice(cursor)
    const leading = rest.length - rest.trimStart().length
    cursor += leading
    if (cursor >= text.length) break

    if (text[cursor] === '@') {
      const atName = /^@([\w-]+)/.exec(text.slice(cursor))?.[1] ?? 'at-'
      return { ok: false, message: `This SVG's <style> block contains an @${atName} rule, which Studio cannot turn into attributes on the shapes it styles. ${REEXPORT_HINT}` }
    }

    const open = indexOutsideQuotes(text, '{', cursor)
    const close = open === -1 ? -1 : indexOutsideQuotes(text, '}', open + 1)
    const nested = close === -1 ? -1 : indexOutsideQuotes(text.slice(0, close), '{', open + 1)
    if (open === -1 || close === -1 || nested !== -1) {
      return { ok: false, message: `This SVG's <style> block is not CSS Studio can read, so it cannot tell which shapes it colours. ${REEXPORT_HINT}` }
    }

    const declarations = parseDeclarations(text.slice(open + 1, close))
    for (const rawSelector of splitTopLevel(text.slice(cursor, open), ',')) {
      const selector = rawSelector.trim().replace(/\s+/g, ' ')
      const className = CLASS_SELECTOR.exec(selector)?.[1]
      if (className === undefined) {
        return {
          ok: false,
          message: `This SVG styles its shapes with the CSS rule "${selector}", which Studio cannot turn into attributes — only single-class rules such as ".cls-1 { fill: red }" can be written inline. ${REEXPORT_HINT}`,
        }
      }
      rules.push({ className, declarations })
    }
    cursor = close + 1
  }
  return { ok: true, rules }
}

/**
 * The declarations that win on one element, from its matching `<style>` rules
 * (already in stylesheet order) and its own `style` attribute — the cascade the
 * browser would have run inside the SVG. Inline beats a rule; `!important`
 * beats both, and an important inline declaration beats an important rule.
 */
export function cascadeDeclarations(
  ruleDeclarations: readonly CssDeclaration[],
  inlineDeclarations: readonly CssDeclaration[],
): Map<string, string> {
  const winners = new Map<string, string>()
  const passes: [readonly CssDeclaration[], boolean][] = [
    [ruleDeclarations, false],
    [inlineDeclarations, false],
    [ruleDeclarations, true],
    [inlineDeclarations, true],
  ]
  for (const [declarations, important] of passes) {
    for (const declaration of declarations) {
      if (declaration.important === important) winners.set(declaration.property, declaration.value)
    }
  }
  return winners
}

/** `stroke-width` → `strokeWidth`: the JSX spelling of a presentation attribute. */
function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * A CSS property's key in a React `style` object: camelCase, with React's
 * vendor-prefix rule (`-webkit-x` → `WebkitX`, `-ms-x` → `msX`); a custom
 * property keeps its name, which React sets verbatim.
 */
function styleObjectKey(property: string): string {
  if (property.startsWith('--')) return property
  if (property.startsWith('-ms-')) return camelCase(property.slice(1))
  if (property.startsWith('-')) {
    const key = camelCase(property.slice(1))
    return key.charAt(0).toUpperCase() + key.slice(1)
  }
  return camelCase(property)
}

/**
 * The winning declarations, split into the two JSX shapes that can carry them:
 * presentation attributes (by their JSX name) and a React `style` object.
 */
export function declarationsToJsx(declarations: ReadonlyMap<string, string>): {
  attributes: Record<string, string>
  style: Record<string, string>
} {
  const attributes: Record<string, string> = {}
  const style: Record<string, string> = {}
  for (const [property, value] of declarations) {
    if (PRESENTATION_PROPERTIES.has(property) && !CSS_ONLY_VALUE.test(value)) {
      attributes[camelCase(property)] = value
    } else {
      style[styleObjectKey(property)] = value
    }
  }
  return { attributes, style }
}
