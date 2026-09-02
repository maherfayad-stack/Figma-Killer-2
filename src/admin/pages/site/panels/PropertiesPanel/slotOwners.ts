/**
 * slotOwners — the reverse map from a materialized slot-fill node's own id
 * (`ParsedNode`/`PageNode.id`, e.g. `Home.tsx:12:9` for `<Icon/>` inside
 * `icon={<Icon/>}`, or `Home.tsx:12:9` for the `studio.slot` fragment
 * container itself) to the node + prop key that fills its slot WITH it.
 *
 * Nothing walks this direction today — a slot's owner reaches ITS content
 * only forward, through the `studio-slot:<id>` sentinel in its own
 * `props`/`callSiteProps`. Reversing that per render (`site.pages.flatMap(p
 * => Object.values(p.nodes)).find(...)`) is exactly `STUDIO-FIGMA-PARITY-
 * PLAN.md`'s "trap #11" — a full-site scan run from a component that
 * re-renders on every selection change — which this codebase has already
 * hit and fixed four separate times (`PropertiesPanelBody.tsx`,
 * `findNodeById.ts`, `selectCanvasPageFor`, `BoardFramesLayer`). Rather than
 * add a fifth bespoke scan, or wire a fifth incrementally-patched field into
 * `nodeIndex.ts` (a much larger footprint for a comparatively cold path —
 * this fires once per Properties-panel selection, not once per rendered
 * canvas node), this follows `store.ts`'s own `lookupCanvasPageById`
 * precedent exactly: a lazily-built cache keyed by `site` object identity
 * (Mutative mints a new `site` reference on every mutation, so a reference
 * change is precisely "the site might have changed", and an unchanged
 * reference means the previous build is still correct) — one full site
 * walk the FIRST time this is asked after a site change, O(1) every
 * subsequent lookup until the next one.
 */
import type { PageNode, SiteDocument } from '@core/page-tree'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { lookupCanvasPageById } from '@site/store/store'

export interface SlotOwnerEntry {
  /** The node whose prop this slot fills — a `studio.instance` call site, or (for a package/design-system component) the component's own node. */
  ownerNodeId: string
  ownerModuleId: string
  /** Raw slot/prop name — `'header'`, never `'callSiteProps:header'`. */
  propKey: string
}

/** A `studio.instance`'s literal props live nested; every other module's slot props live directly on its own `props`. */
function ownerSlotPropsBag(node: PageNode): Record<string, unknown> | undefined {
  if (node.moduleId === 'studio.instance') {
    return (node.props as { callSiteProps?: Record<string, unknown> } | undefined)?.callSiteProps
  }
  return node.props as Record<string, unknown> | undefined
}

function buildSlotOwners(site: SiteDocument): Map<string, SlotOwnerEntry> {
  const map = new Map<string, SlotOwnerEntry>()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      const bag = ownerSlotPropsBag(node)
      if (!bag) continue
      for (const [propKey, value] of Object.entries(bag)) {
        const slotNodeId = studioSlotNodeId(value)
        if (slotNodeId === undefined) continue
        map.set(slotNodeId, { ownerNodeId: node.id, ownerModuleId: node.moduleId, propKey })
      }
    }
  }
  return map
}

let _cache: { site: SiteDocument; byNodeId: Map<string, SlotOwnerEntry> } | null = null

/** Which node/prop fills its slot with `nodeId`, or `null` when `nodeId` is not slot content. */
export function lookupSlotOwner(site: SiteDocument | null, nodeId: string): SlotOwnerEntry | null {
  if (!site) return null
  if (!_cache || _cache.site !== site) {
    _cache = { site, byNodeId: buildSlotOwners(site) }
  }
  return _cache.byNodeId.get(nodeId) ?? null
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
  nodeIdToPageIds: Map<string, string[]>,
  nodeId: string,
): PageNode | null {
  if (!site) return null
  const pageIds = nodeIdToPageIds.get(nodeId)
  const pageId = pageIds?.[0]
  if (!pageId) return null
  const page = lookupCanvasPageById(site, pageId)
  return page?.nodes[nodeId] ?? null
}
