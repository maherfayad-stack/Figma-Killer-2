import type { NodeTree } from '@core/page-tree'
import { nodeAtIndexPath, type NodeHint } from '@core/studio-anchor'

/**
 * The node a stored layer-name hint names in `page` NOW, or `null` when the
 * element is gone.
 *
 * Stricter than `resolveNodeAnchor` on purpose. That one trusts a stored id that
 * still resolves; but an id is a source position, and after an edit the same
 * `file:line:col` can belong to a different element. A name put on the wrong
 * element is worse than a name not shown, so an id counts only when the node
 * there is the same KIND of module, and the structural path (which survives
 * edits above the element) only when it lands on the same kind too. A name
 * whose element is gone stays in the file, unapplied.
 */
export function resolveLayerNameTarget(page: NodeTree, hint: NodeHint): string | null {
  const byId = page.nodes[hint.nodeId]
  if (byId && byId.moduleId === hint.moduleId) return byId.id
  const byPath = nodeAtIndexPath(page, hint.indexPath)
  return byPath && byPath.moduleId === hint.moduleId ? byPath.id : null
}
