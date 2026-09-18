import { nanoid } from 'nanoid'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import { getParent, isAncestor, collectSubtreeIds } from './selectors'
import { deleteSubtree } from './subtreeRemoval'
import { cloneNodeWithRemap } from './cloneNode'

// ---------------------------------------------------------------------------
// parentId maintenance helper
// ---------------------------------------------------------------------------

/**
 * Stamp `parentId = parentNodeId` on every direct child of `parentNodeId`.
 * Used by the clone mutations (duplicateNode / pasteSubtree) to re-link a
 * freshly inserted subtree's internal parentage in O(subtree) without
 * rescanning the whole tree. The clone-subtree root's own parentId is set
 * separately by the caller (its parent lives outside the cloned set).
 */
function linkChildrenParents(nodes: Record<string, PageNode>, parentNodeId: string): void {
  const parent = nodes[parentNodeId]
  if (!parent) return
  for (const childId of parent.children) {
    const child = nodes[childId]
    if (child) child.parentId = parentNodeId
  }
}

/**
 * Pure Mutative-compatible mutation helpers for the page tree.
 *
 * These are called inside Zustand's Mutative middleware — they mutate a draft
 * NodeTree/SiteDocument directly. Every function here is also safe to call as
 * a pure function when given a structuredClone'd object.
 *
 * Naming convention:
 *   - Node-level mutations take a `NodeTree<PageNode>` draft as first arg.
 *   - Site-level mutations take a `SiteDocument` draft.
 *
 * Since `Page` IS a `NodeTree<PageNode>` (it has `nodes` and `rootNodeId` plus
 * metadata fields), callers that pass a `Page` draft continue to work unchanged.
 */

// ---------------------------------------------------------------------------
// Node creation helpers
// ---------------------------------------------------------------------------

export function createNode(
  moduleId: string,
  defaults: Record<string, unknown> = {}
): PageNode {
  return {
    id: nanoid(),
    moduleId,
    props: { ...defaults },
    breakpointOverrides: {},
    children: [],
    classIds: [],
    // Detached until insertNode/wrapNode attaches it and stamps the real parent.
    parentId: null,
  }
}

// ---------------------------------------------------------------------------
// Node insertion
// ---------------------------------------------------------------------------

/**
 * Insert a new node as a child of parentId at the given index.
 * If index is omitted, appends to the end.
 */
export function insertNode(
  tree: NodeTree<PageNode>,
  node: PageNode,
  parentId: string,
  index?: number
): void {
  if (tree.nodes[node.id]) {
    throw new Error(`[PageTree] Node "${node.id}" already exists in the tree`)
  }
  const parent = tree.nodes[parentId]
  if (!parent) {
    throw new Error(`[PageTree] Parent node "${parentId}" not found`)
  }
  tree.nodes[node.id] = node
  node.parentId = parentId
  if (index === undefined || index >= parent.children.length) {
    parent.children.push(node.id)
  } else {
    parent.children.splice(Math.max(0, index), 0, node.id)
  }
}

// ---------------------------------------------------------------------------
// Node deletion
// ---------------------------------------------------------------------------

/**
 * Remove a node and ALL its descendants from the tree.
 * Also removes the node's ID from its parent's children array.
 */
export function deleteNode(tree: NodeTree<PageNode>, nodeId: string): void {
  if (nodeId === tree.rootNodeId) {
    throw new Error(`[PageTree] Cannot delete the root node.`)
  }
  deleteSubtree(tree.nodes, nodeId, { unlinkParent: true })
}

// ---------------------------------------------------------------------------
// Node props update
// ---------------------------------------------------------------------------

/** Update one or more props on a node (shallow merge). */
export function updateNodeProps(
  tree: NodeTree<PageNode>,
  nodeId: string,
  patch: Partial<Record<string, unknown>>
): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  Object.assign(node.props, patch)
}

