/**
 * canvasLayerLoad — the free canvas's half of a Studio load (P5-G, FC-1):
 * every `.studio/canvas/<id>.tsx` layer module, parsed exactly like a page.
 *
 * ## Parsed like a page, returned apart from pages
 *
 * A loose layer's content has to resolve the way it would inside a frame —
 * the same evaluator, the same local-component inlining, the same stylesheet
 * registry — or dragging it into a frame would change what it looks like. So
 * each module goes through `parseRouteFileThroughCache` (`routeEntryParse.ts`), the one per-file parse every
 * file-per-page route uses, and joins the load's style pass
 * (`studioPageLoad.ts` feeds these entries to `loadStudioStyles`, so a CSS
 * Module a layer imports is registered and renders on the canvas).
 *
 * What it never does is join `pages`. The result travels in its own field,
 * `StudioLoadResult.canvasLayers`, which is how every surface that lists,
 * publishes, previews or shares PAGES stays blind to it by construction
 * (design §6.1). Its page id is `canvas:<id>` — a shape no route-derived id
 * can take — so even a consumer that confused the two would not collide.
 *
 * ## Parse, never execute
 *
 * Tier 0 parses; nothing here runs the module. The discovery is
 * `canvasLayerFiles.ts`'s, which refuses a `.studio/canvas` that is a link.
 */
import { join } from 'node:path'
import { canvasLayerPageId, canvasLayerRelPath, type CanvasLayerId } from '@core/studio-board'
import { listCanvasLayerIds } from './canvasLayerFiles'
import { parseRouteFileThroughCache, type RouteParseContext } from './routeEntryParse'
import type { RoutePageEntry } from './routePageEntry'

/** One layer module, parsed, in the shape the load's style and convert passes take. */
export interface CanvasLayerRouteEntry extends RoutePageEntry {
  layerId: CanvasLayerId
}

/** The parse-cache key a layer module is stored under. Never a page's `relPath` shape, so `reloadScope.ts` can tell them apart. */
export function canvasLayerCacheRoute(id: CanvasLayerId): string {
  return `canvas-layer:${id}`
}

/** The layer id a parse-cache route key names, or `null` for a page or story route. */
export function canvasLayerIdFromCacheRoute(route: string): CanvasLayerId | null {
  const match = /^canvas-layer:(cl[a-z0-9]{10})$/.exec(route)
  return match ? (match[1] as CanvasLayerId) : null
}

export function buildCanvasLayerEntries(dir: string, context: RouteParseContext): CanvasLayerRouteEntry[] {
  const entries: CanvasLayerRouteEntry[] = []
  for (const layerId of listCanvasLayerIds(dir)) {
    const relFile = canvasLayerRelPath(layerId)
    try {
      const outcome = parseRouteFileThroughCache(context, canvasLayerCacheRoute(layerId), join(dir, ...relFile.split('/')))
      const pageId = canvasLayerPageId(layerId)
      entries.push({
        layerId,
        expanded: outcome.result.expanded,
        componentSources: outcome.result.componentSources,
        dependencies: outcome.dependencies,
        pageId,
        slug: pageId,
        title: layerId,
        relFile,
      })
    } catch (err) {
      // A module edited outside Studio into something the parser cannot read
      // is left off the board rather than failing the whole load; its
      // placement stays in boards.json, so fixing the file brings it back.
      console.error('[studio:canvasLayerLoad]', relFile, err)
    }
  }
  return entries
}
