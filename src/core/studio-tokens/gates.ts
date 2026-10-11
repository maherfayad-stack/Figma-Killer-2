/**
 * gates — WHERE a custom-property declaration sits, read as the "mode" it
 * belongs to.
 *
 * A design token is rarely declared once. The same `--surface` is routinely
 * declared under `:root` (the default), under `[data-theme="dark"]` / `.dark` /
 * `@media (prefers-color-scheme: dark)` (the dark scheme), under `:lang(ar)`
 * (a locale), or inside a width `@media` (a breakpoint). Figma models those as
 * "modes" of a variable collection; in a real repository they are SELECTORS.
 * Nothing is stored beside the CSS: a mode is inferred from the gate a
 * declaration is written under, and "adding a mode" writes a gate block.
 *
 * ## The five gates
 *
 *   - `base`  — `:root` / `html` / `body` / `:host`, with at most `@layer` /
 *     `@supports` around it. The default value.
 *   - `attr`  — `[data-theme="dark"]`, `[dir=rtl]`, `:lang(ar)` (as attr `lang`).
 *     `negate` is the `:not([data-theme=light])` "dark unless told otherwise"
 *     pattern.
 *   - `class` — `.dark`, `html.compact`.
 *   - `media` — a root declaration inside an `@media` (`prefers-color-scheme`,
 *     `min-width`, `prefers-contrast`).
 *   - `scope` — everything else: a component's own tokens (`.btn { --btn-pad }`).
 *     Declared tokens, but not a mode, so they never become a column.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const ModeGateSchema = Type.Union([
  Type.Object({ kind: Type.Literal('base') }),
  Type.Object({
    kind: Type.Literal('attr'),
    attr: Type.String({ minLength: 1, maxLength: 80 }),
    value: Type.String({ maxLength: 80 }),
    negate: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ kind: Type.Literal('class'), className: Type.String({ minLength: 1, maxLength: 80 }) }),
  Type.Object({ kind: Type.Literal('media'), query: Type.String({ minLength: 1, maxLength: 200 }) }),
  Type.Object({ kind: Type.Literal('scope'), selector: Type.String({ minLength: 1, maxLength: 200 }) }),
])
export type ModeGate = Static<typeof ModeGateSchema>

export const BASE_GATE: ModeGate = { kind: 'base' }

/** A stable identity for a gate — equal gates have equal keys. */
export function gateKey(gate: ModeGate): string {
  switch (gate.kind) {
    case 'base':
      return 'base'
    case 'attr':
      return `attr:${gate.negate ? '!' : ''}${gate.attr}=${gate.value}`
    case 'class':
      return `class:${gate.className}`
    case 'media':
      return `media:${gate.query}`
    case 'scope':
      return `scope:${gate.selector}`
  }
}

