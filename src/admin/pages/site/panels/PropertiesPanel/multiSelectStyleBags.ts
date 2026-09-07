/**
 * multiSelectStyleBags — collapse N selected nodes into the TWO style bags
 * `StyleSectionsEditor` already knows how to render (W8-3 phase 1).
 *
 * Figma's inspector, with several layers selected, shows the shared sections
 * with a **Mixed** value wherever the selection disagrees, and writes the next
 * edit to every selected layer. Studio's inspector core is already
 * target-agnostic — it renders whatever `storedStyles` / `currentStyles` pair
 * it is handed — so multi-select needs no second copy of the section tree,
 * only an honest pair of bags built from N nodes instead of one.
 *
 * Two bags, two different questions:
 *
 *   - **`storedStyles`** — "what does the EDITING TARGET hold?" For phase 1
 *     the target is always the nodes' own inline `style=""` bags (see
 *     `MultiInlineStyleComposer`'s doc for why class targets are out of
 *     scope here). A property lands in this bag when at least one selected
 *     node sets it inline; its value is the shared value when every node
 *     agrees and `MIXED` otherwise. `hasStyleValue(MIXED)` is true, so a
 *     mixed property correctly counts as SET for section disclosure (Law 1,
 *     docs/features/inspector-disclosure.md §4 G1) and for the "N set" meta.
 *
 *   - **`currentStyles`** — "what is each node EFFECTIVELY showing?", the
 *     placeholder / unset-row layer. Per node this is the winning
 *     declaration across its class chain plus its inline bag, resolved by
 *     the same `resolvePropertyProvenance` the single-node surface uses —
 *     never a second cascade implementation. Collapsed the same way.
 *
 * ## Why no `getComputedStyle` here
 *
 * The single-node surface folds in a real frame reading
 * (`useFrameComputedStyleValues`) as the base layer beneath the declared
 * sources. That hook reads ONE node's mounted DOM element; there is no
 * N-node form of it, and adding one would mean N DOM reads on every
 * keystroke of a bulk edit. Provenance therefore runs with
 * `computedValue: undefined` here, which is exactly the pre-F1 degradation
 * path it already supports: declared sources still resolve (inline beats a
 * class; a lone class wins), and a property declared by SEVERAL classes at
 * once resolves `ambiguous` with no winner rather than guessing — the same
 * refusal the single-node surface makes when it cannot attribute honestly.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { collapseValues } from '@ui/components/MixedValue'
import { hasStyleValue } from './styleValueUtils'
import { resolvePropertyProvenance, type ClassChainEntry } from './stylePropertyProvenance'

/** One selected node, reduced to just what the two bags need. */
export interface MultiSelectStyleNode {
  /** The node's own `style=""` bag (`{}` when it has none). */
  inlineStyles: Record<string, unknown>
  /**
   * The node's assigned classes with their effective bags at the active
   * editing context — `buildClassChain`'s output, per node.
   */
  classChain: ReadonlyArray<ClassChainEntry>
}

export interface MultiSelectStyleBags {
  /** See module doc — the inline editing target, `MIXED` where nodes disagree. */
  storedStyles: Record<string, unknown>
  /** See module doc — each node's effective value, `MIXED` where they disagree. */
  currentStyles: Record<string, unknown>
}

/**
 * Build both bags for `properties` (normally `ALL_CURATED_CSS_PROPERTIES`)
 * across `nodes`. An empty selection yields two empty bags.
 */
export function buildMultiSelectStyleBags(
  nodes: ReadonlyArray<MultiSelectStyleNode>,
  properties: ReadonlyArray<string>,
): MultiSelectStyleBags {
  const storedStyles: Record<string, unknown> = {}
  const currentStyles: Record<string, unknown> = {}
  if (nodes.length === 0) return { storedStyles, currentStyles }

  for (const property of properties) {
    // `collapseValues` treats `undefined` as a real, comparable value, which
    // is what we want: "set on one node, absent on another" IS a disagreement
    // the user must be told about, not a value to silently prefer.
    const stored = collapseValues(nodes.map((node) => readInline(node, property)))
    if (stored !== undefined) storedStyles[property] = stored

    const current = collapseValues(nodes.map((node) => effectiveValue(node, property)))
    if (current !== undefined) currentStyles[property] = current
  }

  return { storedStyles, currentStyles }
}

/** The node's own inline declaration for `property`, or `undefined` when unset. */
function readInline(
  node: MultiSelectStyleNode,
  property: string,
): string | number | undefined {
  const value = node.inlineStyles[property]
  return hasStyleValue(value) ? value : undefined
}

/**
 * The declaration actually in effect on this node for `property` — the
 * provenance winner across its class chain + inline bag. `undefined` when
 * nothing declares it, or when several classes do and none can be crowned
 * honestly (see this module's doc).
 */
function effectiveValue(
  node: MultiSelectStyleNode,
  property: string,
): string | number | undefined {
  const provenance = resolvePropertyProvenance(property as keyof CSSPropertyBag, {
    classChain: node.classChain,
    inlineStyles: node.inlineStyles,
    computedValue: undefined,
  })
  return provenance.sources.find((source) => source.winner)?.value
}
