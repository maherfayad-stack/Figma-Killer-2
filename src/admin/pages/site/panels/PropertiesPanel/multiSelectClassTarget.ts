/**
 * multiSelectClassTarget — may a multi-selection edit a CLASS, and what does
 * the user have to be told first (W8-3 phase 3).
 *
 * ## The blast radius is the whole point
 *
 * Phase 1 pinned bulk editing to inline styles because `style=""` belongs to
 * exactly one element: N inline writes touch exactly the N elements selected,
 * and nothing else in the project moves. A class edit is the opposite — one
 * write, an unbounded number of elements — which is genuinely what a user
 * selecting five cards and setting a radius usually WANTS, and is also how
 * you silently restyle a sixth card on another page.
 *
 * So the class target is offered, not refused, and the count is stated
 * BEFORE the first keystroke rather than discovered afterwards:
 *
 *   - the selection shares no class → there is nothing to offer;
 *   - the class is carried ONLY by the selected nodes → editing it is exactly
 *     the bulk edit the user asked for, so no gate;
 *   - the class reaches elements outside the selection → the gate, naming
 *     how many.
 *
 * ## Where the count comes from
 *
 * `_classIdToNodeCount` (`store/slices/site/nodeIndex.ts`), the same O(1)
 * index the Selectors panel and `usePropertiesPanelData` read. This module
 * never walks pages: a selector that scans every node of every page is the
 * exact regression `no-full-site-scan-in-selectors.test.ts` exists to stop.
 *
 * ## Which shared class
 *
 * The LAST one in the anchor's `classIds`, among those every selected node
 * also carries. Last is what the cascade gives the final word to for equal
 * specificity, so it is the class whose declarations the user is looking at
 * on the canvas — the same tie-break the single-node surface's active class
 * follows.
 */

/** The one shared class a bulk edit would write to. */
export interface BulkClassTarget {
  classId: string
  /** Selector text as the panel shows it (`.card`). */
  selector: string
  /** Nodes carrying this class anywhere in the site (the O(1) index's tally). */
  usageCount: number
  /** Of those, how many are NOT in the current selection. */
  outsideCount: number
}

export type BulkClassDecision =
  /** No class every selected node carries — the target stays pinned to Element. */
  | { kind: 'no-shared-class' }
  /** Only the selection carries it: editing the class IS the bulk edit. No gate. */
  | { kind: 'allowed'; target: BulkClassTarget }
  /** It reaches elements the user did not select. Ask, with the number. */
  | { kind: 'needs-confirmation'; target: BulkClassTarget; question: string }

/** One selected node, reduced to what this decision needs. */
export interface BulkClassSelectionNode {
  /** Assigned class ids, in cascade order (last wins). */
  classIds: ReadonlyArray<string>
}

/**
 * Resolve the class-target decision for a selection.
 *
 * `selectorFor` maps a class id to its selector text and to `null` for any id
 * the user must not be offered (an ambient rule, a rule that no longer
 * exists). Passing the lookup in keeps this module free of `StyleRule` and of
 * the store, which is what makes it a plain unit test.
 */
export function resolveBulkClassTarget(
  nodes: ReadonlyArray<BulkClassSelectionNode>,
  selectorFor: (classId: string) => string | null,
  usageById: ReadonlyMap<string, number>,
): BulkClassDecision {
  if (nodes.length < 2) return { kind: 'no-shared-class' }

  const anchor = nodes[nodes.length - 1]
  const shared: string[] = []
  for (const classId of anchor.classIds) {
    if (!nodes.every((node) => node.classIds.includes(classId))) continue
    if (selectorFor(classId) === null) continue
    shared.push(classId)
  }
  if (shared.length === 0) return { kind: 'no-shared-class' }

  // Last shared class wins — see this module's "Which shared class".
  const classId = shared[shared.length - 1]
  const selector = selectorFor(classId) as string
  const usageCount = usageById.get(classId) ?? 0
  // `usageCount` counts nodes site-wide; the selection is a subset of them, so
  // the difference is what lies outside. Clamped at zero rather than trusted:
  // a stale index would otherwise produce a negative "other elements" count in
  // a sentence the user is being asked to act on.
  const outsideCount = Math.max(0, usageCount - nodes.length)

  const target: BulkClassTarget = { classId, selector, usageCount, outsideCount }
  if (outsideCount === 0) return { kind: 'allowed', target }
  return { kind: 'needs-confirmation', target, question: bulkClassQuestion(target) }
}

/**
 * The sentence the gate asks. Names the selector and the exact number of
 * elements beyond the selection, because "this may affect other elements" is
 * a warning nobody can act on.
 */
export function bulkClassQuestion(target: BulkClassTarget): string {
  const { selector, outsideCount } = target
  const elements = outsideCount === 1 ? 'other element' : 'other elements'
  return `${selector} is used by ${outsideCount} ${elements} outside this selection. Editing it changes them too — continue?`
}
