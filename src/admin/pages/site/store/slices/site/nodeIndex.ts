/**
 * Node-lookup indexes over `site.pages`, built once at load and maintained
 * incrementally by every mutation that can change page node membership.
 *
 * WS-5.2: two `useEditorStore` selectors used to scan every node of every
 * page on every store change (`PropertiesPanelBody.tsx`'s
 * `sharedTextOriginCount`, `InPlaceInspector.tsx`'s `findNodeById`) — on a
 * 40-page/1000-node-per-page board that is 40 000 iterations per keystroke.
 * A third instance of the identical shape (`SharedComponentNotice.tsx`'s
 * `instanceCount`, counting inlined-component call sites) turned up while
 * building the gate this module exists to satisfy — fixed alongside the two
 * named ones rather than left for the gate to keep tripping over.
 *
 * Three indexes, one shared invalidation strategy:
 *
 *   - `nodeIdToPageIds: Map<string, string[]>` — **many-valued.** As of
 *     WS-1.3's Next.js App Router support, node ids are NOT unique across
 *     pages: a shared `layout.tsx` is composed into every route beneath it,
 *     so `app/blog/layout.tsx:4:7` is the identical id in `/blog/first` and
 *     `/blog/second` — proven by
 *     `src/core/page-parser/__tests__/nextAppLayout.test.ts`. A
 *     `Map<string, string>` (the plan's original shape) would silently drop
 *     every route but the last one indexed. See `STATE.md` → `meta-05`.
 *   - `textOriginKeyToCount: Map<string, number>` — how many nodes across
 *     the site resolve text from the same source literal (`rel:line:col`).
 *     No multi-page ambiguity here: it is a pure count.
 *   - `inlineTailToCount: Map<string, number>` — how many nodes across the
 *     site were inlined from the same local-component call site (the tail
 *     after `INLINE_ID_SEPARATOR` in a composite id).
 *
 * Invalidation: every write to `site.pages` in this store already produces
 * `DirtyMarks` (`dirtyTracking.ts`) — the same pre/post page-membership diff
 * autosave uses to decide which pages to ship. `applyNodeIndexPatch` reuses
 * those marks instead of re-deriving membership from patch shapes: for each
 * touched page it diffs the page's OWN pre/post node-id set (bounded by that
 * page's size, never the whole site) and adjusts exactly the ids that
 * entered or left. A node's `textOrigin` is parse-time-only metadata — no
 * store mutation reassigns it on an existing node id (confirmed: the only
 * writer is `parsedPageToSitePage.ts`) — so a node keeps the same origin for
 * its whole lifetime in the store, and the id-set diff is sufficient; no
 * separate "did textOrigin change" case exists to miss.
 *
 * `marks.all` (wholesale/ambiguous patches — Super Import, framework
 * reconciliation) falls back to a full rebuild. That is the same rare,
 * non-keystroke path `dirtyTracking.ts` already reserves `all` for.
 */

import type { PageNode, SiteDocument } from '@core/page-tree'
import { INLINE_ID_SEPARATOR, isInlinedNodeId } from '@core/page-tree'
import type { DirtyMarks } from './dirtyTracking'

export interface NodeIndexes {
  nodeIdToPageIds: Map<string, string[]>
  textOriginKeyToCount: Map<string, number>
  inlineTailToCount: Map<string, number>
}

/** `rel:line:col` — the same key shape `SourceLockedNotice`/`sharedTextOriginCount` compared by hand. */
export function textOriginKey(origin: { rel: string; line: number; col: number }): string {
  return `${origin.rel}:${origin.line}:${origin.col}`
}

/**
 * The call-site tail an inlined node id shares with every other instance of
 * the same local component, or `undefined` for a plain (non-inlined) id.
 * Mirrors the composite-id grammar in `sourceNodeId.ts` (`decodeSourceNodeId`
 * splits on the same separator for the same reason: the tail, not the head,
 * is the shared identity).
 */
export function inlineTailKey(nodeId: string): string | undefined {
  if (!isInlinedNodeId(nodeId)) return undefined
  return nodeId.split(INLINE_ID_SEPARATOR).pop()
}

function addPageIdForNode(index: Map<string, string[]>, nodeId: string, pageId: string): void {
  const existing = index.get(nodeId)
  if (!existing) {
    index.set(nodeId, [pageId])
    return
  }
  if (!existing.includes(pageId)) index.set(nodeId, [...existing, pageId])
}

