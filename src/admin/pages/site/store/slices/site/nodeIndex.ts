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
 * Five indexes, one shared invalidation strategy:
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
 *   - `classIdToNodeCount: Map<string, number>` — how many nodes across the
 *     site carry each style-rule id in their `classIds` (store-01b). This is
 *     the "Used 3 times" tally the Selectors panel and the Properties panel's
 *     selector header render; both used to rebuild it from a full-site walk
 *     (`buildSelectorUsageMap`) inside a render body that re-runs on every
 *     keystroke, because Mutative mints a new `site` reference per mutation
 *     and so the React Compiler's memo — keyed on `site` — missed every time.
 *   - `slotOwnerBindings: Map<string, SlotOwnerEntry[]>` — the reverse map
 *     from a materialized slot-fill node's own id to the node + prop key that
 *     fills its slot WITH it (`SlotFillNotice`). Many-valued for the same
 *     reason `nodeIdToPageIds` is: one composed layout node can own the same
 *     slot fill on every route beneath it, and removing one route's copy must
 *     not blind the others.
 *
 * Invalidation: every write to `site.pages` in this store already produces
 * `DirtyMarks` (`dirtyTracking.ts`) — the same pre/post page-membership diff
 * autosave uses to decide which pages to ship. `applyNodeIndexPatch` reuses
 * those marks instead of re-deriving membership from patch shapes: for each
 * touched page it diffs the page's OWN pre/post node-id set (bounded by that
 * page's size, never the whole site) and adjusts exactly the ids that
 * entered or left.
 *
 * Two of the five facets are id-lifetime-stable and two are NOT, and the
 * difference is the one thing to keep straight when extending this module:
 *
 *   - `textOrigin` is parse-time-only metadata — no store mutation reassigns
 *     it on an existing node id (the only writer is
 *     `parsedPageToSitePage.ts`) — and `inlineTail` is derived from the id
 *     itself. Both are therefore fully determined by the id-set diff.
 *   - `classIds` and the slot sentinels in `props`/`callSiteProps` change on
 *     a node that keeps its id (assigning a class, deleting a class from the
 *     registry, re-pointing a slot). An id-set diff alone would never see
 *     those, so the same per-page pass also visits SURVIVING ids whose node
 *     object changed identity, and re-indexes just those two facets. Mutative
 *     gives untouched nodes the same reference across a mutation, so on the
 *     hot path (a keystroke into one node's props) that is one reference
 *     compare per node of one page and zero index writes.
 *
 * `marks.all` (wholesale/ambiguous patches — Super Import, framework
 * reconciliation) falls back to a full rebuild. That is the same rare,
 * non-keystroke path `dirtyTracking.ts` already reserves `all` for.
 */

import type { PageNode, SiteDocument } from '@core/page-tree'
import { INLINE_ID_SEPARATOR, isInlinedNodeId } from '@core/page-tree'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import type { DirtyMarks } from './dirtyTracking'

/** Who fills a slot with a given node — one binding per (page, owner) pair. */
export interface SlotOwnerEntry {
  /** The page this binding was read from; a shared layout owner binds once per route. */
  pageId: string
  /** The node whose prop this slot fills — a `studio.instance` call site, or (for a package/design-system component) the component's own node. */
  ownerNodeId: string
  ownerModuleId: string
  /** Raw slot/prop name — `'header'`, never `'callSiteProps:header'`. */
  propKey: string
}

export interface NodeIndexes {
  nodeIdToPageIds: Map<string, string[]>
  textOriginKeyToCount: Map<string, number>
  inlineTailToCount: Map<string, number>
  classIdToNodeCount: Map<string, number>
  slotOwnerBindings: Map<string, SlotOwnerEntry[]>
}

/**
 * The store fields backing {@link NodeIndexes}. Every call site used to spell
 * out the same five-field object literal; one accessor keeps "add an index"
 * a one-file change instead of a seven-call-site one.
 */
export interface NodeIndexHost {
  _nodeIdToPageIds: Map<string, string[]>
  _textOriginKeyToCount: Map<string, number>
  _inlineTailToCount: Map<string, number>
  _classIdToNodeCount: Map<string, number>
  _slotOwnerBindings: Map<string, SlotOwnerEntry[]>
}

/**
 * A fresh, empty index bundle. The single constructor for the shape, so
 * adding a facet stays a one-file change instead of breaking every caller
 * that hand-rolled the object literal.
 */
export function emptyNodeIndexes(): NodeIndexes {
  return {
    nodeIdToPageIds: new Map(),
    textOriginKeyToCount: new Map(),
    inlineTailToCount: new Map(),
    classIdToNodeCount: new Map(),
    slotOwnerBindings: new Map(),
  }
}

/** View the store's index fields as a {@link NodeIndexes} bundle (no copying — the same live Maps). */
export function nodeIndexesOf(state: NodeIndexHost): NodeIndexes {
  return {
    nodeIdToPageIds: state._nodeIdToPageIds,
    textOriginKeyToCount: state._textOriginKeyToCount,
    inlineTailToCount: state._inlineTailToCount,
    classIdToNodeCount: state._classIdToNodeCount,
    slotOwnerBindings: state._slotOwnerBindings,
  }
}

/** The inverse of {@link nodeIndexesOf}: a bundle as the store fields that hold it. */
export function nodeIndexState(indexes: NodeIndexes): NodeIndexHost {
  return {
    _nodeIdToPageIds: indexes.nodeIdToPageIds,
    _textOriginKeyToCount: indexes.textOriginKeyToCount,
    _inlineTailToCount: indexes.inlineTailToCount,
    _classIdToNodeCount: indexes.classIdToNodeCount,
    _slotOwnerBindings: indexes.slotOwnerBindings,
  }
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

/**
 * A `studio.instance`'s literal props live nested under `callSiteProps`;
 * every other module's slot props live directly on its own `props`.
 */
function ownerSlotPropsBag(node: PageNode): Record<string, unknown> | undefined {
  if (node.moduleId === 'studio.instance') {
    return (node.props as { callSiteProps?: Record<string, unknown> } | undefined)?.callSiteProps
  }
  return node.props as Record<string, unknown> | undefined
}

/** Every `(slotNodeId, propKey)` pair `node` fills a slot with — usually none. */
function slotBindingsOf(node: PageNode): { slotNodeId: string; propKey: string }[] {
  const bag = ownerSlotPropsBag(node)
  if (!bag) return []
  const out: { slotNodeId: string; propKey: string }[] = []
  for (const [propKey, value] of Object.entries(bag)) {
    const slotNodeId = studioSlotNodeId(value)
    if (slotNodeId === undefined) continue
    out.push({ slotNodeId, propKey })
  }
  return out
}

function indexClassIds(indexes: NodeIndexes, node: PageNode): void {
  for (const classId of node.classIds ?? []) incrementCount(indexes.classIdToNodeCount, classId)
}

function unindexClassIds(indexes: NodeIndexes, node: PageNode): void {
  for (const classId of node.classIds ?? []) decrementCount(indexes.classIdToNodeCount, classId)
}

function indexSlotBindings(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  for (const { slotNodeId, propKey } of slotBindingsOf(node)) {
    const existing = indexes.slotOwnerBindings.get(slotNodeId) ?? []
    if (existing.some((b) => b.pageId === pageId && b.ownerNodeId === node.id && b.propKey === propKey)) {
      continue
    }
    indexes.slotOwnerBindings.set(slotNodeId, [
      ...existing,
      { pageId, ownerNodeId: node.id, ownerModuleId: node.moduleId, propKey },
    ])
  }
}

function unindexSlotBindings(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  for (const { slotNodeId } of slotBindingsOf(node)) {
    const existing = indexes.slotOwnerBindings.get(slotNodeId)
    if (!existing) continue
    const next = existing.filter((b) => !(b.pageId === pageId && b.ownerNodeId === node.id))
    if (next.length === 0) indexes.slotOwnerBindings.delete(slotNodeId)
    else if (next.length !== existing.length) indexes.slotOwnerBindings.set(slotNodeId, next)
  }
}

/** Record `node`'s contribution to every index (on `pageId`) — the shared add-path for rebuild and incremental update. */
function indexNode(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  addPageIdForNode(indexes.nodeIdToPageIds, node.id, pageId)
  if (node.textOrigin) incrementCount(indexes.textOriginKeyToCount, textOriginKey(node.textOrigin))
  const tail = inlineTailKey(node.id)
  if (tail) incrementCount(indexes.inlineTailToCount, tail)
  indexClassIds(indexes, node)
  indexSlotBindings(indexes, node, pageId)
}

/** Retract `node`'s contribution to every index (on `pageId`) — the shared remove-path. */
function unindexNode(indexes: NodeIndexes, node: PageNode, pageId: string): void {
  removePageIdForNode(indexes.nodeIdToPageIds, node.id, pageId)
  if (node.textOrigin) decrementCount(indexes.textOriginKeyToCount, textOriginKey(node.textOrigin))
  const tail = inlineTailKey(node.id)
  if (tail) decrementCount(indexes.inlineTailToCount, tail)
  unindexClassIds(indexes, node)
  unindexSlotBindings(indexes, node, pageId)
}

/**
 * Re-index the two facets a node can change WITHOUT changing its id:
 * `classIds` and its slot sentinels. Called for every surviving id whose node
 * object changed identity during a mutation. Each facet is guarded by a
 * reference compare first, so a props-only edit does no index work and a
 * classIds-only edit does no slot work.
 */
function reindexMutableFacets(
  indexes: NodeIndexes,
  oldNode: PageNode,
  newNode: PageNode,
  pageId: string,
): void {
  if (oldNode.classIds !== newNode.classIds) {
    unindexClassIds(indexes, oldNode)
    indexClassIds(indexes, newNode)
  }
  // `moduleId` decides WHICH bag holds the sentinels, so it is part of the
  // slot-binding input, not just `props`.
  if (oldNode.props !== newNode.props || oldNode.moduleId !== newNode.moduleId) {
    unindexSlotBindings(indexes, oldNode, pageId)
    indexSlotBindings(indexes, newNode, pageId)
  }
}

/**
 * Rebuild all three indexes from scratch by scanning every node of every
 * page — exactly the scan this module exists to get OFF the selector path.
 * Callers: `loadSite`/`createSite` (once per project open, not per
 * keystroke) and `applyNodeIndexPatch`'s `marks.all` fallback (rare).
 */
export function rebuildNodeIndexes(indexes: NodeIndexes, site: SiteDocument): void {
  clearNodeIndexes(indexes)
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
  indexes.classIdToNodeCount.clear()
  indexes.slotOwnerBindings.clear()
}

/**
 * Incrementally update all three indexes for exactly the pages `marks` says
 * changed membership (or were deleted), diffing each touched page's own
 * pre/post node-id set. `marks` is `DirtyMarks` from
 * `collectDirtyFromSitePatches` — the SAME pre/post membership diff autosave
 * already trusts, reused here instead of re-deriving it from patch shapes.
 *
 * A page in `marks.pageIds` whose node-id set didn't actually change (a prop
 * edit, a style edit — most keystrokes) costs one `Set` diff plus one
 * reference compare per node over that page's own node count, and writes to
 * an index only for the handful of nodes whose object identity actually
 * changed; still O(one page), never O(site).
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
      const oldNode = oldPage!.nodes[id]!
      if (!newIdSet.has(id)) {
        unindexNode(indexes, oldNode, pageId)
        continue
      }
      // Survivor: only the id-independent facets can have moved.
      const newNode = newPage.nodes[id]!
      if (oldNode !== newNode) reindexMutableFacets(indexes, oldNode, newNode, pageId)
    }
    for (const id of newIds) {
      if (oldIdSet.has(id)) continue
      indexNode(indexes, newPage.nodes[id]!, pageId)
    }
  }
}
