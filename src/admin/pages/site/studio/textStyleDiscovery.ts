/**
 * textStyleDiscovery - CT-5: which of the project's classes are TEXT STYLES and
 * which are EFFECT STYLES.
 *
 * Figma keeps text and effect styles in a library. This codebase has no such
 * object, and does not get one: a style here is a class in the user's own
 * stylesheet (or CSS Module) whose declarations are one bundle. Applying it is
 * adding that class to the element; nothing is stored anywhere Studio owns.
 *
 *   - **Text style** - a class with at least one CORE typography declaration
 *     (family, size, weight, line height, letter spacing) and nothing else but
 *     typography: the style properties below plus the companions a type class
 *     usually carries (alignment, colour, wrapping). A class that also sets
 *     `margin` or `display` is a component's class, not a type style.
 *   - **Effect style** - a class whose every declaration is a shadow or a blur
 *     (`box-shadow`, `filter`, `backdrop-filter`, `text-shadow`), at least one
 *     of them not `text-shadow`.
 *
 * Both rules read the registry the board already loaded (`site.styleRules`,
 * built from real `.css` and `*.module.css` files), so a rule is a style
 * exactly when the cascade says it is one - no marker, no naming convention.
 * A class declared only inside a breakpoint is judged on those declarations
 * too. Framework-generated utilities (`.text-size-lg`, one declaration of a
 * token scale) and styled-component synthetic classes are not styles: the first
 * is regenerated from `.studio/framework.json`, the second has no class token
 * in the user's source at all.
 *
 * Pure: no store, no DOM, no network.
 */
import { isGeneratedClass, type StyleRule } from '@core/page-tree'

export type StyleFamily = 'text' | 'effect'

/** What "create style from selection" captures and "apply" replaces, per family (camelCase, the `CSSPropertyBag` spelling). */
const STYLE_PROPERTIES: Readonly<Record<StyleFamily, readonly string[]>> = {
  text: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'textDecoration',
    'textTransform',
    'textIndent',
    'fontVariantNumeric',
    'fontFeatureSettings',
    'fontKerning',
    'fontVariationSettings',
  ],
  effect: ['boxShadow', 'textShadow', 'filter', 'backdropFilter'],
}

/** Declarations a type class usually carries next to its style properties. Tolerated by discovery, never captured by a create. */
const TEXT_COMPANIONS: readonly string[] = [
  'textAlign',
  'color',
  'whiteSpace',
  'wordSpacing',
  'wordBreak',
  'overflowWrap',
  'textOverflow',
  'textWrap',
  'hyphens',
  'fontStretch',
]

/** At least one of these makes a bundle a style of the family at all. */
const CORE_PROPERTIES: Readonly<Record<StyleFamily, readonly string[]>> = {
  text: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'],
  effect: ['boxShadow', 'filter', 'backdropFilter'],
}

export const STYLE_FAMILIES: readonly StyleFamily[] = ['text', 'effect']

export interface DiscoveredStyle {
  ruleId: string
  family: StyleFamily
  /** The class as the user wrote it: the local name for a CSS Module class, never the compiled hash. */
  label: string
  /** Base declarations as CSS value strings, camelCase keys. */
  declarations: Readonly<Record<string, string>>
  /**
   * True when the class also changes these properties inside a breakpoint or
   * condition. Applying it is fine; turning it into inline values is not - a
   * `style=""` attribute cannot be media-queried - so detach refuses.
   */
  hasContextOverrides: boolean
}

export type DiscoveredStyles = Readonly<Record<StyleFamily, readonly DiscoveredStyle[]>>

export interface DiscoveryOptions {
  /** Rules that have no class token in the user's source (a styled-component's synthetic class). Never offered. */
  excludedRuleIds?: ReadonlySet<string>
}

/** The properties a `family` style owns - what a create captures and an apply replaces on the element. */
export function styleProperties(family: StyleFamily): readonly string[] {
  return STYLE_PROPERTIES[family]
}

/** Numbers a unitless property takes as they are; every other number is a React pixel length. */
const UNITLESS_PROPERTIES: ReadonlySet<string> = new Set(['lineHeight', 'fontWeight'])

