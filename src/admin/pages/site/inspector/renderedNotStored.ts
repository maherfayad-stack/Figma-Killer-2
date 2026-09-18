/**
 * renderedNotStored — the ONE shared predicate for "this property renders a
 * real value that the ACTIVE EDITING CONTEXT's own stored bag does not
 * declare."
 *
 * `STATE.md` `panel-30` shipped this for exactly one shape of that fact:
 * nothing on the node's own class chain or inline bag declares the property
 * ANYWHERE, yet the frame plainly paints/inherits something real (a `body`'s
 * ambient white background, a text node's ordinary inherited black `color`).
 *
 * `STATE.md` `panel-32` widened it to a second, genuinely different shape of
 * the SAME fact: the property IS declared — just not at the context
 * currently being edited. A mobile project's `.title` class declares
 * `color: var(--text-base-default)` at BASE; the user is looking at a
 * non-desktop breakpoint tab with no `color` override there.
 * `FillSection.tsx`'s `storedStyles` is deliberately CONTEXT-ONLY
 * (`collapsedStyleBag.ts`'s own doc: "a value set only at BASE reads as
 * unset-here"), so the row's "is this stored" check came back false — but
 * `SelectionModel.provenanceByProperty` is built from the EFFECTIVE
 * (base-merged-with-override) chain, so IT saw a source and the old
 * single-argument `rendersUnstoredValue(provenance)` returned false too (its
 * very first check: "a property WITH a stored source is never 'rendered not
 * stored'"). The property fell through both the "stored here" bag and the
 * "rendered, not stored anywhere" predicate — Fill showed nothing, and the
 * section's own header action still offered "Add text colour" next to a
 * canvas plainly rendering one.
 *
 * The fix: this predicate now takes a second, required argument —
 * `storedAtActiveContext`, the caller's own "does the ACTIVE CONTEXT'S bag
 * declare this" fact (`hasStyleValue(storedStyles[prop])` in every caller
 * today) — and a property declared elsewhere (`provenance.sources.length >
 * 0`, computed from the EFFECTIVE chain) is now, on its own, enough to
 * qualify: something real and user-authored explains the value, it just
 * isn't THIS context's own declaration. The `isTrueCssInitialValue` UA-default
 * guard is never consulted for this branch — that guard exists only to keep
 * an ordinary element from flooding the panel when NOTHING anywhere declares
 * the property; a property with a real declared source is never a UA
 * default, by construction.
 *
 * Reused by Fill now, and available to any future section with the same
 * context-only-vs-effective split (`STATE.md` `panel-32`'s own note on why
 * Stroke's per-side colour row and Shadow/Blur's structured layers were left
 * out of that same change) — a section MUST NOT reimplement this check
 * inline; that would be exactly the "two ways of doing something" `CLAUDE.md`
 * bans.
 *
 * Pure, no React, no store — same shape as `resolveWriteTarget.ts`/
 * `styleFieldDisplay.ts`'s `resolveStyleFieldDisplay`, easy to unit test in
 * isolation.
 */
import type { PropertyProvenance } from '../panels/PropertiesPanel/stylePropertyProvenance'
import { isTrueCssInitialValue } from './cssInitialValues'

/**
 * True when `provenance` describes a property that:
 *   - the ACTIVE CONTEXT's own bag does NOT declare (`storedAtActiveContext`
 *     is false — a property already stored here is simply stored, never
 *     "rendered not stored"); and
 *   - a real computed value is available (`computedValue !== undefined` —
 *     while a Tier 2 measurement is still in flight the caller must not even
 *     reach this function with a stale/absent read, see `FillSection.tsx`'s
 *     own `computedValuesLoading` guard); and either
 *       - something DOES declare it, just not here (`provenance.sources.length
 *         > 0` — declared at base while a breakpoint/condition override is
 *         active, or on another class in the chain); or
 *       - nothing declares it anywhere, but the computed value is either
 *         INHERITED (an ancestor's declaration — `provenance.inherited`) or,
 *         for a non-inherited property, genuinely different from that
 *         property's true CSS initial value (`cssInitialValues.ts` — an
 *         ordinary element with nothing painted computes to its initial and
 *         must not flood the panel).
 */
export function rendersUnstoredValue(
  provenance: PropertyProvenance | undefined,
  storedAtActiveContext: boolean,
): boolean {
  if (storedAtActiveContext) return false
  if (!provenance) return false
  if (provenance.computedValue === undefined) return false
  if (provenance.sources.length > 0) return true
  if (provenance.inherited) return true
  return !isTrueCssInitialValue(provenance.property, provenance.computedValue)
}
