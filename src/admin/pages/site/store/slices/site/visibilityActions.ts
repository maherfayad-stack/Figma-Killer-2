/**
 * visibilityActions — `setNodesHidden` / `setNodesLocked`, the two named
 * tree-mutation actions that write `node.hidden` / `node.locked` for one node
 * or for N.
 *
 * ## Why these replaced `toggleNodeHidden` / `toggleNodeLocked`
 *
 * The store used to expose a per-node TOGGLE, and every surface that could
 * reach a multi-selection had to fan it out itself: the Layers context menu
 * looped over the selection (N history entries, N dirty marks), the Spotlight
 * commands and the inspector's Layer section silently acted on the ANCHOR
 * only — the user hid one of five selected layers and nothing said so
 * (`STATE.md` `panel-38`'s recorded landmine).
 *
 * A toggle is also the wrong shape for a selection that DISAGREES. Toggling
 * each of N nodes independently over a mixed selection just swaps which half
 * is hidden; it never reaches "all hidden", which is the only thing the user
 * asked for. So the action takes the absolute value and every caller decides
 * the one thing it is allowed to decide: what the next state is.
 *
 * ## One undo step, no toast
 *
 * `mutateTreesForNodeIds` wraps every touched page in ONE
 * `runHistoricMutation` transaction — the same contract `deleteNodes`,
 * `wrapNodes` and `setNodesInlineStyles` already ship — so hiding a
 * cross-frame selection is a single ⌘Z. Neither action toasts: `node.hidden`
 * and `node.locked` are Studio's own view facts, never a source write, so
 * there is no refusal to report and nothing for Track Z to collapse.
 *
 * ## Not a source write
 *
 * Both fields live in the page tree, not in the user's `.tsx`. That is why
 * this module consults no `structuralSourceEdits` plan and refuses nothing: a
 * structurally locked node with a real source location still hides and locks
 * (`docs/agent-refs/studio-pipeline.md` — structure and values are different
 * facts).
 */
import { setNodeHidden, setNodeLocked } from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

type VisibilityActions = Pick<SiteSlice, 'setNodesHidden' | 'setNodesLocked'>

export function createVisibilityActions(helpers: SiteSliceHelpers): VisibilityActions {
  const { mutateTreesForNodeIds } = helpers

  const actions: VisibilityActions = {
    setNodesHidden: (nodeIds, hidden) => {
      if (nodeIds.length === 0) return
      mutateTreesForNodeIds(nodeIds, (tree, idsOnThisTree) => {
        let changedAny = false
        for (const nodeId of idsOnThisTree) {
          const node = tree.nodes[nodeId]
          // A bulk edit never aborts halfway — an id that went stale under
          // the selection is skipped individually, exactly as
          // `setNodesInlineStyles` does, so the rest of the selection still
          // moves.
          if (!node) continue
          if ((node.hidden === true) === hidden) continue
          setNodeHidden(tree, nodeId, hidden)
          changedAny = true
        }
        return changedAny
      })
    },

    setNodesLocked: (nodeIds, locked) => {
      if (nodeIds.length === 0) return
      mutateTreesForNodeIds(nodeIds, (tree, idsOnThisTree) => {
        let changedAny = false
        for (const nodeId of idsOnThisTree) {
          const node = tree.nodes[nodeId]
          if (!node) continue
          if ((node.locked === true) === locked) continue
          setNodeLocked(tree, nodeId, locked)
          changedAny = true
        }
        return changedAny
      })
    },
  }

  return actions
}
