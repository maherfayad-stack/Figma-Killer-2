/**
 * collapsedStyleBag — builds the ONE `storedStyles` / `currentStyles` pair
 * `StyleSectionsEditor` renders from, for a single node's ENTIRE style
 * picture (every assigned class plus inline), instead of the two
 * independent bags `StyleSurface` used to hand it (one call for the
 * "Element" block, one for the "Class" block).
 *
 * `STATE.md` (`panel-21`): "the CHROME around sections (search bar,
 * `StyleCategoryRail`, the module-settings accordion wrapper, the
 * Element/Class write-target MODE) is deleted in P1; the SECTION CONTENT
 * (`StyleSectionsEditor` and everything under it) is kept, called once from
 * one collapsed style bag instead of two independent Element/Class renders."
 *
 * ## Why `storedStyles` is provenance-driven, not a naive merge
 *
 * A naive `{...classA.styles, ...classB.styles, ...inline}` merge would
 * silently pick "whichever class the code iterated last" for an AMBIGUOUS
 * multi-class property — exactly the guess `stylePropertyProvenance.ts`
 * refuses to make elsewhere in this panel. So every CURATED property is
 * instead set from that property's provenance WINNER only, computed against
 * the ACTIVE EDITING CONTEXT'S bag on each class (its override bag, or its
 * base bag when no context is active — never merged with base, matching
 * `StyleRuleComposer`'s old single-class `storedStyles`, which is why Law
 * 1's disclosure and a row's bold/muted split stay correct at a breakpoint
 * tab: a value set only at BASE reads as unset-here, with the real value
 * still shown muted through `currentStyles`). An ambiguous or absent winner
 * reads as unset in `storedStyles`, even though something upstream may
 * technically declare it — editing it would require deciding which
 * declaration to touch, and this bag does not guess.
 *
 * Custom (non-curated) properties have no provenance entry — those keys
 * fall back to a naive merge (class chain in assignment order, then
 * inline), the best available answer for the long tail
 * `CustomPropertiesSection` renders.
 */
import { styleRuleSelector, type CSSPropertyBag, type StyleRule } from '@core/page-tree'
import { resolvePropertyProvenance, type ClassChainEntry, type PropertyProvenance } from '../panels/PropertiesPanel/stylePropertyProvenance'

/**
 * Per-class bag at the ACTIVE editing context ONLY (no merge-with-base) —
 * the same notion `StyleRuleComposer` used for a single class's
 * `storedStyles`, generalized to every assigned class.
 */
export function buildContextOnlyClassChain(
  classRules: ReadonlyArray<StyleRule>,
  activeContextId: string | null,
): ClassChainEntry[] {
  return classRules.map((rule) => ({
    classId: rule.id,
    selector: styleRuleSelector(rule),
    styles: activeContextId ? (rule.contextStyles[activeContextId] ?? {}) : rule.styles,
  }))
}

function naiveMergeStyles(
  classChain: ReadonlyArray<ClassChainEntry>,
  inlineStyles: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const entry of classChain) Object.assign(merged, entry.styles)
  Object.assign(merged, inlineStyles)
  return merged
}

export function buildCollapsedStoredStyles(
  properties: ReadonlyArray<string>,
  contextOnlyClassChain: ReadonlyArray<ClassChainEntry>,
  inlineStyles: Record<string, unknown>,
): { storedStyles: Record<string, unknown>; storedProvenanceByProperty: Map<string, PropertyProvenance> } {
  const merged = naiveMergeStyles(contextOnlyClassChain, inlineStyles)
  const storedProvenanceByProperty = new Map<string, PropertyProvenance>()
  for (const prop of properties) {
    const provenance = resolvePropertyProvenance(prop as keyof CSSPropertyBag, {
      classChain: contextOnlyClassChain,
      inlineStyles,
      computedValue: undefined,
    })
    storedProvenanceByProperty.set(prop, provenance)
    const winner = provenance.sources.find((source) => source.winner)
    if (winner) {
      merged[prop] = winner.value
    } else {
      delete merged[prop]
    }
  }
  return { storedStyles: merged, storedProvenanceByProperty }
}

/** `currentStyles` — the placeholder/effective layer: computed truth, then the effective (base+override) class chain, then the active context's own stored values on top. */
export function buildCollapsedCurrentStyles(
  computedValues: Record<string, string> | null | undefined,
  effectiveClassChain: ReadonlyArray<ClassChainEntry>,
  inlineStyles: Record<string, unknown>,
  storedStyles: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(computedValues ?? {}),
    ...naiveMergeStyles(effectiveClassChain, inlineStyles),
    ...storedStyles,
  }
}
