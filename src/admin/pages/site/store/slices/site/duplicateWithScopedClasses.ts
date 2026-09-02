/**
 * Duplicating a node subtree together with the per-node scoped classes it
 * owns.
 *
 * The pairing is the whole point. A `scope.type === 'node'` class keys on
 * `scope.nodeId`, so a plain `duplicateNode` leaves the copy pointing at the
 * ORIGINAL's class — editing either node then restyles both (F-0005). The id
 * remap therefore has to be built first, handed to `cloneScopedClassesForNodeMap`
 * so the cloned classes carry the NEW ids, and only then handed to the tree
 * mutation. Same contract `clipboardSlice.pasteNode` and
 * `visualComponentsSlice.clonePageSubtreeToFlatNodes` honour.
 */
import { nanoid } from 'nanoid'
import {
  cloneScopedClassesForNodeMap,
  duplicateNode,
  type NodeTree,
  type PageNode,
  type SiteDocument,
} from '@core/page-tree'

/**
 * Build the oldId → newId map for the entire subtree rooted at `nodeId`.
 * Pre-computed so the caller can clone scoped classes against the same remap
 * the duplicate mutation will apply to the nodes themselves.
 */
function buildSubtreeIdMap(tree: NodeTree<PageNode>, nodeId: string): Map<string, string> {
  const idMap = new Map<string, string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (idMap.has(id)) continue
    const node = tree.nodes[id]
    if (!node) continue
    idMap.set(id, nanoid())
    stack.push(...node.children)
  }
  return idMap
}

/**
 * Duplicate a node subtree AND clone every per-node scoped class it owns.
 * Returns the new root's id, or `''` when there was nothing to duplicate.
 *
 * Must run inside a Mutative recipe (mutates `tree` and `site` directly).
 */
export function duplicateNodeWithScopedClasses(
  tree: NodeTree<PageNode>,
  site: SiteDocument,
  nodeId: string,
): string {
  const nodeIdMap = buildSubtreeIdMap(tree, nodeId)
  if (nodeIdMap.size === 0) return ''

  const { added, classIdRemap } = cloneScopedClassesForNodeMap(nodeIdMap, site.styleRules)
  for (const cls of added) site.styleRules[cls.id] = cls

  return duplicateNode(tree, nodeId, { nodeIdMap, classIdRemap })
}
