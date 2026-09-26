/**
 * rereadRenderKeys — carry React keys through a `patchPages` re-read (PERF-6).
 *
 * A write that renumbers `rel:line:col` ids used to remount every element it
 * renumbered, because `NodeRenderer` keyed each child by its id. This aligns
 * each re-read page against the page the store held (`alignPageTrees`, the
 * same content alignment the selection follows through) and hands the result
 * to `canvas/nodeRenderKeys.ts`, so every moved element keeps the key it
 * rendered under and React reconciles it in place.
 *
 * One rule makes that safe alongside `replaceEqualDeep`'s node sharing: a
 * node object shared from the previous page does not re-render, so its
 * `NodeRenderer` would keep the child keys it rendered last time. Whenever a
 * child's key changed under a shared parent (moving one of several same-size
 * siblings permutes the addresses and leaves the parent's `children` ids
 * identical), the parent gets a fresh copy of itself, so it re-renders and
 * hands React the new keys.
 */
import type { Page } from '@core/page-tree'
import { carryNodeRenderKeys, dropNodeRenderKeys, nodeRenderKey } from '@site/canvas/nodeRenderKeys'
import { alignPageTrees } from './reparseNodeFollow'

/**
 * Re-key every re-read page of `after` from its counterpart in `before`, and
 * forget the keys of removed and brand-new pages. `after`'s re-read pages must
 * be the objects `patchPages` is about to store: a shared parent whose child
 * keys changed is replaced in its page's `nodes` IN PLACE (see the module doc).
 *
 * Returns page id -> old id -> new id for every page it aligned, for the
 * canvas-state follower to reuse (`createReparseNodeFollower`'s `alignments`).
 */
export function carryRenderKeysThroughReread(
  before: readonly Page[],
  after: Page[],
  rereadPageIds: ReadonlySet<string>,
  removedPageIds: ReadonlySet<string>,
): Map<string, Map<string, string>> {
  for (const id of removedPageIds) dropNodeRenderKeys(id)
  const beforeById = new Map(before.map((page) => [page.id, page]))
  const alignments = new Map<string, Map<string, string>>()
  for (let i = 0; i < after.length; i++) {
    const page = after[i]!
    if (!rereadPageIds.has(page.id)) continue
    const beforePage = beforeById.get(page.id)
    if (!beforePage) {
      dropNodeRenderKeys(page.id)
      continue
    }
    // `replaceEqualDeep` kept the page: nothing in it changed, keys included.
    if (beforePage === page) continue

    const ids = Object.keys(page.nodes)
    const keyBefore = new Map(ids.map((id) => [id, nodeRenderKey(page.id, id)]))
    const alignment = alignPageTrees(beforePage, page)
    alignments.set(page.id, alignment)
    carryNodeRenderKeys(page.id, beforePage, page, alignment)

    const staleParents = new Set<string>()
    for (const id of ids) {
      if (nodeRenderKey(page.id, id) === keyBefore.get(id)) continue
      const parentId = page.nodes[id]!.parentId
      if (parentId && page.nodes[parentId] === beforePage.nodes[parentId]) staleParents.add(parentId)
    }
    if (staleParents.size === 0) continue
    // `page` is a new object (it is not `beforePage`), but its `nodes` record
    // may be the previous page's, shared whole — copy it before replacing.
    const nodes = page.nodes === beforePage.nodes ? { ...page.nodes } : page.nodes
    for (const parentId of staleParents) nodes[parentId] = { ...nodes[parentId]! }
    if (nodes !== page.nodes) after[i] = { ...page, nodes }
  }
  return alignments
}
