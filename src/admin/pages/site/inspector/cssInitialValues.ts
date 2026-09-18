/**
 * cssInitialValues — TRUE CSS initial values for Fill's non-inherited claimed
 * properties, used ONLY to decide whether a computed value with nothing
 * stored anywhere is "genuinely unset" (matches the spec initial → the row
 * stays hidden, Law 1's empty state is honest) or "something real is
 * rendering here and Studio just cannot say who declared it" (show it,
 * muted) — see `renderedNotStored.ts`, the one caller.
 *
 * ## NOT `DEFAULT_CSS_VALUES` (`panels/PropertiesPanel/cssControlTypes.ts`)
 *
 * That table answers a different question — "what to seed when ADDING a
 * property via search", a UX default — and is confirmed wrong for this
 * purpose for at least two entries:
 *
 *   - `objectFit`: the table says `'cover'`; CSS Images Level 3's own
 *     `object-fit` initial value is `'fill'`.
 *   - `objectPosition`: the table says `'center center'` (the author-facing
 *     keyword form); `getComputedStyle` always normalizes this to `'50% 50%'`
 *     — the SAME value, spelled differently, which a naive string compare
 *     would misread as "not the initial" and show a row for an element that
 *     has genuinely nothing set. `STATE.md` `panel-30` has the full account
 *     of why these two tables must not be merged.
 *
 * Every value below is the property's own CSS-spec-defined `Initial:` line,
 * not copied from a UX table or guessed.
 *
 * `color` is deliberately absent — it is an INHERITED property
 * (`stylePropertyProvenance.ts`'s `INHERITED_PROPERTIES`), and
 * `renderedNotStored.ts` never consults this table for an inherited
 * property; `PropertyProvenance.inherited` is already the right signal there.
 *
 * The `background` shorthand is also deliberately absent: a shorthand has no
 * single spec-defined initial *serialization* (it is "initial value of each
 * longhand", and browsers do not agree on what `getComputedStyle` reports for
 * the shorthand property itself) — and Fill's `background` row stays
 * stored-only in this PR regardless (see `FillSection.tsx`'s own doc), so
 * there is nothing here that would ever consult a missing entry for it in
 * practice. `isTrueCssInitialValue` returns `false` for any property this
 * table doesn't cover, matching the "unknown → default to meaningful" rule
 * below.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { parseCssColor } from '@ui/components/ColorPickerPopover'
import { normalizeForComparison } from '../panels/PropertiesPanel/stylePropertyProvenance'

/**
 * True CSS initial value for each non-inherited Fill property this table
 * covers, as a string — the same shape `getComputedStyle` returns.
 */
const CSS_INITIAL_VALUES: Partial<Record<keyof CSSPropertyBag, string>> = {
  // CSS Backgrounds and Borders Level 3 §background-color — Initial: transparent
  backgroundColor: 'transparent',
  // §background-image — Initial: none
  backgroundImage: 'none',
  // §background-size — Initial: auto
  backgroundSize: 'auto',
  // §background-position — Initial: 0% 0%
  backgroundPosition: '0% 0%',
  // §background-repeat — Initial: repeat
  backgroundRepeat: 'repeat',
  // §background-attachment — Initial: scroll
  backgroundAttachment: 'scroll',
  // §background-origin — Initial: padding-box
  backgroundOrigin: 'padding-box',
  // §background-clip — Initial: border-box
  backgroundClip: 'border-box',
  // CSS Compositing and Blending Level 1 §background-blend-mode — Initial: normal
  backgroundBlendMode: 'normal',
  // CSS Images Level 3 §object-fit — Initial: fill. NOT 'cover' — see module doc.
  objectFit: 'fill',
  // CSS Images Level 3 §object-position — Initial: 50% 50%, reported by
  // `getComputedStyle` in that exact percentage form — see module doc.
  objectPosition: '50% 50%',
}

/**
 * Properties whose value is a colour, compared via `parseCssColor` so
 * `'transparent'` and its equivalent encodings (`'rgba(0, 0, 0, 0)'`, etc.)
 * are recognised as the same value regardless of spelling.
 */
const COLOR_VALUED_PROPERTIES: ReadonlySet<string> = new Set(['backgroundColor'])

function colorsEqual(a: string, b: string): boolean {
  const parsedA = parseCssColor(a)
  const parsedB = parseCssColor(b)
  if (!parsedA || !parsedB) return false
  return (
    parsedA.rgba.r === parsedB.rgba.r &&
    parsedA.rgba.g === parsedB.rgba.g &&
    parsedA.rgba.b === parsedB.rgba.b &&
    parsedA.rgba.a === parsedB.rgba.a
  )
}

/**
 * True when `computedValue` IS `property`'s true CSS initial value — i.e.
 * nothing is genuinely painting/sizing/positioning anything here, and the
 * element renders exactly what an unstyled browser default would.
 *
 * False for every property this table doesn't cover (an unknown/future Fill
 * property) and for a value this function cannot parse: a false POSITIVE
 * here just shows a real value in an unusual spelling (cosmetic noise, fixed
 * by extending the comparator later); a false NEGATIVE silently re-hides the
 * exact fact `renderedNotStored.ts` exists to surface. Favor the former.
 */
export function isTrueCssInitialValue(property: keyof CSSPropertyBag, computedValue: string): boolean {
  const initial = CSS_INITIAL_VALUES[property]
  if (initial === undefined) return false

  if (COLOR_VALUED_PROPERTIES.has(String(property))) {
    return colorsEqual(initial, computedValue)
  }

  return normalizeForComparison(initial) === normalizeForComparison(computedValue)
}
