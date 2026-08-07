/**
 * stylePropertyProvenance — Track F1's per-CSS-property "who actually wins".
 *
 * The bug this fixes: `StyleSectionsEditor` used to read ONE style bag (the
 * active class, or the inline bag) and fall back to a hand-written spec-
 * default table (`getCSSPropertyDefaultValue`) when nothing was set. A node
 * with two classes, or a class AND an inline override, could show a value in
 * the panel that had nothing to do with what was actually rendering — "a
 * field can confidently read `transparent` on an element rendering red."
 *
 * This module builds, per curated CSS property, the full list of places that
 * explicitly declare it (every class assigned to the node, in order, plus the
 * inline `style=""` bag) and marks which one is the WINNER — the declaration
 * actually in effect. The ground truth for "what's actually rendering" is the
 * frame's real `getComputedStyle` (`useFrameComputedStyleValues`); this module
 * never resolves the CSS cascade itself except to attribute the winning value
 * to a specific source.
 *
 * ## Why winner attribution is sometimes `'ambiguous'`, not guessed
 *
 * An inline declaration always outranks every class declaration by CSS
 * specificity (barring a class rule using `!important`, a known limitation —
 * see below), so `winner` among a mix of inline + class sources is always
 * exact. Among MULTIPLE class sources for the same property, the actual
 * winner depends on the generated stylesheet's rule order — which is decided
 * by class REGISTRY order (`site.styleRules` insertion), not by the node's
 * own `classIds` assignment order, and this module has no access to (nor
 * ownership of) `ClassStyleInjector`'s CSS generation. Rather than guess a
 * plausible-looking answer, the winner is attributed only when it can be
 * attributed HONESTLY:
 *   - exactly one class source's value textually matches the computed value
 *     (after light normalization), or
 *   - there is only one class source in the first place.
 * Otherwise `confidence` is `'ambiguous'` and no source is crowned winner —
 * the row still shows the real computed value (ground truth), it just
 * doesn't claim to know which of several declarations produced it. This is
 * the same "refuse rather than guess" discipline the codemods use for writes,
 * applied to a READ.
 *
 * ## `!important` — known limitation
 *
 * A class declaration marked `!important` can outrank an inline style. This
 * module does not parse `!important` out of a stored value (Studio's own
 * class editor never writes it), so a `!important` declaration authored by
 * hand-edited/imported CSS could show as a struck-through loser here while
 * actually winning on the canvas. Rare in practice; flagged for whoever next
 * threads real specificity data through.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { styleRuleSelector } from '@core/page-tree'
import { hasStyleValue } from './styleValueUtils'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PropertySourceKind = 'inline' | 'class'

export interface PropertySource {
  kind: PropertySourceKind
  /** `StyleRule.id` — present only for `kind: 'class'`. */
  classId?: string
  /** Human-readable origin: `'Element'` for inline, the class selector (e.g. `.card`) otherwise. */
  label: string
  value: string | number
  /** True for at most one source per property — see module doc for how this is decided. */
  winner: boolean
}

export type WinnerConfidence = 'inline' | 'exact-match' | 'ambiguous' | 'none'

export interface PropertyProvenance {
  property: keyof CSSPropertyBag
  /** Every place that explicitly declares this property. Empty when nothing does. */
  sources: PropertySource[]
  /** How `winner` was decided — see module doc. */
  confidence: WinnerConfidence
  /** Ground truth from `getComputedStyle` on the real rendered element. `undefined` only when the frame hasn't rendered (no canvas mounted, e.g. tests). */
  computedValue: string | undefined
  /**
   * True when nothing explicitly declares this property, the property is one
   * CSS inherits by default, and a computed value is available. Best-effort —
   * not a verified ancestor trace, just "this is the kind of property that
   * plausibly came from an ancestor rather than the UA stylesheet".
   */
  inherited: boolean
}