/**
 * A declaration value as the CSS text a stylesheet holds, or `null` for an
 * empty one. A bare number is what React's `style={{ fontSize: 40 }}` means by
 * `40px`; written into a `.css` file it would be an invalid declaration, so
 * the unit is added here, once, for every reader of an inline bag or a rule.
 */
export function cssValueText(property: string, value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return UNITLESS_PROPERTIES.has(property) || value === 0 ? String(value) : `${value}px`
}

/** A rule's base declarations as strings; empty values dropped. */
function baseDeclarations(rule: StyleRule): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [property, value] of Object.entries(rule.styles)) {
    const text = cssValueText(property, value)
    if (text !== null) out[property] = text
  }
  return out
}

function contextProperties(rule: StyleRule): string[] {
  const properties: string[] = []
  for (const bag of Object.values(rule.contextStyles)) {
    for (const [property, value] of Object.entries(bag)) if (cssValueText(property, value) !== null) properties.push(property)
  }
  return properties
}

function classify(rule: StyleRule): { family: StyleFamily; declarations: Record<string, string>; overrides: boolean } | null {
  if (rule.kind !== 'class' || rule.rawCss !== undefined || isGeneratedClass(rule)) return null
  const declarations = baseDeclarations(rule)
  const properties = Object.keys(declarations)
  const overrideProperties = contextProperties(rule)
  const all = [...properties, ...overrideProperties]
  if (properties.length === 0) return null

  for (const family of STYLE_FAMILIES) {
    const allowed = new Set([...STYLE_PROPERTIES[family], ...(family === 'text' ? TEXT_COMPANIONS : [])])
    if (!all.every((property) => allowed.has(property))) continue
    if (!properties.some((property) => CORE_PROPERTIES[family].includes(property))) continue
    // A one-line `font-size` class is a utility (`.text-lg`), not a bundle - unless it carries its own
    // line height, which is what makes Tailwind's own `.text-lg` a type step. Effects have no such rule:
    // `.shadow-md` is one declaration and a perfectly good effect style.
    if (family === 'text' && properties.length < 2) return null
    return { family, declarations, overrides: overrideProperties.length > 0 }
  }
  return null
}

/**
 * Every text and effect style in the registry, each family sorted by label.
 * O(rules); the registry is already in memory, and the caller (the inspector)
 * is compiled so this only reruns when `styleRules` changes.
 */
export function discoverStyles(styleRules: Readonly<Record<string, StyleRule>>, options: DiscoveryOptions = {}): DiscoveredStyles {
  const found: Record<StyleFamily, DiscoveredStyle[]> = { text: [], effect: [] }
  for (const rule of Object.values(styleRules)) {
    if (options.excludedRuleIds?.has(rule.id)) continue
    const classified = classify(rule)
    if (!classified) continue
    found[classified.family].push({
      ruleId: rule.id,
      family: classified.family,
      label: rule.displayName ?? rule.name,
      declarations: classified.declarations,
      hasContextOverrides: classified.overrides,
    })
  }
  for (const family of STYLE_FAMILIES) found[family].sort((a, b) => a.label.localeCompare(b.label))
  return found
}

/** The style of `family` an element carries, from its `classIds`, or `null`. The first one wins when it somehow carries several. */
export function appliedStyle(styles: DiscoveredStyles, family: StyleFamily, classIds: readonly string[]): DiscoveredStyle | null {
  for (const classId of classIds) {
    const hit = styles[family].find((style) => style.ruleId === classId)
    if (hit) return hit
  }
  return null
}

/** Every style of `family` on the element - what an apply takes off before adding the new one. */
export function appliedStyles(styles: DiscoveredStyles, family: StyleFamily, classIds: readonly string[]): DiscoveredStyle[] {
  return styles[family].filter((style) => classIds.includes(style.ruleId))
}

/** One line for a menu row: the values a designer reads first. */
export function summarizeStyle(style: DiscoveredStyle): string {
  const d = style.declarations
  if (style.family === 'text') {
    const parts = [d.fontFamily?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, ''), d.fontWeight, d.fontSize && d.lineHeight ? `${d.fontSize} / ${d.lineHeight}` : d.fontSize]
    return parts.filter((part): part is string => Boolean(part)).join(' · ')
  }
  const first = d.boxShadow ?? d.filter ?? d.backdropFilter ?? d.textShadow ?? ''
  return first.length > 40 ? `${first.slice(0, 37)}...` : first
}
