/**
 * layoutConversionPlan (PA-7 / PA-8) — the pure gate in front of "Add auto
 * layout" and "Remove auto layout (keep positions)". Both rewrite a container
 * AND every one of its children in one gesture, so the gesture is all or
 * nothing: if any element it would write is a `.map` row, markup shared by
 * other call sites, or a style set in code, NOTHING is written and the refusal
 * names that element.
 *
 * What to write (the inferred flex values, the frozen offsets) is decided by
 * the caller from measurements; this file only decides whether it may.
 */
import {
  explainSharedParentConstraint,
  explainStyleConstraint,
  isListRowNodeId,
  isStylePatchWritableToSource,
  type EditConstraint,
  type PageNode,
} from '@core/page-tree'
import { nodeHtmlTag } from './nodeHtmlTag'

export type LayoutStylePatch = Record<string, string | null>

export interface LayoutConversionRequest {
  parentId: string
  parentPatch: LayoutStylePatch
  childPatches: ReadonlyArray<{ nodeId: string; patch: LayoutStylePatch }>
  /** The children's ids in the order they should end up, when it differs from the source order. */
  order?: readonly string[]
}

export interface LayoutConversionWrite {
  nodeId: string
  patch: LayoutStylePatch
}

export interface LayoutConversionRefusal {
  constraint: EditConstraint
  /** The element the remedy acts on. */
  remedyNodeId: string
}

export type LayoutConversionPlan =
  | { ok: true }
  | { ok: false; refusal: LayoutConversionRefusal }

export interface LayoutConversionFacts {
  /** Writes in the order they apply: the container first, then its children. */
  writes: ReadonlyArray<{ node: PageNode; patch: LayoutStylePatch }>
  /** Board nodes resolving to the same source element as `nodeId` (1 = its own). */
  sharedCount: (nodeId: string) => number
}

export function planLayoutConversion(facts: LayoutConversionFacts): LayoutConversionPlan {
  for (const { node, patch } of facts.writes) {
    const label = nodeHtmlTag(node) ?? 'element'
    if (isListRowNodeId(node.id)) {
      return { ok: false, refusal: { constraint: explainSharedParentConstraint(label, { kind: 'list-row' }), remedyNodeId: node.id } }
    }
    const count = facts.sharedCount(node.id)
    if (count > 1) {
      return { ok: false, refusal: { constraint: explainSharedParentConstraint(label, { kind: 'component', count }), remedyNodeId: node.id } }
    }
    if (!isStylePatchWritableToSource(node, patch)) {
      const property = Object.keys(patch)[0] ?? 'style'
      const constraint = explainStyleConstraint(node, property) ?? {
        reason: 'resolved-style-expression',
        scope: 'style-property',
        explanation: `\`${property}\` is set in code here, so Studio cannot write it. Edit it in the code.`,
        actions: [],
      }
      return { ok: false, refusal: { constraint, remedyNodeId: node.id } }
    }
  }
  return { ok: true }
}
