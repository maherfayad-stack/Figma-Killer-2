/**
 * What an UNSET property row shows in its placeholder.
 *
 * Track F1 made the placeholder the frame's real `getComputedStyle` value
 * instead of a spec-default guess, which was the right call — "a field can
 * confidently read `transparent` on an element rendering red" was the bug it
 * fixed. But `getComputedStyle` answers in the BROWSER's vocabulary, and two
 * consequences of that were shipped without being noticed:
 *
 * 1. **It loses the author's own words.** Apply a colour style and the row
 *    reads `rgb(135, 91, 247)` — never `var(--brand-500)`, never the name of
 *    the class that set it. The value is correct and unrecognisable. The
 *    panel already knows better: `stylePropertyProvenance` has computed which
 *    declaration is winning, and that declaration is the literal text in the
 *    user's CSS.
 * 2. **Shorthands come back expanded.** `background` computes to
 *    `rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box`
 *    and `animation` to `none 0s ease 0s 1 normal none running`. Neither is
 *    something a person reads; both are already stated legibly by the
 *    longhand rows directly beneath them.
 *
 * So the order here is: **what the CSS says, then what the browser renders,
 * then the spec default** — falling back only when the more honest answer
 * isn't available, and showing nothing at all rather than shorthand noise.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import type { PropertyProvenance } from './stylePropertyProvenance'

/**
 * Shorthands whose computed form is a full expansion — useful to a parser,
 * noise to a reader, and redundant beside the longhand rows in the same
 * section. When nothing declares one of these, the row shows an empty field
 * rather than the expansion.
 *
 * A DECLARED value still shows: if the user's CSS literally says
 * `background: url(hero.png) center / cover`, that is exactly what they
 * wrote and belongs in the field.
 */
const EXPANSION_NOISE_SHORTHANDS: ReadonlySet<keyof CSSPropertyBag> = new Set([
  'background',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'outline',
  'transition',
  'animation',
  'font',
  'flex',
] as ReadonlyArray<keyof CSSPropertyBag>)

interface PlaceholderInput {
  property: keyof CSSPropertyBag
  /**
   * Per-property provenance, when the caller computed one. Absent for the
   * surfaces that don't yet thread it (and in tests), which degrades this to
   * exactly the pre-existing computed-then-default behaviour.
   */
  provenance?: PropertyProvenance
  /**
   * The caller's already-merged "current" value for this property — the
   * computed-truth base layer folded under the stored bag
   * (`{ ...computedValues, ...stored }`).
   */
  currentValue: unknown
}

/**
 * The placeholder for an unset row, or `undefined` for "leave the field
 * blank".
 *
 * Order:
 *   1. the winning DECLARATION's own text — `var(--brand-500)`, `1.5rem`,
 *      whatever the user's CSS actually says. Only when provenance could
 *      attribute a winner honestly; an `ambiguous` cascade crowns nobody and
 *      falls through rather than guessing.
 *   2. the computed value from the real frame — ground truth, in the
 *      browser's words.
 *   3. the spec default from the hand-written table.
 *
 * …except for an expansion-noise shorthand, which stops after step 1.
 */
export function resolveStylePlaceholder({
  property,
  provenance,
  currentValue,
}: PlaceholderInput): string | undefined {
  const declared = provenance?.sources.find((source) => source.winner)?.value
  if (declared !== undefined && hasStyleValue(declared)) return String(declared)

  if (EXPANSION_NOISE_SHORTHANDS.has(property)) return undefined

  if (hasStyleValue(currentValue)) return String(currentValue)

  const fallback = getCSSPropertyDefaultValue(property)
  return hasStyleValue(fallback) ? String(fallback) : undefined
}
