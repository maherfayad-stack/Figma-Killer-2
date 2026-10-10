/**
 * variableKind — what a project custom property's value IS, so a field only
 * offers the variables it can actually take.
 *
 * The rule this enforces is the panel's standing one: never render a control
 * that lies. A width field that offered `--color-primary` would let one click
 * write `width: var(--color-primary)` — a declaration the browser drops, and
 * a field that then reads back as "bound" while rendering nothing. So the
 * kind is inferred from the RESOLVED value (never from the name: `--brand-4`
 * is a colour in one project and a spacing step in another) and each field
 * declares which kinds it accepts.
 *
 * Deliberately self-contained — no `@core/design-tokens` import. `src/ui/`
 * primitives are portable (see `Tabs.tsx`'s doc), and the classification a
 * *picker* needs is coarse (four buckets), not the exact RGB the colour math
 * module computes.
 */

/**
 * The buckets a field filters on. `shadow`, `font-family` and `duration` are
 * the composite/keyword values a plain length field must NOT be offered (a
 * `box-shadow` field takes `--shadow-card`; a `width` field never does).
 */
export type VariableKind = 'color' | 'length' | 'number' | 'duration' | 'font-family' | 'shadow' | 'other'

/** `#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa`. */
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** Functional colour notations, including the wide-gamut and mixing ones. */
const COLOR_FN_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
/** The handful of bare keywords a design token realistically carries. */
const COLOR_KEYWORD_RE = /^(?:transparent|currentcolor|white|black)$/i
/** A number plus a CSS length/percentage unit. */
const LENGTH_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ch|ex|vh|vw|vmin|vmax|pt|pc|in|cm|mm|q|%)$/i
/** A bare number — line-height, opacity, z-index, flex-grow. */
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/
/** `200ms`, `0.3s`. */
const DURATION_RE = /^-?(?:\d+\.?\d*|\.\d+)m?s$/i
/** A family list ending in a generic family, or one that starts with a quoted family name. */
const FONT_FAMILY_RE = /(?:^|,)\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong)\s*$|^\s*["'][^"']+["']\s*(?:,|$)/i
/** One length inside a shadow: `0`, `2px`, `-1.5rem`. */
const SHADOW_LENGTH_RE = /(?:^|\s)-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)?(?=\s|$)/g
/** A colour token inside a shadow: hex, a functional colour, or a keyword. */
const SHADOW_COLOR_RE = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|\b(?:transparent|currentcolor|black|white)\b/i

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/** `0 1px 2px rgb(0 0 0 / 0.2)`, `inset 0 0 0 1px #fff`, and comma lists of them. */
function isShadowValue(value: string): boolean {
  return splitTopLevel(value).every((part) => {
    // Functional colours hold spaces and numbers of their own; count lengths outside them.
    const outsideColours = part.replace(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^)]*\)/gi, ' ')
    const lengths = outsideColours.match(SHADOW_LENGTH_RE)?.length ?? 0
    return lengths >= 2 && lengths <= 4 && SHADOW_COLOR_RE.test(part)
  })
}

/**
 * Classifies one resolved custom-property value.
 *
 * `value` must already have had its own `var()` indirection resolved by the
 * caller (the server's token catalog carries the resolved value): a
 * token whose declared text is `var(--brand)` classifies as `other` here,
 * which is correct for an UNRESOLVED value and wrong for the token itself.
 */
export function classifyVariableValue(value: string): VariableKind {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'other'
  if (HEX_RE.test(trimmed) || COLOR_FN_RE.test(trimmed) || COLOR_KEYWORD_RE.test(trimmed)) {
    return 'color'
  }
  if (LENGTH_RE.test(trimmed)) return 'length'
  if (NUMBER_RE.test(trimmed)) return 'number'
  if (DURATION_RE.test(trimmed)) return 'duration'
  if (FONT_FAMILY_RE.test(trimmed)) return 'font-family'
  if (isShadowValue(trimmed)) return 'shadow'
  return 'other'
}

/** One offerable project variable, as the picker renders it. */
export interface VariableOption {
  /** Property name including the leading dashes, e.g. `--color-primary`. */
  readonly name: string
  /** The value with its own `var()` indirection resolved, for the swatch / readout. */
  readonly resolvedValue: string
  readonly kind: VariableKind
  /** Which bundle owns the declaration: the project, a package, or Studio's Framework generator. */
  readonly source: VariableSource
  /** Project-relative file (or package specifier) that declares it; absent for the Framework generator, which has no file. */
  readonly file?: string
  /** The collection it belongs to (`color`, `space`) - a group header in the picker. */
  readonly collection?: string
  /** Its value in each other mode, resolved - `Dark: #5fd3e4`. Absent when it has one value. */
  readonly modes?: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

/** `project` = the workspace's own authored CSS; `vendor` = a package stylesheet. */
export type VariableSource = 'project' | 'vendor' | 'framework'

/** Human label for a source, shown as a group header in the picker. */
export const VARIABLE_SOURCE_LABEL: Readonly<Record<VariableSource, string>> = {
  project: 'Project',
  vendor: 'Package',
  framework: 'Framework',
}

/** Field-facing shorthand: the kinds a font-family field accepts. */
export const FONT_FAMILY_VARIABLE_KINDS: readonly VariableKind[] = ['font-family']
/** Field-facing shorthand: the kinds a shadow field accepts. */
export const SHADOW_VARIABLE_KINDS: readonly VariableKind[] = ['shadow']
/** Field-facing shorthand: the kinds a duration field accepts. */
export const DURATION_VARIABLE_KINDS: readonly VariableKind[] = ['duration']

/** Field-facing shorthand: the kinds a length-ish field accepts. */
export const LENGTH_VARIABLE_KINDS: readonly VariableKind[] = ['length', 'number']
/** Field-facing shorthand: the kinds a colour field accepts. */
export const COLOR_VARIABLE_KINDS: readonly VariableKind[] = ['color']

/**
 * Filters a catalog to the kinds a field accepts, preserving catalog order.
 * A field that accepts `other` gets everything, because `other` is the bucket
 * for values this module could not confidently type (a font stack, a
 * `cubic-bezier`, a shadow) — refusing those outright would hide real,
 * usable tokens from the generic string fields that CAN take them.
 */
export function filterVariablesByKind(
  options: readonly VariableOption[],
  accept: readonly VariableKind[],
): VariableOption[] {
  if (accept.includes('other')) return [...options]
  return options.filter((option) => accept.includes(option.kind))
}
