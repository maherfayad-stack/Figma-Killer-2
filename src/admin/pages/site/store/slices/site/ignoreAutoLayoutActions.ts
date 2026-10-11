/**
 * ignoreAutoLayoutActions (PA-4) — Figma's "Ignore auto layout" as ONE store
 * action: a child of a flex / grid container leaves the flow (or returns to
 * it) with the child's own style and, when needed, the container's
 * `position: relative` written in a single undo step. What each write is, and
 * when there is no honest one, is {@link planIgnoreAutoLayout} /
 * {@link planReinstateAutoLayout}; this file only runs the plan against the
 * tree and shows a refusal as the same dialog every other refused gesture uses.
 *
 * The facts a tree cannot know (where the child sits on screen, whether the
 * container already contains it) are measured by the caller against the live
 * frame (`ignoreAutoLayoutMeasure.ts`) and arrive on the request.
 */
import { applyInlineStylePatch } from './inlineStyleActions'
import { inlinedSourceInstanceCount } from './nodeIndex'
import {
  planIgnoreAutoLayout,
  planReinstateAutoLayout,
  type IgnoreAutoLayoutRefusal,
} from './ignoreAutoLayoutPlan'
import { presentStructuralRefusal, STRUCTURAL_REFUSAL_TITLE } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

type IgnoreAutoLayoutActions = Pick<SiteSlice, 'setIgnoreAutoLayout'>

export function createIgnoreAutoLayoutActions(helpers: SiteSliceHelpers): IgnoreAutoLayoutActions {
  const { get, set, mutateTreesForNodeIds } = helpers

  return {
    setIgnoreAutoLayout: (nodeId, request) => {
      const index = get()
      const result: { refusal?: IgnoreAutoLayoutRefusal } = {}

      const changed = mutateTreesForNodeIds([nodeId], (tree) => {
        const child = tree.nodes[nodeId]
        const parentNode = child?.parentId ? tree.nodes[child.parentId] : undefined
        if (!child) return false
        const parent = parentNode
          ? { node: parentNode, sharedCount: inlinedSourceInstanceCount(index, parentNode.id) }
          : null
        // A child with no parent in this tree is a component's root: its
        // container is a call site elsewhere, so there is nothing to place
        // it against and nothing this action could write honestly.
        if (request.ignore && !parent) return false

        const plan = request.ignore
          ? planIgnoreAutoLayout({ child, parent: parent!, parentContains: request.parentContains, offsets: request.offsets })
          : planReinstateAutoLayout({ child, parent, releaseParent: request.releaseParent })
        if (!plan.ok) {
          result.refusal = plan.refusal
          return false
        }
        let any = false
        for (const write of plan.writes) {
          const node = tree.nodes[write.nodeId]
          if (node && applyInlineStylePatch(node, write.patch)) any = true
        }
        return any
      })

      if (result.refusal) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.ignoreAutoLayout, result.refusal.constraint, {
          ...(result.refusal.remedyNodeId ? { nodeId: result.refusal.remedyNodeId } : {}),
          getState: get,
          set,
        })
        return 'refused'
      }
      return changed ? 'applied' : 'noop'
    },
  }
}
