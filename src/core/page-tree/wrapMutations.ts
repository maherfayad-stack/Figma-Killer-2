/**
 * wrapMutations — the tree primitives that change NESTING without changing
 * what any node is: wrap one node in a new container, wrap a selection in one
 * container, and dissolve a container back into its parent.
 *
 * Split out of `mutations.ts` (K3) when `unwrapNode` arrived. That module is a
 * library of per-node primitives — insert, delete, move, rename, clone — and
 * every one of them touches ONE node plus its parent's child list. The three
 * here are about a WRAPPER: a node that exists only to hold others, computed
 * from a set of ids (`findClosestCommonAncestor`) rather than named by the
 * caller. Two different reasons to change, so two modules; the barrel
 * (`@core/page-tree`) re-exports both, and nothing outside this folder
 * notices which file a mutation lives in.
 *
 * Tree-agnostic like every other mutation here: these take a
 * `NodeTree<PageNode>` draft and know nothing about pages vs. Visual
 * Components. The one place that knows is `mutateActiveTree`
 * (`site/helpers.ts`) — see CLAUDE.md's "Mutation API".
 *
 * They are also PURELY CANVAS-SIDE. On a studio-imported tree, grouping and
 * ungrouping are SOURCE writes (`wrapJsxElements` / `unwrapJsxElement`) and
 * the store never calls these at all — `sourceStructureGroup.ts` decides
 * which of the two paths a gesture takes.
 */
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import { getParent } from './selectors'
import { createNode } from './mutations'

// ---------------------------------------------------------------------------
// Wrap / unwrap
// ---------------------------------------------------------------------------

/**
 * Wrap a node (and its position in the parent) inside a new container module.
 * The new container takes the node's position; the node becomes the container's first child.
 */
export function wrapNode(
  tree: NodeTree<PageNode>,
  nodeId: string,
  containerModuleId: string,
  containerDefaults: Record<string, unknown> = {}
): string {
  if (nodeId === tree.rootNodeId) {
    throw new Error(`[PageTree] Cannot wrap the root node.`)
  }
  const parent = getParent(tree, nodeId)
  if (!parent) throw new Error(`[PageTree] Node "${nodeId}" has no parent and cannot be wrapped.`)

  const wrapper = createNode(containerModuleId, containerDefaults)
  const idx = parent.children.indexOf(nodeId)

  // Insert wrapper at the node's position
  tree.nodes[wrapper.id] = wrapper
  parent.children[idx] = wrapper.id
  wrapper.parentId = parent.id

  // Make the original node the wrapper's first child
  wrapper.children.push(nodeId)
  const wrapped = tree.nodes[nodeId]
  if (wrapped) wrapped.parentId = wrapper.id

  return wrapper.id
}

/**
 * Wrap a multi-selection of nodes inside a single new container.
 *
 * Algorithm — "closest common ancestor" semantics (matches Figma):
 *   1. Reduce `nodeIds` to its TOP-LEVEL set (drop nodes whose ancestor is also
 *      in the set — they'd be moved with their ancestor anyway).
 *   2. Find the closest common ancestor of every top-level id.
 *   3. For each top-level id, walk up to its child-of-CCA — that's the
 *      "branch" the id contributes to the CCA. The branches are the new
 *      wrapper's children (deduped, in CCA-children order).
 *   4. Insert the wrapper at the index of the FIRST branch within the CCA's
 *      children, then move all branches into the wrapper preserving order.
 *
 * The wrapper takes the position of the first contributing branch; subsequent
 * branches are spliced out of the CCA and into the wrapper. This handles all
 * three cases uniformly:
 *   - same parent contiguous → behaves like sequential `wrapNode` calls
 *   - same parent non-contiguous → wraps every selected sibling, preserving order
 *   - different parents → wraps the CCA-level branches that CONTAIN the selection
 *
 * Returns the new wrapper's id.
 *
 * Throws if any id is the root, missing, or if the selection set is empty.
 */
