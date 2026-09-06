/**
 * selectionResolve — "which tree does this node id live in?", the one question
 * every selection-adjacent slice has to answer before it can do anything.
 *
 * Both helpers used to live at the bottom of `selectionSlice.ts`, which was
 * fine while the slice was their only owner. `viewport-01` added
 * `selectionTraversalActions.ts` (Enter / ⇧Enter walk the tree and need the
 * SAME board-aware resolution), and importing them back out of the slice made
 * a real `selectionSlice ↔ selectionTraversalActions` import cycle —
 * `no-circular-dependencies.test.ts` catches exactly this. They belong in a
 * leaf module both sides can depend on, which is this file.
 *
 * Deliberately NOT built on the store-level `selectActiveCanvasPage` selector:
 * importing that would trade this cycle for a `slices ↔ store` one.
 */
import type { BaseNode, NodeTree, PageNode } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { selectActiveBoard } from './boardSelectors'

/**
 * Resolve the active tree (page or VC). The returned shape is
 * `NodeTree<PageNode>` so callers can use the page-tree selectors uniformly.
 * Consumed by `selectionSlice`, `selectionTraversalActions` and
 * `inlineEditSlice`.
 */
export function getActiveTree(state: EditorStore): NodeTree<PageNode> | null {
  if (!state.site) return null
  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = state.site.visualComponents?.find((v) => v.id === activeDocument.vcId)
    return vc ? (vc.tree as NodeTree<PageNode>) : null
  }
  const page = state.site.pages.find((p) => p.id === state.activePageId)
  return page ?? null
}

/**
 * Resolve a node id to its node + owning tree, WS-7.3-aware: on a studio
 * board, a selection may span any of the board's OWN curated frames
 * (`selectActiveBoard(state).frames`), not just the single active page —
 * `_nodeIdToPageIds` (WS-5.2) finds every page that carries `id` and this
 * picks the first one that's actually a frame on the active board. Outside
 * board mode (CMS editing, VC canvas) this is exactly `getActiveTree`'s own
 * lookup — unchanged behaviour.
 */
export function resolveSelectableNode(
  state: EditorStore,
  id: string,
): { node: BaseNode; tree: NodeTree<PageNode> } | null {
  const board = selectActiveBoard(state)
  if (board) {
    const framePageIds = new Set(board.frames.map((f) => f.pageId))
    for (const pageId of state._nodeIdToPageIds.get(id) ?? []) {
      if (!framePageIds.has(pageId)) continue
      const page = state.site?.pages.find((p) => p.id === pageId)
      const node = page?.nodes[id]
      if (page && node) return { node, tree: page }
    }
    return null
  }
  const tree = getActiveTree(state)
  const node = tree?.nodes[id]
  return tree && node ? { node, tree } : null
}