/** One class assigned to the node, with its EFFECTIVE style bag at the active editing context (base merged with the context override, if any — matching what that class alone would apply). */
export interface ClassChainEntry {
  classId: string
  selector: string
  styles: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// buildClassChain
// ---------------------------------------------------------------------------

/**
 * Turn a node's already-resolved assigned classes (`usePropertiesPanelData`'s
 * `assignedClassRules` — `classIds` mapped through `site.styleRules`, stale
 * ids already filtered out) into per-class entries carrying each one's
 * EFFECTIVE style bag at the given context. `activeContextId` is a
 * breakpoint or condition id, or `null` for the base/desktop context — same
 * convention `StyleSurface` already uses for `activeConditionId`/
 * `getActiveStyleTab`.
 */
export function buildClassChain(
  classRules: ReadonlyArray<StyleRule>,
  activeContextId: string | null,
): ClassChainEntry[] {
  return classRules.map((rule) => {
    const override = activeContextId ? rule.contextStyles[activeContextId] : undefined
    const styles = override ? { ...rule.styles, ...override } : rule.styles
    return { classId: rule.id, selector: styleRuleSelector(rule), styles }
  })
}

// ---------------------------------------------------------------------------
// resolvePropertyProvenance
// ---------------------------------------------------------------------------

function normalizeForComparison(value: string | number | undefined): string {
  if (value === undefined || value === null) return ''
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * CSS properties that inherit from an ancestor by default (a small, standard
 * subset of `CSSPropertyBag`'s keys). Used only to label the `inherited`
 * flag — see this module's own doc.
 */
const INHERITED_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'cursor',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textTransform',
  'textShadow',
  'whiteSpace',
  'visibility',
])

export interface ResolvePropertyProvenanceParams {
  classChain: ReadonlyArray<ClassChainEntry>
  inlineStyles: Record<string, unknown>
  computedValue: string | undefined
}

export function resolvePropertyProvenance(
  property: keyof CSSPropertyBag,
  params: ResolvePropertyProvenanceParams,
): PropertyProvenance {
  const { classChain, inlineStyles, computedValue } = params
  const propKey = String(property)

  const classSources: PropertySource[] = classChain
    .filter((entry) => hasStyleValue(entry.styles[propKey]))
    .map((entry) => ({
      kind: 'class' as const,
      classId: entry.classId,
      label: entry.selector,
      value: entry.styles[propKey] as string | number,
      winner: false,
    }))

  const inlineValue = inlineStyles[propKey]
  const inlineSource: PropertySource | null = hasStyleValue(inlineValue)
    ? { kind: 'inline', label: 'Element', value: inlineValue as string | number, winner: false }
    : null

  const sources = inlineSource ? [...classSources, inlineSource] : classSources

  let confidence: WinnerConfidence = 'none'
  if (inlineSource) {
    inlineSource.winner = true
    confidence = 'inline'
  } else if (classSources.length === 1) {
    classSources[0].winner = true
    confidence = 'exact-match'
  } else if (classSources.length > 1) {
    const normalizedComputed = normalizeForComparison(computedValue)
    const matches = normalizedComputed
      ? classSources.filter((s) => normalizeForComparison(s.value) === normalizedComputed)
      : []
    if (matches.length === 1) {
      matches[0].winner = true
      confidence = 'exact-match'
    } else {
      confidence = 'ambiguous'
    }
  }

  const inherited =
    sources.length === 0 && computedValue !== undefined && INHERITED_PROPERTIES.has(propKey)

  return { property, sources, confidence, computedValue, inherited }
}

/** Empty, stable provenance for a property with no sources and no frame reading available. Reused so callers building a full map don't allocate one per miss. */
export const EMPTY_PROPERTY_PROVENANCE_PARAMS: ResolvePropertyProvenanceParams = Object.freeze({
  classChain: Object.freeze([]),
  inlineStyles: Object.freeze({}),
  computedValue: undefined,
})