const ROOT_HOST_RE = /^(?::root|html|body|:host)$/i
const ROOT_PREFIX_RE = /^(?::root|html|body|:host)(?=[.[:])/i
const WRAPPED_RE = /^:(?:where|is)\(\s*(.+?)\s*\)$/i
const ATTR_RE = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]$/
const NOT_ATTR_RE = /^:not\(\s*\[\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]\s*\)$/
const LANG_RE = /^:lang\(\s*["']?([\w-]+)["']?\s*\)$/i
const CLASS_RE = /^\.([\w-]+)$/
/** Bare class names that are unmistakably a mode, not a component. */
const MODE_CLASS_RE = /^(?:dark|light|dark-mode|light-mode|dark-theme|light-theme|theme-[\w-]+|[\w-]+-theme|high-contrast|compact|comfortable)$/i

function unwrap(segment: string): string {
  const wrapped = WRAPPED_RE.exec(segment)
  return wrapped ? wrapped[1]!.trim() : segment
}

function mediaQueryOf(atRules: readonly string[]): string | null {
  const queries = atRules
    .map((rule) => /^@media\b\s*(.*)$/i.exec(rule)?.[1]?.trim() ?? null)
    .filter((query): query is string => query !== null && query.length > 0)
  return queries.length === 0 ? null : queries.join(' and ')
}

/** The gate of ONE selector segment (no commas), given the `@media` it sits in. */
function classifySegment(rawSegment: string, media: string | null): ModeGate {
  const segment = unwrap(rawSegment.trim())
  if (ROOT_HOST_RE.test(segment)) return media ? { kind: 'media', query: media } : BASE_GATE

  // `html.dark`, `:root[data-theme=dark]` — strip the root host, judge the rest.
  const hasRootPrefix = ROOT_PREFIX_RE.test(segment)
  const rest = hasRootPrefix ? segment.replace(ROOT_PREFIX_RE, '') : segment

  const lang = LANG_RE.exec(rest)
  if (lang) return { kind: 'attr', attr: 'lang', value: lang[1]! }

  const notAttr = NOT_ATTR_RE.exec(rest)
  if (notAttr) return { kind: 'attr', attr: notAttr[1]!, value: notAttr[2] ?? notAttr[3] ?? notAttr[4] ?? '', negate: true }

  const attr = ATTR_RE.exec(rest)
  if (attr) return { kind: 'attr', attr: attr[1]!, value: attr[2] ?? attr[3] ?? attr[4] ?? '' }

  const cls = CLASS_RE.exec(rest)
  if (cls && (hasRootPrefix || MODE_CLASS_RE.test(cls[1]!))) return { kind: 'class', className: cls[1]! }

  return { kind: 'scope', selector: segment }
}

/**
 * The gates a rule's declarations belong to: one per comma-separated selector
 * segment (`:root, [data-theme=dark] { ... }` declares BOTH the default and the
 * dark value), deduplicated. A declaration outside any rule (`@theme { ... }`)
 * has no selector and reads as `base`.
 */
export function classifyGates(selector: string | null, atRules: readonly string[]): ModeGate[] {
  const media = mediaQueryOf(atRules)
  if (selector === null) return [media ? { kind: 'media', query: media } : BASE_GATE]
  const seen = new Set<string>()
  const gates: ModeGate[] = []
  for (const segment of selector.split(',')) {
    if (segment.trim().length === 0) continue
    const gate = classifySegment(segment, media)
    const key = gateKey(gate)
    if (seen.has(key)) continue
    seen.add(key)
    gates.push(gate)
  }
  return gates.length > 0 ? gates : [BASE_GATE]
}

/** The selector text that, written in CSS, declares values for `gate`. */
export function gateSelector(gate: ModeGate): string {
  switch (gate.kind) {
    case 'base':
      return ':root'
    case 'attr': {
      if (gate.attr === 'lang' && !gate.negate) return `:lang(${gate.value})`
      const test = gate.value === '' ? `[${gate.attr}]` : `[${gate.attr}="${gate.value}"]`
      return gate.negate ? `:not(${test})` : test
    }
    case 'class':
      return `.${gate.className}`
    case 'media':
      return ':root'
    case 'scope':
      return gate.selector
  }
}

// ---------------------------------------------------------------------------
// Modes — a gate read as "the dark mode of the colour scheme axis"
// ---------------------------------------------------------------------------

export interface GateMode {
  /** The axis the mode belongs to: `color-scheme`, `locale`, `direction`, `breakpoint`, `media`, or an attribute name (`density`). */
  readonly axisId: string
  readonly axisLabel: string
  /** `dark`, `ar`, `rtl`, `compact`, `(min-width: 768px)`. */
  readonly modeId: string
  readonly modeLabel: string
}

const COLOR_SCHEME_ATTR_RE = /theme|color-?scheme|mode$/i
const SCHEME_VALUE_RE = /^(?:dark|light)$/i

function titleCase(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

function colorScheme(value: string): GateMode {
  return { axisId: 'color-scheme', axisLabel: 'Color scheme', modeId: value, modeLabel: titleCase(value) }
}

/**
 * The mode a gate selects, or `null` for `base` (the default of every axis)
 * and `scope` (not a mode at all).
 */
export function modeOfGate(gate: ModeGate): GateMode | null {
  switch (gate.kind) {
    case 'base':
    case 'scope':
      return null
    case 'class': {
      const scheme = /^(dark|light)(?:-mode|-theme)?$/i.exec(gate.className)
      if (scheme) return colorScheme(scheme[1]!.toLowerCase())
      return { axisId: 'theme', axisLabel: 'Theme', modeId: gate.className, modeLabel: gate.className }
    }
    case 'attr': {
      const value = gate.value.toLowerCase()
      if (gate.attr === 'lang') return { axisId: 'locale', axisLabel: 'Locale', modeId: gate.value, modeLabel: gate.value }
      if (gate.attr === 'dir') return { axisId: 'direction', axisLabel: 'Direction', modeId: gate.value, modeLabel: gate.value.toUpperCase() }
      if (COLOR_SCHEME_ATTR_RE.test(gate.attr) || SCHEME_VALUE_RE.test(value)) {
        // `:not([data-theme=light])` means "dark, unless explicitly light".
        if (gate.negate) return colorScheme(value === 'light' ? 'dark' : 'light')
        return colorScheme(value)
      }
      const axisId = gate.attr.replace(/^data-/, '')
      return { axisId, axisLabel: titleCase(axisId), modeId: gate.value, modeLabel: gate.value || gate.attr }
    }
    case 'media': {
      const scheme = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(gate.query)
      if (scheme) return colorScheme(scheme[1]!.toLowerCase())
      if (/(?:min|max)-(?:width|height)|width\s*[<>]|height\s*[<>]/i.test(gate.query)) {
        return { axisId: 'breakpoint', axisLabel: 'Breakpoint', modeId: gate.query, modeLabel: gate.query }
      }
      return { axisId: 'media', axisLabel: 'Media', modeId: gate.query, modeLabel: gate.query }
    }
  }
}

/** True when the gate is the colour scheme's dark mode — what `studio_set_tokens`' `scheme: "dark"` means. */
export function isDarkSchemeGate(gate: ModeGate): boolean {
  const mode = modeOfGate(gate)
  return mode !== null && mode.axisId === 'color-scheme' && mode.modeId === 'dark'
}