/** Set a breakpoint override for one or more props. */
export function setBreakpointOverride(
  tree: NodeTree<PageNode>,
  nodeId: string,
  breakpointId: string,
  patch: Partial<Record<string, unknown>>
): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  if (!node.breakpointOverrides[breakpointId]) {
    node.breakpointOverrides[breakpointId] = {}
  }
  Object.assign(node.breakpointOverrides[breakpointId], patch)
}

/** Clear all breakpoint overrides for a specific breakpoint on a node. */
export function clearBreakpointOverride(
  tree: NodeTree<PageNode>,
  nodeId: string,
  breakpointId: string
): void {
  const node = tree.nodes[nodeId]
  if (!node) return
  delete node.breakpointOverrides[breakpointId]
}

// ---------------------------------------------------------------------------
// Node metadata
// ---------------------------------------------------------------------------

export function renameNode(tree: NodeTree<PageNode>, nodeId: string, label: string): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.label = label.trim() || undefined
}

/**
 * Set a node's structural lock to an ABSOLUTE value.
 *
 * The absolute form is what a fan-out over N nodes needs: "lock all of these"
 * has one answer, while N independent toggles over a selection that disagrees
 * just swaps which half is locked. `toggleNodeLocked` below is this function
 * with the node's own current value read first.
 */
export function setNodeLocked(tree: NodeTree<PageNode>, nodeId: string, locked: boolean): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.locked = locked
}

/** Set a node's canvas visibility to an ABSOLUTE value. See `setNodeLocked`. */
export function setNodeHidden(tree: NodeTree<PageNode>, nodeId: string, hidden: boolean): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.hidden = hidden
}

export function toggleNodeLocked(tree: NodeTree<PageNode>, nodeId: string): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  setNodeLocked(tree, nodeId, !node.locked)
}

export function toggleNodeHidden(tree: NodeTree<PageNode>, nodeId: string): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  setNodeHidden(tree, nodeId, !node.hidden)
}

// ---------------------------------------------------------------------------
// Node reorder / move
// ---------------------------------------------------------------------------

/**
 * Move a node to a new position within its current parent, or to a new parent.
 *
 * @param newParentId  - Target parent node ID
 * @param newIndex     - Insertion index within the new parent's children
 */
export function moveNode(
  tree: NodeTree<PageNode>,
  nodeId: string,
  newParentId: string,
  newIndex: number
): void {
  if (nodeId === tree.rootNodeId) {
    throw new Error(`[PageTree] Cannot move the root node.`)
  }
  if (isAncestor(tree, nodeId, newParentId)) {
    throw new Error(
      `[PageTree] Cannot move node "${nodeId}" into its own descendant "${newParentId}".`
    )
  }
  const newParent = tree.nodes[newParentId]
  if (!newParent) throw new Error(`[PageTree] New parent "${newParentId}" not found`)

  // Remove from old parent
  const oldParent = getParent(tree, nodeId)
  if (oldParent) {
    oldParent.children = oldParent.children.filter((id) => id !== nodeId)
  }

  // Insert at new location
  const clampedIndex = Math.max(0, Math.min(newIndex, newParent.children.length))
  newParent.children.splice(clampedIndex, 0, nodeId)

  // Re-point the moved node at its new parent.
  const moved = tree.nodes[nodeId]
  if (moved) moved.parentId = newParentId
}

// ---------------------------------------------------------------------------
// Node duplication
// ---------------------------------------------------------------------------

/**
 * Deep-clone a node subtree, assigning new IDs to all cloned nodes.
 * Inserts the clone immediately after the source node in the same parent.
 * Returns the ID of the new root clone node.
 *
 * `options.nodeIdMap` accepts a precomputed oldId → newId map; if omitted, one
 * is built locally via DFS from `nodeId`. Callers that need to clone scoped
 * classes alongside the node duplication MUST precompute the map (so they can
 * call `cloneScopedClassesForNodeMap` against it) and pass it in.
 *
 * `options.classIdRemap` lets the caller remap classIds at clone time — needed
 * when scoped classes were cloned alongside the nodes (each old node-scoped
 * classId maps to a fresh clone with the new node's `scope.nodeId`). Class ids
 * NOT in the map pass through unchanged.
 */