function removePageIdForNode(index: Map<string, string[]>, nodeId: string, pageId: string): void {
  const existing = index.get(nodeId)
  if (!existing) return
  const next = existing.filter((id) => id !== pageId)
  if (next.length === 0) index.delete(nodeId)
  else index.set(nodeId, next)
}

function incrementCount(index: Map<string, number>, key: string): void {
  index.set(key, (index.get(key) ?? 0) + 1)
}

function decrementCount(index: Map<string, number>, key: string): void {
  const current = index.get(key)
  if (current === undefined) return
  if (current <= 1) index.delete(key)
  else index.set(key, current - 1)
}

/** Record `node`'s contribution to every index (on `pageId`) — the shared add-path for rebuild and incremental update. */
function indexNode(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  addPageIdForNode(indexes.nodeIdToPageIds, node.id, pageId)
  if (node.textOrigin) incrementCount(indexes.textOriginKeyToCount, textOriginKey(node.textOrigin))
  const tail = inlineTailKey(node.id)
  if (tail) incrementCount(indexes.inlineTailToCount, tail)
}

/** Retract `node`'s contribution to every index (on `pageId`) — the shared remove-path. */
function unindexNode(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  removePageIdForNode(indexes.nodeIdToPageIds, node.id, pageId)
  if (node.textOrigin) decrementCount(indexes.textOriginKeyToCount, textOriginKey(node.textOrigin))
  const tail = inlineTailKey(node.id)
  if (tail) decrementCount(indexes.inlineTailToCount, tail)
}

/**
 * Rebuild all three indexes from scratch by scanning every node of every
 * page — exactly the scan this module exists to get OFF the selector path.
 * Callers: `loadSite`/`createSite` (once per project open, not per
 * keystroke) and `applyNodeIndexPatch`'s `marks.all` fallback (rare).
 */
export function rebuildNodeIndexes(indexes: NodeIndexes, site: SiteDocument): void {
  indexes.nodeIdToPageIds.clear()
  indexes.textOriginKeyToCount.clear()
  indexes.inlineTailToCount.clear()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      indexNode(indexes, node, page.id)
    }
  }
}

/** Clear every index — mirrors `clearSite` leaving `site: null`. */
export function clearNodeIndexes(indexes: NodeIndexes): void {
  indexes.nodeIdToPageIds.clear()
  indexes.textOriginKeyToCount.clear()
  indexes.inlineTailToCount.clear()
}

/**
 * Incrementally update all three indexes for exactly the pages `marks` says
 * changed membership (or were deleted), diffing each touched page's own
 * pre/post node-id set. `marks` is `DirtyMarks` from
 * `collectDirtyFromSitePatches` — the SAME pre/post membership diff autosave
 * already trusts, reused here instead of re-deriving it from patch shapes.
 *
 * A page in `marks.pageIds` whose node-id set didn't actually change (a prop
 * edit, a style edit — most keystrokes) costs one `Set` diff over that
 * page's own node count and touches nothing; still O(one page), never
 * O(site).
 */
export function applyNodeIndexPatch(
  indexes: NodeIndexes,
  preSite: SiteDocument,
  postSite: SiteDocument,
  marks: DirtyMarks,
): void {
  if (marks.all) {
    rebuildNodeIndexes(indexes, postSite)
    return
  }
  if (marks.pageIds.size === 0 && marks.deletedPageIds.size === 0) return

  for (const pageId of marks.deletedPageIds) {
    const oldPage = preSite.pages.find((p) => p.id === pageId)
    if (!oldPage) continue
    for (const node of Object.values(oldPage.nodes)) unindexNode(indexes, node, pageId)
  }

  for (const pageId of marks.pageIds) {
    const newPage = postSite.pages.find((p) => p.id === pageId)
    if (!newPage) continue // membership diff over-marks conservatively; nothing to index if it's gone
    const oldPage = preSite.pages.find((p) => p.id === pageId)

    const oldIds = oldPage ? Object.keys(oldPage.nodes) : []
    const newIds = Object.keys(newPage.nodes)
    const oldIdSet = new Set(oldIds)
    const newIdSet = new Set(newIds)

    for (const id of oldIds) {
      if (newIdSet.has(id)) continue
      unindexNode(indexes, oldPage!.nodes[id]!, pageId)
    }
    for (const id of newIds) {
      if (oldIdSet.has(id)) continue
      indexNode(indexes, newPage.nodes[id]!, pageId)
    }
  }
}
