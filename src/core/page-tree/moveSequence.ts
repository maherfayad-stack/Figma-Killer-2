/**
 * moveSequence — a structural gesture that moves SEVERAL elements, written as
 * single-element moves applied one after another (P3-D, ERR-7, WB-22).
 *
 * A source move is written one element at a time ("put this element
 * before/after that one", `moveJsxElement`). A multi-selection drag, the ⌥-drag
 * of several layers, the arrow-key step of a selection (P2-C2) and the "bring
 * the members together" half of a non-adjacent group are all several of those,
 * and in general they are NOT independent: dragging A and C to after E is "A
 * after E, then C after A". So every multi-element move is expressed here as
 * an ORDERED list of {@link SequencedMove}s, each one meant for the tree the
 * previous ones left. The store plans each step's source write against that
 * intermediate tree, and the server writes them in the same order
 * (`server/handlers/studioEditSequence.ts`).
 *
 * The functions here are pure and never touch the caller's tree: they walk a
 * copy-on-write scratch of it ({@link createScratchTree}), which copies only
 * the nodes a move changes.
 */
import { moveNode } from './mutations'
import { topLevelSelection } from './siblingSteps'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/** One element put at `index` of `parentId` — counted AFTER it is detached (`moveNode`'s convention) — in the tree the previous moves left. */
export interface SequencedMove {
  nodeId: string
  parentId: string
  index: number
}

/** A tree the walk may move nodes in without touching the caller's objects. */
export type ScratchTree = NodeTree<PageNode>

/** A shallow copy of `tree` whose node map can be rewritten; nodes are copied only when a move changes them. */
export function createScratchTree(tree: NodeTree<PageNode>): ScratchTree {
  return { ...tree, nodes: { ...tree.nodes } }
}

/** Apply one move to a scratch tree, copying the three nodes it changes first. No-op for a stale id. */
export function moveOnScratch(scratch: ScratchTree, move: SequencedMove): void {
  const node = scratch.nodes[move.nodeId]
  const destination = scratch.nodes[move.parentId]
  if (!node || !destination) return
  scratch.nodes[move.nodeId] = { ...node }
  const oldParentId = node.parentId
  if (oldParentId && scratch.nodes[oldParentId]) {
    scratch.nodes[oldParentId] = { ...scratch.nodes[oldParentId]!, children: [...scratch.nodes[oldParentId]!.children] }
  }
  scratch.nodes[move.parentId] = { ...scratch.nodes[move.parentId]!, children: [...scratch.nodes[move.parentId]!.children] }
  moveNode(scratch, move.nodeId, move.parentId, move.index)
}

/**
 * `moveNodes(tree, nodeIds, newParentId, newIndex)` — every top-level selected
 * element lands in `newParentId`, as one run in selection order, at
 * `newIndex` of the children that stay — expressed as single-element moves.
 *
 * The first element lands right after the sibling the run follows (or first);
 * each next one lands right after the one before it. That is what makes every
 * step name a neighbour the file can write against: an unselected sibling that
 * never moves, or the element the previous step just placed. Applied in order
 * they produce exactly `moveNodes`' result (asserted in the tests).
 */
export function planMoveSequence(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): SequencedMove[] {
  const parent = tree.nodes[newParentId]
  if (!parent) return []
  const moving = topLevelSelection(tree, nodeIds)
  if (moving.length === 0) return []
  const staying = parent.children.filter((id) => !moving.includes(id))
  const at = Math.max(0, Math.min(newIndex, staying.length))
  const follows = at > 0 ? staying[at - 1]! : null

  const scratch = createScratchTree(tree)
  const moves: SequencedMove[] = []
  moving.forEach((nodeId, i) => {
    const after = i === 0 ? follows : moving[i - 1]!
    const children = scratch.nodes[newParentId]!.children.filter((id) => id !== nodeId)
    const index = after === null ? 0 : children.indexOf(after) + 1
    const move = { nodeId, parentId: newParentId, index }
    moves.push(move)
    moveOnScratch(scratch, move)
  })
  return moves
}

/**
 * The moves that take `moves` back: each element returned to where it was
 * just before its own step, in REVERSE order — so each inverse step runs
 * against exactly the tree its forward step started from.
 */
export function invertMoveSequence(tree: NodeTree<PageNode>, moves: readonly SequencedMove[]): SequencedMove[] {
  const scratch = createScratchTree(tree)
  const origins: SequencedMove[] = []
  for (const move of moves) {
    const parentId = scratch.nodes[move.nodeId]?.parentId
    const index = parentId ? (scratch.nodes[parentId]?.children.indexOf(move.nodeId) ?? -1) : -1
    if (parentId && index >= 0) origins.push({ nodeId: move.nodeId, parentId, index })
    moveOnScratch(scratch, move)
  }
  return origins.reverse()
}