export function duplicateNode(
  tree: NodeTree<PageNode>,
  nodeId: string,
  options: {
    nodeIdMap?: Map<string, string>
    classIdRemap?: Map<string, string>
  } = {},
): string {
  const idMap = options.nodeIdMap ?? new Map<string, string>()
  const { classIdRemap } = options

  // Build id mapping for entire subtree if the caller didn't provide one.
  // If the caller passed a precomputed map, trust it as-is — the caller
  // already walked the subtree (typically to build a class-id remap against
  // the same set of node ids).
  if (idMap.size === 0) {
    for (const id of collectSubtreeIds(tree.nodes, nodeId)) {
      idMap.set(id, nanoid())
    }
  }

  // Same-document duplication keeps unknown classIds (they reference shared
  // site-level classes); the optional map only remaps node-scoped class ids.
  const remapClassId = classIdRemap
    ? (cid: string) => classIdRemap.get(cid) ?? cid
    : undefined

  // Clone all nodes with remapped IDs, children, and (optionally) classIds.
  for (const [oldId, newId] of idMap) {
    const original = tree.nodes[oldId]
    if (!original) continue
    tree.nodes[newId] = cloneNodeWithRemap(original, { newId, idMap, classIdRemap: remapClassId })
  }

  // Re-link parentId across the cloned subtree: every clone's children point
  // at the clone. The subtree root's own parent is set below (its parent lives
  // outside the cloned set).
  for (const newId of idMap.values()) {
    linkChildrenParents(tree.nodes, newId)
  }

  // Insert the new root clone after the original in its parent
  const newRootId = idMap.get(nodeId)!
  const parent = getParent(tree, nodeId)
  if (parent) {
    const idx = parent.children.indexOf(nodeId)
    parent.children.splice(idx + 1, 0, newRootId)
  }
  const newRoot = tree.nodes[newRootId]
  if (newRoot) newRoot.parentId = parent ? parent.id : (tree.nodes[nodeId]?.parentId ?? null)

  return newRootId
}

// ---------------------------------------------------------------------------
// Paste — insert a foreign subtree from a clipboard payload
// ---------------------------------------------------------------------------

/**
 * Build a map of fresh node IDs for every node reachable from `rootNodeId`
 * inside `nodes`. Each entry maps the source-side ID to a freshly minted
 * `nanoid()` ID, suitable for inserting the subtree into the target tree
 * without collisions.
 *
 * Exposed separately from `pasteSubtree` because the clipboard slice needs
 * the map up front: scoped classes carry a `scope.nodeId` that must be
 * remapped to the new node ID before the class is added to the target site.
 */
export function buildSubtreeNodeIdMap(
  rootNodeId: string,
  nodes: Record<string, PageNode>,
): Map<string, string> {
  const idMap = new Map<string, string>()
  for (const id of collectSubtreeIds(nodes, rootNodeId)) {
    idMap.set(id, nanoid())
  }
  return idMap
}

/**
 * Insert a foreign subtree (root node + descendants) under a target parent.
 *
 * The payload comes from the clipboard slice and may originate from any page.
 * All node IDs are regenerated on insert so collisions with the target tree
 * are impossible.
 *
 * `options.nodeIdMap` accepts a precomputed map (typically built via
 * `buildSubtreeNodeIdMap`); if omitted, one is built locally. Callers that
 * need to remap class scope.nodeId in tandem with node IDs MUST precompute
 * the map and pass it in.
 *
 * `options.classIdRemap` lets the caller filter / remap classIds at insertion
 * time — needed when the payload references classes that don't exist in the
 * active document or framework classes that were regenerated with different
 * IDs. Return `null` from the mapper to drop a classId, or a string to remap
 * it.
 *
 * Returns the new root node ID inside the target tree.
 */