export function wrapNodes(
  tree: NodeTree<PageNode>,
  nodeIds: string[],
  containerModuleId: string,
  containerDefaults: Record<string, unknown> = {},
): string {
  if (nodeIds.length === 0) {
    throw new Error(`[PageTree] wrapNodes requires at least one node id.`)
  }
  if (nodeIds.length === 1) {
    return wrapNode(tree, nodeIds[0], containerModuleId, containerDefaults)
  }

  // Validate ids exist and are not root.
  for (const id of nodeIds) {
    if (id === tree.rootNodeId) {
      throw new Error(`[PageTree] Cannot wrap the root node.`)
    }
    if (!tree.nodes[id]) {
      throw new Error(`[PageTree] Node "${id}" not found in tree.`)
    }
  }

  // ── Step 1: Reduce to top-level ids ────────────────────────────────────────
  // A node is "top level" within the selection if none of its ancestors are
  // also in the selection. Otherwise, wrapping it would move it twice.
  const idSet = new Set(nodeIds)
  const topLevel: string[] = []
  for (const id of nodeIds) {
    let ancestor = getParent(tree, id)
    let dominated = false
    while (ancestor) {
      if (idSet.has(ancestor.id)) {
        dominated = true
        break
      }
      ancestor = getParent(tree, ancestor.id)
    }
    if (!dominated) topLevel.push(id)
  }

  // ── Step 2: Closest common ancestor ────────────────────────────────────────
  const cca = findClosestCommonAncestor(tree, topLevel)
  if (!cca) {
    throw new Error(`[PageTree] No common ancestor for selection — cannot wrap.`)
  }

  // ── Step 3: Compute branches (each id's child-of-CCA ancestor) ─────────────
  // Order them by their position in cca.children so the wrapper preserves the
  // visual order of the original tree.
  const branchSet = new Set<string>()
  for (const id of topLevel) {
    const branch = ancestorChildOf(tree, id, cca.id)
    if (!branch) {
      throw new Error(
        `[PageTree] Could not resolve branch for "${id}" under "${cca.id}".`,
      )
    }
    branchSet.add(branch)
  }

  const branchesInOrder = cca.children.filter((childId) => branchSet.has(childId))
  if (branchesInOrder.length === 0) {
    throw new Error(`[PageTree] Computed empty branch set — cannot wrap.`)
  }

  // ── Step 4: Insert wrapper at first-branch index, move branches in ─────────
  const wrapper = createNode(containerModuleId, containerDefaults)
  tree.nodes[wrapper.id] = wrapper

  const firstBranchIdx = cca.children.indexOf(branchesInOrder[0])
  // Remove every branch from cca.children, then splice the wrapper in at the
  // first-branch slot. Wrapper's children become the removed branches in order.
  cca.children = cca.children.filter((childId) => !branchSet.has(childId))
  cca.children.splice(firstBranchIdx, 0, wrapper.id)
  wrapper.children = branchesInOrder
  wrapper.parentId = cca.id

  // The branches are now children of the wrapper.
  for (const branchId of branchesInOrder) {
    const branch = tree.nodes[branchId]
    if (branch) branch.parentId = wrapper.id
  }

  return wrapper.id
}

/**
 * Dissolve a container: its children take its place, in order, at its own
 * index in its own parent. The container node itself is removed from the tree.
 *
 * The inverse of {@link wrapNode}, and the canvas half of ⌘⇧G (K3). Returns
 * whether anything changed — `false` when the id is unknown, is the root, or
 * has no parent to hoist into, which are the three shapes where "ungroup" has
 * no meaning rather than an error to throw at a keystroke.
 *
 * A container with NO children is simply removed: an empty group ungroups to
 * nothing, which is the same answer the source write gives.
 */
export function unwrapNode(tree: NodeTree<PageNode>, nodeId: string): boolean {
  if (nodeId === tree.rootNodeId) return false
  const wrapper = tree.nodes[nodeId]
  if (!wrapper) return false
  const parent = getParent(tree, nodeId)
  if (!parent) return false

  const index = parent.children.indexOf(nodeId)
  if (index === -1) return false

  const hoisted = [...wrapper.children]
  parent.children.splice(index, 1, ...hoisted)
  for (const childId of hoisted) {
    const child = tree.nodes[childId]
    if (child) child.parentId = parent.id
  }
  delete tree.nodes[nodeId]
  return true
}

/**
 * Find the closest common ancestor of a set of node ids.
 *
 * Algorithm: collect each id's ancestor chain (root → id), then intersect.
 * The deepest id present in every chain is the CCA.
 *
 * Returns `null` if the ids have no common ancestor (cannot happen in a
 * well-formed tree where root is the universal ancestor — but we guard
 * against orphan nodes anyway).
 */
function findClosestCommonAncestor(
  tree: NodeTree<PageNode>,
  nodeIds: string[],
): PageNode | null {
  if (nodeIds.length === 0) return null

  // Build chain for the first id, including itself.
  const firstChain = ancestorChainInclusive(tree, nodeIds[0])
  if (firstChain.length === 0) return null

  // Intersect with each subsequent id's chain (set membership).
  let candidate = firstChain
  for (let i = 1; i < nodeIds.length; i++) {
    const chain = new Set(ancestorChainInclusive(tree, nodeIds[i]).map((n) => n.id))
    candidate = candidate.filter((n) => chain.has(n.id))
    if (candidate.length === 0) return null
  }

  // The CCA is the DEEPEST node in the intersection — i.e. the LAST entry,
  // since `ancestorChainInclusive` returns root → id order. But the CCA must
  // not be one of the input ids itself (a node is not its own wrapper-parent).
  // Walk up from the deepest survivor until we find one not in the input set.
  const inputSet = new Set(nodeIds)
  for (let i = candidate.length - 1; i >= 0; i--) {
    if (!inputSet.has(candidate[i].id)) return candidate[i]
  }
  return null
}

/** Return [root, ..., nodeId] — inclusive ancestor chain. */
function ancestorChainInclusive(
  tree: NodeTree<PageNode>,
  nodeId: string,
): PageNode[] {
  const chain: PageNode[] = []
  let current: PageNode | undefined = tree.nodes[nodeId]
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    chain.unshift(current)
    if (current.id === tree.rootNodeId) break
    current = getParent(tree, current.id)
  }
  return chain
}

/**
 * Walk up from `nodeId` until reaching a node whose parent is `ancestorId`.
 * Returns that "branch" node — i.e. the descendant of `ancestorId` that
 * contains `nodeId` in its subtree. Returns null if `ancestorId` is not an
 * ancestor of `nodeId`.
 */
function ancestorChildOf(
  tree: NodeTree<PageNode>,
  nodeId: string,
  ancestorId: string,
): string | null {
  let current = nodeId
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const parent = getParent(tree, current)
    if (!parent) return null
    if (parent.id === ancestorId) return current
    current = parent.id
  }
  return null
}
