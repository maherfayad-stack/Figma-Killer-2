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

/** The four buckets a field filters on. */
export type VariableKind = 'color' | 'length' | 'number' | 'other'

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

/**
 * Classifies one resolved custom-property value.
 *
 * `value` must already have had its own `var()` indirection resolved by the
 * caller (`resolveVariableValue` in the admin-side scanner does this): a
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
  return 'other'
}

/** One offerable project variable, as the picker renders it. */
export interface VariableOption {
  /** Property name including the leading dashes, e.g. `--color-primary`. */
  readonly name: string
  /** The value with its own `var()` indirection resolved, for the swatch / readout. */
  readonly resolvedValue: string
  readonly kind: VariableKind
  /**
   * Where the declaration came from. Not a file path — the client receives
   * the project's stylesheets already concatenated (see
   * `studioRawCssStores.ts`), so the honest granularity is which of the two
   * bundles it was in.
   */
  readonly source: VariableSource
}

/** `project` = the workspace's own authored CSS; `vendor` = a package stylesheet. */
export type VariableSource = 'project' | 'vendor' | 'framework'

/** Human label for a source, shown as a group header in the picker. */
export const VARIABLE_SOURCE_LABEL: Readonly<Record<VariableSource, string>> = {
  project: 'Project',
  vendor: 'Package',
  framework: 'Framework',
}

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
