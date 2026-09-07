/**
 * selectionColors — every distinct colour the selection actually uses, and
 * the exact set of declarations each one came from (W8-3 phase 3 / G6.4).
 *
 * Figma's "Selection colors" answers a question the per-property sections
 * cannot: *what colours is this composition made of?* Five selected cards
 * whose text is `#111`, whose background is `#fff`, and one of whose borders
 * is `#e5e5e5` are three colours — not `color`, `backgroundColor`,
 * `borderTopColor`, `borderRightColor`, … spread across five inspectors.
 * Recolouring is the payoff: change the swatch, and every declaration that
 * held that value changes, in one undo step.
 *
 * ## Why only the inline bags
 *
 * Each occurrence has to be REWRITABLE, one honest target per write. An
 * inline declaration belongs to exactly one element, so rewriting it moves
 * exactly that element. A colour arriving from a class belongs to the class,
 * and rewriting it there would move every element carrying that class —
 * which is a class edit, gated separately (`multiSelectClassTarget.ts`) and
 * not something a swatch should do silently. So class-sourced colours are
 * out of this list rather than in it and unwritable.
 *
 * ## Why a literal string match
 *
 * Two declarations are the same colour here when their authored text is the
 * same after case/whitespace normalisation. `#fff` and `#FFFFFF` and
 * `rgb(255,255,255)` all render white, and resolving them into one bucket
 * would mean rewriting text the user did not ask us to touch — a colour edit
 * that silently reformats a declaration is the kind of "helpful" change that
 * makes a diff unreviewable. Identical text, identical bucket; anything else
 * is its own swatch.
 */

/** Inline properties whose value is a colour. */
const COLOR_PROPERTIES = [
  'color',
  'backgroundColor',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'caretColor',
  'textDecorationColor',
  'columnRuleColor',
  'fill',
  'stroke',
] as const

/**
 * Values that name no colour of their own — they defer to something else, so
 * showing them as a swatch would invite an edit that changes meaning rather
 * than appearance.
 */
const NON_COLOR_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'currentcolor', 'none'])

/** One declaration holding a colour. */
export interface ColorOccurrence {
  nodeId: string
  property: string
}

export interface SelectionColor {
  /** The authored text, exactly as the first occurrence wrote it. */
  value: string
  /** Every declaration holding it, in selection order. */
  occurrences: ColorOccurrence[]
}

/** One selected node, reduced to what this needs. */
export interface SelectionColorNode {
  id: string
  inlineStyles?: Record<string, unknown>
}

/**
 * Distinct colours across the selection's inline declarations, ordered by
 * first appearance (selection order, then the property order above) so the
 * list is stable while the user edits it.
 */
export function collectSelectionColors(
  nodes: ReadonlyArray<SelectionColorNode>,
): SelectionColor[] {
  const byKey = new Map<string, SelectionColor>()
  for (const node of nodes) {
    const styles = node.inlineStyles
    if (!styles) continue
    for (const property of COLOR_PROPERTIES) {
      const raw = styles[property]
      if (typeof raw !== 'string') continue
      const value = raw.trim()
      if (value === '' || NON_COLOR_KEYWORDS.has(value.toLowerCase())) continue
      const key = value.toLowerCase()
      const existing = byKey.get(key)
      if (existing) existing.occurrences.push({ nodeId: node.id, property })
      else byKey.set(key, { value, occurrences: [{ nodeId: node.id, property }] })
    }
  }
  return [...byKey.values()]
}

/**
 * The per-node patches that replace one selection colour with another —
 * exactly the shape `setNodesInlineStylesPerNode` takes, so the whole
 * recolour is one history entry.
 */
export function recolorPatches(
  color: SelectionColor,
  next: string,
): Array<{ nodeId: string; patch: Record<string, string> }> {
  const byNode = new Map<string, Record<string, string>>()
  for (const occurrence of color.occurrences) {
    const patch = byNode.get(occurrence.nodeId) ?? {}
    patch[occurrence.property] = next
    byNode.set(occurrence.nodeId, patch)
  }
  return [...byNode.entries()].map(([nodeId, patch]) => ({ nodeId, patch }))
}

/** "3 uses" / "1 use" — the count beside a swatch. */
export function describeColorUsage(color: SelectionColor): string {
  const count = color.occurrences.length
  return count === 1 ? '1 use' : `${count} uses`
}
