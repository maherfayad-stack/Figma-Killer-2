/**
 * multiSelectNodes — resolve a multi-selection's ids to live nodes, once.
 *
 * Lifted out of `MultiInlineStyleComposer` when `MultiSelectionStyleArea`
 * (W8-3 phase 3) needed the same list to answer a different question
 * ("do these share a class?"). One resolution, one set of rules about where a
 * node may be found.
 */
import type { PageNode } from '@core/page-tree'

/** The two site shapes this needs — kept narrow so tests can pass literals. */
export interface NodeLookupSources {
  activeTree: { nodes: Record<string, PageNode> } | null
  site: { pages: ReadonlyArray<{ id: string; nodes: Record<string, PageNode> }> } | null
  nodeIdToPageIds: ReadonlyMap<string, string[]>
}

/**
 * Resolve one selected id to its live node.
 *
 * The active canvas tree answers for the overwhelmingly common case (one
 * frame, or a VC canvas, which `_nodeIdToPageIds` deliberately does not
 * index). A board multi-selection can span frames, so an id the active tree
 * doesn't hold is resolved through the O(1) `_nodeIdToPageIds` index and a
 * single `pages.find` — never a walk of every node of every page
 * (`no-full-site-scan-in-selectors`).
 */
export function resolveSelectedNode(nodeId: string, sources: NodeLookupSources): PageNode | null {
  const fromActive = sources.activeTree?.nodes[nodeId]
  if (fromActive) return fromActive
  const pageId = sources.nodeIdToPageIds.get(nodeId)?.[0]
  if (!pageId || !sources.site) return null
  return sources.site.pages.find((page) => page.id === pageId)?.nodes[nodeId] ?? null
}

/** Every id that still resolves, in selection order. Stale ids are dropped. */
export function resolveSelectedNodes(
  nodeIds: ReadonlyArray<string>,
  sources: NodeLookupSources,
): PageNode[] {
  return nodeIds
    .map((id) => resolveSelectedNode(id, sources))
    .filter((node): node is PageNode => node !== null)
}
