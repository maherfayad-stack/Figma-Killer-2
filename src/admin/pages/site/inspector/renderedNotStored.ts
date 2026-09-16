/**
 * renderedNotStored — the ONE shared predicate for "this property is
 * genuinely rendering something, even though nothing on the node's own class
 * chain or inline bag declares it."
 *
 * `STATE.md` `panel-30`: `FillSection.tsx`'s Law-1 disclosure (`setAnywhere`)
 * and its per-row `showXEntry` guards used to read `storedStyles`
 * exclusively — so a `body` element whose white background came from an
 * ambient/global CSS rule, or a text node's inherited black `color`, never
 * opened Fill even though the canvas plainly showed the colour. This
 * function is the fix's core: reused by Fill now, and by Stroke/Shadow/Blur
 * in their own follow-up PRs (see that ticket's Sequencing) — a section
 * MUST NOT reimplement this check inline; that would be exactly the "two
 * ways of doing something" `CLAUDE.md` bans.
 *
 * Pure, no React, no store — same shape as `resolveWriteTarget.ts`/
 * `styleFieldDisplay.ts`'s `resolveStyleFieldDisplay`, easy to unit test in
 * isolation.
 */
import type { PropertyProvenance } from '../panels/PropertiesPanel/stylePropertyProvenance'
import { isTrueCssInitialValue } from './cssInitialValues'

/**
 * True when `provenance` describes a property that:
 *   - nothing explicitly declares anywhere on this node (no class source, no
 *     inline source) — a property WITH a stored source is never "rendered
 *     not stored", it is simply stored; and
 *   - a real computed value is available (`computedValue !== undefined` —
 *     while a Tier 2 measurement is still in flight the caller must not even
 *     reach this function with a stale/absent read, see `FillSection.tsx`'s
 *     own `computedValuesLoading` guard); and
 *   - that computed value is either INHERITED (an ancestor's declaration —
 *     `provenance.inherited`, already exactly the right signal for the small
 *     set of properties CSS inherits) or, for a non-inherited property,
 *     genuinely different from that property's true CSS initial value
 *     (`cssInitialValues.ts` — an ordinary element with nothing painted
 *     computes to its initial and must not flood the panel).
 */
export function rendersUnstoredValue(provenance: PropertyProvenance | undefined): boolean {
  if (!provenance) return false
  if (provenance.sources.length > 0) return false
  if (provenance.computedValue === undefined) return false
  if (provenance.inherited) return true
  return !isTrueCssInitialValue(provenance.property, provenance.computedValue)
}
