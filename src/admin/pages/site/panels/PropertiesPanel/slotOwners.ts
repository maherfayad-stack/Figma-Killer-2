/**
 * slotOwners — the two id→node lookups the Properties panel needs for slot
 * content, both O(1) reads over indexes the site slice already maintains.
 *
 * The reverse direction (a materialized slot-fill node's own id → the node +
 * prop key that fills its slot WITH it) has no structural shortcut: a slot's
 * owner reaches ITS content forward, through the `studio-slot:<id>` sentinel
 * in its own `props`/`callSiteProps`, and nothing points back.
 *
 * This module used to build that reverse map itself, from a full walk of every
 * node of every page, cached against `site` object identity. That cache was
 * the defect in disguise: Mutative mints a new `site` reference on EVERY
 * mutation, so "the site might have changed" is true after every keystroke,
 * and `SlotFillNotice`'s `useEditorStore((s) => lookupSlotOwner(s.site, id))`
 * — a subscribed selector, re-run on every store change — rebuilt the whole
 * map per character typed. `STUDIO-FIGMA-PARITY-PLAN.md`'s "trap #11", one
 * import hop away from the gate that guards it (`store-01b`).
 *
 * The map now lives in `store/slices/site/nodeIndex.ts` as
 * `_slotOwnerBindings`, maintained incrementally from the same `DirtyMarks`
 * as `_nodeIdToPageIds` — built once at load, patched per touched page, never
 * rebuilt on a read.
 */
import type { PageNode, SiteDocument } from '@core/page-tree'
import type { SlotOwnerEntry } from '@site/store/slices/site/nodeIndex'
import { lookupCanvasPageById } from '@site/store/store'

export type { SlotOwnerEntry }

/**
 * Which node/prop fills its slot with `nodeId`, or `null` when `nodeId` is not
 * slot content. Many-valued in the index (a composed layout owner binds once
 * per route it appears on); every binding for one slot id names the same owner
 * node and prop, so the first is the answer for every caller that just wants
 * to name — or jump to — the owner.
 */
export function lookupSlotOwner(
  slotOwnerBindings: ReadonlyMap<string, SlotOwnerEntry[]>,
  nodeId: string,
): SlotOwnerEntry | null {
  return slotOwnerBindings.get(nodeId)?.[0] ?? null
}

/**
 * Resolve any node by id — the forward counterpart `lookupSlotOwner` needs
 * for its own callers (e.g. `SlotControl` resolving the OWNER node's own
 * `lockReason` for its insert pre-check). Composes two indexes the store
 * already builds at load and maintains incrementally on every mutation
 * (`_nodeIdToPageIds`, WS-5.2; `lookupCanvasPageById`'s per-`site` page
 * cache) — an O(1) lookup after the first page-cache miss, never a fresh
 * `site.pages.flatMap(...)` scan.
 */
export function resolveNodeById(
  site: SiteDocument | null,
  nodeIdToPageIds: ReadonlyMap<string, string[]>,
  nodeId: string,
): PageNode | null {
  if (!site) return null
  const pageIds = nodeIdToPageIds.get(nodeId)
  const pageId = pageIds?.[0]
  if (!pageId) return null
  const page = lookupCanvasPageById(site, pageId)
  return page?.nodes[nodeId] ?? null
}
