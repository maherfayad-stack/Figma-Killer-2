/**
 * `deleteNodes` — deleting a MULTI-SELECTION, which is a materially different
 * job from `deleteNode` and is why it lives in its own module rather than
 * inline in `nodeActions.ts`:
 *
 *  - the selection can span several board frames, i.e. several pages and
 *    several trees (WS-7.3), so ids are grouped per page and each page's
 *    subset is ordered against its OWN tree;
 *  - order matters — leaves first, so a descendant of an already-deleted id is
 *    simply absent rather than a special case;
 *  - the depth sort must run against the FROZEN trees, before the Mutative
 *    recipe opens, or every ancestor walk materializes draft proxies;
 *  - the selection prune afterwards has to look across pages, which
 *    `pruneCanvasSelectionDraft` (active tree only) does not.
 *
 * `struct-01` — and, before any of that, the whole gesture is refused unless
 * every element in the selection can actually be removed from the user's
 * source. All-or-nothing: applying the writable half of a selection leaves the
 * canvas showing a tree the files do not describe.
 */
import { deleteNode, type NodeTree, type PageNode } from '@core/page-tree'
import { commitStudioDelete } from '@site/studio/studioSaveRequests'
import { depthInTree, resolveActiveTreeTarget } from './helpers'
import { groupNodeIdsByPage } from './nodeTreeGrouping'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { STRUCTURAL_REFUSAL_TITLE, planSourceDelete, toastStructuralRefusal } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

/** Leaves first: sort by depth DESC against a frozen tree. */
function orderLeavesFirst(tree: NodeTree<PageNode>, ids: readonly string[]): string[] {
  const depthById = new Map(ids.map((id) => [id, depthInTree(tree, id)] as const))
  return [...ids].sort((a, b) => depthById.get(b)! - depthById.get(a)!)
}

/** Delete every id that is still present and is not the tree root. Returns whether anything went. */
function deleteOrdered(tree: NodeTree<PageNode>, ordered: readonly string[]): boolean {
  let changed = false
  for (const id of ordered) {
    if (id === tree.rootNodeId) continue
    if (!tree.nodes[id]) continue
    deleteNode(tree, id)
    changed = true
  }
  return changed
}

export function createDeleteNodesAction(helpers: SiteSliceHelpers): SiteSlice['deleteNodes'] {
  const { get, set, mutateActiveTree, mutateTreesForNodeIds } = helpers

  return (nodeIds) => {
    if (nodeIds.length === 0) return
    const cur = get()
    const target = resolveActiveTreeTarget(cur)
    if (!target) return

    // Each id is looked up in its own page, not only in the active tree — a
    // board selection can span frames.
    const plan = planSourceDelete(
      nodeIds.map((id) => target.tree.nodes[id] ?? cur.site?.pages.find((page) => page.nodes[id])?.nodes[id]),
    )
    if (!plan.ok) {
      toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, plan.refusal)
      return
    }

    let deleted: boolean
    if (target.vc) {
      // VC canvas mode has no board frames to span — single tree.
      const ordered = orderLeavesFirst(target.tree, nodeIds)
      deleted = mutateActiveTree((tree) => deleteOrdered(tree, ordered))
    } else {
      const ordered: string[] = []
      for (const [pageId, ids] of groupNodeIdsByPage(cur, nodeIds)) {
        const page = cur.site?.pages.find((p) => p.id === pageId)
        ordered.push(...(page ? orderLeavesFirst(page, ids) : ids))
      }
      deleted = mutateTreesForNodeIds(ordered, (tree, idsOnThisTree) => deleteOrdered(tree, idsOnThisTree))
    }

    if (!deleted) return
    if (plan.commit) void commitStudioDelete(plan.commit)

    if (target.vc) {
      set((state) => { pruneCanvasSelectionDraft(state) })
      return
    }
    // Cross-page prune (WS-7.3) — `pruneCanvasSelectionDraft` only checks the
    // ACTIVE tree, which misses a delete on a page that wasn't active.
    set((state) => {
      const stillExists = (id: string) => Boolean(state.site?.pages.some((p) => p.nodes[id]))
      const surviving = state.selectedNodeIds.filter(stillExists)
      if (surviving.length === state.selectedNodeIds.length) return
      state.selectedNodeIds = surviving
      state.selectedNodeId = surviving.length > 0 ? surviving[surviving.length - 1]! : null
    })
  }
}
