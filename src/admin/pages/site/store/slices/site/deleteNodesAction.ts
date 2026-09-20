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
import { broadcastOptimisticDelete } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import { commitStudioDelete } from '@site/studio/studioStructuralCommits'
import type { StructuralInverseTemplate } from '@site/studio/structuralUndoPlan'
import { depthInTree, resolveActiveTreeTarget } from './helpers'
import { groupNodeIdsByPage } from './nodeTreeGrouping'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { STRUCTURAL_REFUSAL_TITLE, planSourceDelete, presentStructuralRefusal } from './structuralSourceEdits'
import { captureDeleteOrigin, tagStructuralGesture, type StructuralHistoryDeleteOrigin } from './structuralHistory'
import type { SiteSlice, SiteSliceHelpers } from './types'

/**
 * `store-15` — the pre-delete `{parentId, index}` for every id `plan.commit`
 * names, or `null` when even one of them could not be captured.
 *
 * `null` rather than a partial list: an undo that restores three of four
 * deleted elements and silently drops the fourth is worse than one that says
 * it cannot restore any of them (`structuralUndoPlan.ts`'s own
 * `reinsert-deleted` case makes the identical call from the outcome side).
 *
 * Looks each id up in its OWN page — a multi-select delete can span board
 * frames (WS-7.3), so an id in `plan.commit` is not guaranteed to belong to
 * `target.tree`.
 */
function captureDeleteOrigins(
  cur: { site: { pages: readonly NodeTree<PageNode>[] } | null },
  target: { tree: NodeTree<PageNode> },
  ids: readonly string[],
): readonly StructuralHistoryDeleteOrigin[] | null {
  const origins: StructuralHistoryDeleteOrigin[] = []
  for (const id of ids) {
    const tree = target.tree.nodes[id] ? target.tree : cur.site?.pages.find((page) => page.nodes[id])
    const origin = tree ? captureDeleteOrigin(tree, id) : null
    if (!origin) return null
    origins.push(origin)
  }
  return origins
}

/**
 * `store-15` — this gesture's ⌘Z, as a template: `reinsert-deleted` when every
 * deleted node's pre-delete position was captured, `unsupported` otherwise —
 * an outcome-independent question, unlike `wrap`/`group`'s templates, because
 * a delete's parent/index are known BEFORE the write, not learned from it.
 */
function deleteInverseTemplate(
  cur: { site: { pages: readonly NodeTree<PageNode>[] } | null },
  target: { tree: NodeTree<PageNode> },
  ids: readonly string[],
): StructuralInverseTemplate {
  const origins = captureDeleteOrigins(cur, target, ids)
  if (!origins) {
    return {
      kind: 'unsupported',
      message:
        'One of these elements’ positions could not be recorded for undo — its container has no place in the file of its own (it may be the whole of what this page returns). Use your editor’s undo or `git` to bring it back.',
    }
  }
  return { kind: 'reinsert-deleted', nodes: origins.map(({ nodeId, parentId, index }) => ({ nodeId, parentNodeId: parentId, index })) }
}

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
      const refusedNodeId = plan.nodeId
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, plan.constraint, {
        nodeId: refusedNodeId,
        retry: refusedNodeId
          ? (newNodeId) => {
              get().deleteNodes(nodeIds.map((id) => (id === refusedNodeId ? newNodeId : id)))
            }
          : undefined,
        getState: get,
        set,
      })
      return
    }

    // `store-15` — captured against the tree as it is RIGHT NOW, the last
    // moment before the mutation below removes these nodes from it.
    const inverseTemplate = plan.commit ? deleteInverseTemplate(cur, target, plan.commit) : null

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
    if (plan.commit && inverseTemplate) {
      void commitStudioDelete(plan.commit)
      // `live-07` — same-tick paint for a live (bridge) frame, one call per
      // deleted id (a multi-select delete can span several source-derived
      // nodes, unlike the single-node `deleteNode` action).
      for (const id of plan.commit) broadcastOptimisticDelete(id)
      // `store-15` — folded into the `source` family: `inverse` is `null`
      // until the commit above reports what it discarded (`fill`, drained by
      // `usePersistence.ts`). Tagging the entry the tree mutation above
      // already pushed, not pushing a second one — see `structuralHistory.ts`'s
      // own doc for why this gesture keeps its eager tree mutation.
      tagStructuralGesture(set, {
        gesture: 'source',
        source: {
          label: plan.commit.length === 1 ? 'Delete' : `Delete ${plan.commit.length} elements`,
          forward: plan.commit.map((nodeId) => ({ kind: 'delete', nodeId })),
          inverseTemplate,
          inverse: null,
        },
      })
    }

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