export function pasteSubtree(
  tree: NodeTree<PageNode>,
  payload: { rootNodeId: string; nodes: Record<string, PageNode> },
  parentId: string,
  index?: number,
  options: {
    nodeIdMap?: Map<string, string>
    classIdRemap?: (classId: string) => string | null
  } = {}
): string {
  const parent = tree.nodes[parentId]
  if (!parent) {
    throw new Error(`[PageTree] Parent node "${parentId}" not found`)
  }

  const idMap = options.nodeIdMap ?? buildSubtreeNodeIdMap(payload.rootNodeId, payload.nodes)
  const { classIdRemap } = options

  // Clone every node with remapped ID and (optionally) filtered classIds. The
  // foreign payload may reference classes the target document can't resolve, so
  // `classIdRemap` returns `null` to drop those.
  for (const [oldId, newId] of idMap) {
    const original = payload.nodes[oldId]
    if (!original) continue
    tree.nodes[newId] = cloneNodeWithRemap(original, { newId, idMap, classIdRemap })
  }

  // Re-link parentId across the freshly inserted subtree from its children
  // arrays — never trust any parentId carried in the foreign payload.
  for (const newId of idMap.values()) {
    linkChildrenParents(tree.nodes, newId)
  }

  // Insert the new root under its target parent.
  const newRootId = idMap.get(payload.rootNodeId)
  if (!newRootId) {
    throw new Error('[PageTree] Clipboard payload root not found in payload.nodes')
  }
  if (index === undefined || index >= parent.children.length) {
    parent.children.push(newRootId)
  } else {
    parent.children.splice(Math.max(0, index), 0, newRootId)
  }
  const newRoot = tree.nodes[newRootId]
  if (newRoot) newRoot.parentId = parentId

  return newRootId
}

/**
 * Move a multi-selection of nodes into a new parent at a target index.
 *
 * Same "top-level reduction" as `wrapNodes`: nodes whose ancestor is also in
 * the move set are dropped (they move with the ancestor automatically).
 *
 * Cycle guard: every top-level id must NOT be an ancestor of `newParentId`.
 *
 * Final placement: the moved branches end up consecutively starting at
 * `newIndex` in `newParent.children`, preserving their selection order.
 */
export function moveNodes(
  tree: NodeTree<PageNode>,
  nodeIds: string[],
  newParentId: string,
  newIndex: number,
): void {
  if (nodeIds.length === 0) return
  if (nodeIds.length === 1) {
    moveNode(tree, nodeIds[0], newParentId, newIndex)
    return
  }
  const newParent = tree.nodes[newParentId]
  if (!newParent) throw new Error(`[PageTree] New parent "${newParentId}" not found`)

  // Reduce to top-level set.
  const idSet = new Set(nodeIds)
  const topLevel: string[] = []
  for (const id of nodeIds) {
    if (id === tree.rootNodeId) {
      throw new Error(`[PageTree] Cannot move the root node.`)
    }
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

  // Cycle guard.
  for (const id of topLevel) {
    if (isAncestor(tree, id, newParentId)) {
      throw new Error(
        `[PageTree] Cannot move node "${id}" into its own descendant "${newParentId}".`,
      )
    }
  }

  // Detach each moved id from its current parent (top-down). Some moved ids
  // may share the same parent — filtering once per parent is correct.
  for (const id of topLevel) {
    const oldParent = getParent(tree, id)
    if (oldParent) {
      oldParent.children = oldParent.children.filter((childId) => childId !== id)
    }
  }

  // Insert into newParent at newIndex, preserving topLevel order.
  const clamped = Math.max(0, Math.min(newIndex, newParent.children.length))
  newParent.children.splice(clamped, 0, ...topLevel)

  // Re-point every moved branch at its new parent.
  for (const id of topLevel) {
    const moved = tree.nodes[id]
    if (moved) moved.parentId = newParentId
  }
}

