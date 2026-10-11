/**
 * ignoreAutoLayoutPlan (PA-4) — the pure half of Figma's "Ignore auto layout":
 * which inline-style writes, on which nodes, turn an in-flow child of a flex or
 * grid container into an absolutely placed one that stays where it is, and
 * back — or why there is no honest write.
 *
 * ## On
 *
 * The child gets `position: absolute` and the `left` / `top` it already
 * occupies (measured by the caller against the box that will contain it —
 * `containingBlockOffsets`, never `offsetLeft`). An absolute box is placed by
 * its nearest positioned ancestor, so when the container is not that block it
 * also gets `position: relative`, in the SAME undo step (OD-P2). That second
 * write is one the user did not directly ask for, so it happens only when it
 * stays on ONE element: a container whose style site is shared (a component
 * used in N places, a `.map` row) refuses and offers the same write as an
 * explicit choice naming how many places it reaches.
 *
 * ## Off
 *
 * Position and every inset go; the element keeps its place in the child order,
 * so "back into flow at its source index" is just the absence of the
 * declaration. If it was this gesture that made the container `relative`, that
 * goes too — recognised, because the container is `relative` in its own inline
 * style and nothing else inside it needs it (`releaseParent`, measured).
 * Turning it on and off again therefore restores the file byte for byte.
 */
import {
  explainSharedParentConstraint,
  explainStyleConstraint,
  isListRowNodeId,
  isStylePatchWritableToSource,
  type EditConstraint,
  type PageNode,
} from '@core/page-tree'
import { isOutOfFlow } from '@core/studio-runtime'
import { nodeHtmlTag } from './nodeHtmlTag'

type StylePatch = Record<string, string | null>

/** The insets a free-placed layer can carry; clearing all of them is how it returns to flow. */
const INSET_PROPERTIES = ['left', 'top', 'right', 'bottom', 'insetInlineStart'] as const

export interface IgnoreAutoLayoutWrite {
  nodeId: string
  patch: StylePatch
}

export interface IgnoreAutoLayoutRefusal {
  constraint: EditConstraint
  /** The node the constraint's remedy acts on (the container), when it has one. */
  remedyNodeId?: string
}

export type IgnoreAutoLayoutPlan =
  | { ok: true; writes: IgnoreAutoLayoutWrite[] }
  | { ok: false; refusal: IgnoreAutoLayoutRefusal }

/** What the container's style site looks like — whether one `position` write stays on one element. */
export interface ParentSiteFacts {
  node: PageNode
  /** Board nodes that resolve to the same source element (1 = its own). */
  sharedCount: number
}

function parentLabel(parent: PageNode): string {
  return nodeHtmlTag(parent) ?? 'container'
}

function refuse(constraint: EditConstraint, remedyNodeId?: string): IgnoreAutoLayoutPlan {
  return { ok: false, refusal: { constraint, ...(remedyNodeId ? { remedyNodeId } : {}) } }
}

function unwritable(node: PageNode, property: string): IgnoreAutoLayoutPlan {
  return refuse(
    explainStyleConstraint(node, property) ?? {
      reason: 'resolved-style-expression',
      scope: 'style-property',
      explanation: `\`${property}\` is set in code here, so Studio cannot write it.`,
      actions: [],
    },
  )
}

/** The container's style site is one element's, or a refusal that names how many it would reach. */
function sharedRefusal(parent: ParentSiteFacts): IgnoreAutoLayoutPlan | null {
  const label = parentLabel(parent.node)
  if (isListRowNodeId(parent.node.id)) {
    return refuse(explainSharedParentConstraint(label, { kind: 'list-row' }), parent.node.id)
  }
  if (parent.sharedCount > 1) {
    return refuse(explainSharedParentConstraint(label, { kind: 'component', count: parent.sharedCount }), parent.node.id)
  }
  return null
}

export interface IgnoreAutoLayoutOnInput {
  child: PageNode
  parent: ParentSiteFacts
  /** The container already establishes the containing block (positioned, or transformed). */
  parentContains: boolean
  /** Where the child sits now, in CSS px from the container's padding box — measured against the container. */
  offsets: { left: number; top: number }
}

export function planIgnoreAutoLayout(input: IgnoreAutoLayoutOnInput): IgnoreAutoLayoutPlan {
  const { child, parent, parentContains, offsets } = input
  const childPatch: StylePatch = {
    position: 'absolute',
    left: `${offsets.left}px`,
    top: `${offsets.top}px`,
    right: null,
    bottom: null,
    insetInlineStart: null,
  }
  if (!isStylePatchWritableToSource(child, childPatch)) return unwritable(child, 'position')

  const writes: IgnoreAutoLayoutWrite[] = [{ nodeId: child.id, patch: childPatch }]
  if (!parentContains) {
    const parentPatch: StylePatch = { position: 'relative' }
    const shared = sharedRefusal(parent)
    if (shared) return shared
    if (!isStylePatchWritableToSource(parent.node, parentPatch)) return unwritable(parent.node, 'position')
    writes.push({ nodeId: parent.node.id, patch: parentPatch })
  }
  return { ok: true, writes }
}

export interface IgnoreAutoLayoutOffInput {
  child: PageNode
  /** `null` when the child's parent is outside this tree — then there is nothing to release. */
  parent: ParentSiteFacts | null
  /**
   * Nothing else in the container needs it positioned: no other absolute
   * descendant, no `z-index` that relies on it. Measured by the caller.
   */
  releaseParent: boolean
}

export function planReinstateAutoLayout(input: IgnoreAutoLayoutOffInput): IgnoreAutoLayoutPlan {
  const { child, parent, releaseParent } = input
  // Only a position this element carries inline can be returned to flow here;
  // one that a class sets would survive the write and the toggle would lie.
  if (!isOutOfFlow(String(child.inlineStyles?.position ?? ''))) {
    return refuse({
      reason: 'resolved-style-expression',
      scope: 'style-property',
      explanation: "This element's position comes from a class, not from its own style, so clearing it here would change nothing. Remove it from the class instead.",
      actions: [],
    })
  }
  const childPatch: StylePatch = { position: null }
  for (const property of INSET_PROPERTIES) childPatch[property] = null
  if (!isStylePatchWritableToSource(child, childPatch)) return unwritable(child, 'position')

  const writes: IgnoreAutoLayoutWrite[] = [{ nodeId: child.id, patch: childPatch }]
  // The container's `relative` is released only when it is plainly this
  // gesture's own leftover: inline, nothing inside needs it, and one element's
  // to write. Anything else stays — an unneeded `relative` is harmless, a
  // removed needed one moves things.
  if (
    parent &&
    releaseParent &&
    parent.node.inlineStyles?.position === 'relative' &&
    sharedRefusal(parent) === null &&
    isStylePatchWritableToSource(parent.node, { position: null })
  ) {
    writes.push({ nodeId: parent.node.id, patch: { position: null } })
  }
  return { ok: true, writes }
}
