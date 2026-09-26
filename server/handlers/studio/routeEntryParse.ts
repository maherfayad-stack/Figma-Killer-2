/**
 * routeEntryParse — one discovered route to one parsed `RoutePageEntry`, for
 * the two file-based route producers: file-per-page (`parseStandardRouteEntry`)
 * and Next App Router (`parseAppRouterRouteEntry`, a page composed with its
 * layout chain). Split out of `studioPageLoad.ts`, which orchestrates the
 * whole load; this module is the per-route half it and
 * `loadStudioPageInLocale` both call.
 *
 * Every parse here goes through the route parse cache (`routeParse.ts`) and
 * builds the §7 evaluator options bag the parser runs under — which is why
 * `parserCodeDigest.ts` lists this file: a change to the options handed to
 * the parser changes what a cached parse holds. `build*PageEntries` parse in
 * viewport order (`loadPriority.ts`), yielding to the event loop between two
 * routes, and return entries in discovery order.
 */
import { join, relative, resolve, sep } from 'node:path'
import {
  composeAppRouterRoute,
  createPageEvalBudget,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type StaticEvalOptions,
} from '@core/page-parser'
import { collectAppRouterLayoutChain, discoverAppRouterRoutes, discoverPageFiles } from '../studioProjects'
import { assignAppRouterPageIds, assignPageIds, slugFromAppRoute } from '../studioPageIds'
import { digestOf, fileContentDigest } from './loadDigest'
import { viewportPriorityOrder } from './loadPriority'
import type { RouteCacheScope } from './pageParseCache'
import type { RoutePageEntry } from './routePageEntry'
import { parseRouteThroughCache, type RouteParseOutcome } from './routeParse'
import type { WorkspaceProjectHandle } from './workspaceProject'

/**
 * Everything one load's route parses share: the cache scope and the kept
 * `Project` they parse against. Built once per load by {@link routeParseContext}.
 */
export interface RouteParseContext {
  scope: RouteCacheScope
  workspace: WorkspaceProjectHandle
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined
}

/**
 * WS-5.5 — everything besides the files a parse read that feeds it: a changed
 * framework classification, preview locale, or compiled CSS-Modules class map
 * invalidates every route's cache entry at once (`pageParseCache.ts`'s doc
 * explains why a per-file check alone can't catch this). The tsconfig's
 * CONTENT joins them: its path aliases decide which file every aliased import
 * resolves to (WB-23), and a content digest — not a stamp — is what the disk
 * tier can compare across processes. The project directory joins them so an
 * entry never outlives a move. SHA-256 throughout (P6-B): the 32-bit hash it
 * replaced could be collided by two strings as short as `Aa` and `BB`.
 */
export function routeParseContext(
  dir: string,
  workspace: WorkspaceProjectHandle,
  framework: string | undefined,
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  startedAt: number,
): RouteParseContext {
  // A tsconfig being rewritten this instant has no digest; this load then
  // gets a config hash nothing matches, and parses afresh.
  // A missing tsconfig is an ordinary answer (`null`), distinct from one mid-write (`undefined`).
  const tsconfigDigest = fileContentDigest(join(dir, 'tsconfig.json'))
  const tsconfig = tsconfigDigest === undefined ? `unsettled:${startedAt}` : tsconfigDigest.digest
  const configHash = digestOf([resolve(dir), framework ?? null, preferredKey ?? null, cssModuleClassMaps ?? null, tsconfig])
  return {
    scope: { dir, configHash, preferredKey, startedAt, projectStamp: workspace.recordedStamp },
    workspace,
    cssModuleClassMaps,
  }
}

/** Lets other requests run between two route parses — a cold parse of a large project is seconds of synchronous work otherwise. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield))
}

/**
 * ONE file whose default export is a page-shaped tree — its parse+inline,
 * through the WS-5.5/P6-B cache under `route` (`routeParse.ts`). A
 * file-per-page route and a free-canvas layer module (P5-G,
 * `canvasLayerLoad.ts`) are both exactly this, so they share it: a layer
 * renders what a page holding the same JSX would render.
 */
export function parseRouteFileThroughCache(context: RouteParseContext, route: string, file: string): RouteParseOutcome {
  const { scope, workspace, cssModuleClassMaps } = context
  const { dir, preferredKey } = scope
  const { project } = workspace
  const outcome = parseRouteThroughCache(scope, workspace, route, () => {
    // §7 — one evaluator options bag PER PAGE, shared between this page's
    // own parse and every locally-inlined subtree's parse below, so the
    // page-wide step budget (and the module-namespace memo cache inside
    // staticEval.ts) covers the whole page's worth of value resolution,
    // not just one call. `workspaceRoot` enables `?raw` text-import
    // resolution (inline SVG icons). `cssModuleClassMaps` (WS-2.2) is
    // `styleCompile.ts`'s compiled output — enables `import styles from
    // './Card.module.css'` -> `styles.card`. `readFiles` (WB-2) collects
    // every file a VALUE was read out of — a dictionary, a cross-file const, a
    // provider, a `?raw` icon — so the cache below invalidates on them too.
    const readFiles = new Set<string>()
    const evalOptions: StaticEvalOptions = { preferredKey, pageBudget: createPageEvalBudget(), workspaceRoot: dir, cssModuleClassMaps, readFiles }
    const parsed = parsePageFile(file, dir, project, evalOptions)
    // `resolveComponentSources` MUST run on the pre-inline tree — it keys
    // off call-site node ids, which only exist before splicing (§2.6).
    // Nested local components discovered while expanding a sub-tree are
    // resolved fresh, inside `inlineLocalComponents` itself, against that
    // sub-tree's own file.
    const sources = resolveComponentSources(project, file, dir, parsed)
    // `dependencyFiles` collects the TRANSITIVE local-component set —
    // `inlineLocalComponents` populates it at every nesting level, not just
    // the direct call sites `sources` classified. See its own doc for why
    // this closes the "a component three levels deep changed and this route's
    // cache never noticed" gap `pageParseCache.ts` used to have.
    const dependencyFiles = new Set<string>()
    const expanded = inlineLocalComponents(parsed, sources, project, dir, { evalOptions, dependencyFiles })
    return { result: { expanded, componentSources: sources }, dependencyFiles: [file, ...dependencyFiles, ...readFiles] }
  })!
  return outcome
}

/**
 * One route's parse+inline, through the WS-5.5/P6-B cache (`routeParse.ts`).
 * Extracted from `buildStandardPageEntries` (its per-page loop for every
 * non-`next-app` project, WS-1.3) so `loadStudioPageInLocale` (WS-10
 * §4.2/Phase 4) can parse ONE route with a different `preferredKey` without
 * duplicating this.
 */
export function parseStandardRouteEntry(context: RouteParseContext, relPath: string, pageId: string, pagesDir: string): RoutePageEntry {
  const { dir } = context.scope
  const file = join(pagesDir, ...relPath.split('/'))

  const outcome = parseRouteFileThroughCache(context, relPath, file)

  return {
    expanded: outcome.result.expanded,
    pageId,
    slug: pageId,
    title: relPath.split('/').pop()!.replace(/\.(tsx|jsx)$/, ''),
    relFile: relative(dir, file).split(sep).join('/'),
    componentSources: outcome.result.componentSources,
    dependencies: outcome.dependencies,
  }
}

/**
 * Parses `routes` in the order a person sees them (`loadPriority.ts`),
 * yielding between routes, and returns their entries in DISCOVERY order — the
 * page order the rest of the load, and the Pages panel, is built on.
 */
async function parseRoutesInViewportOrder<TRoute>(
  dir: string,
  routes: readonly TRoute[],
  pageIdOf: (route: TRoute) => string,
  parse: (route: TRoute) => RoutePageEntry,
): Promise<RoutePageEntry[]> {
  const byPageId = new Map(routes.map((route) => [pageIdOf(route), route]))
  const entries = new Map<string, RoutePageEntry>()
  for (const pageId of viewportPriorityOrder(dir, [...byPageId.keys()])) {
    if (entries.size > 0) await yieldToEventLoop()
    entries.set(pageId, parse(byPageId.get(pageId)!))
  }
  return routes.map((route) => entries.get(pageIdOf(route))!)
}

export function buildStandardPageEntries(context: RouteParseContext, pagesDir: string): Promise<RoutePageEntry[]> {
  const relPaths = discoverPageFiles(pagesDir)
  const pageIds = assignPageIds(relPaths)
  return parseRoutesInViewportOrder(
    context.scope.dir,
    relPaths,
    (relPath) => pageIds.get(relPath)!,
    (relPath) => parseStandardRouteEntry(context, relPath, pageIds.get(relPath)!, pagesDir),
  )
}

/**
 * WS-1.3 — one App Router ROUTE (`page.tsx`), composed with its layout chain
 * via `@core/page-parser`'s `composeAppRouterRoute` (its own doc explains
 * ordering). WS-5.5's cache key covers the composed result and every layout
 * file in the chain — editing a shared `layout.tsx` invalidates every route
 * beneath it. Extracted from `buildAppRouterPageEntries`'s per-route loop
 * for the same reason `parseStandardRouteEntry` is (WS-10 §4.2/Phase 4) —
 * pure extraction, behavior unchanged byte for byte.
 */
export function parseAppRouterRouteEntry(context: RouteParseContext, relPath: string, route: string, pageId: string, pagesDir: string): RoutePageEntry {
  const { scope, workspace, cssModuleClassMaps } = context
  const { dir, preferredKey } = scope
  const { project } = workspace
  const file = join(pagesDir, ...relPath.split('/'))
  const layoutAbsFiles = collectAppRouterLayoutChain(pagesDir, relPath).map((relLayoutPath) =>
    join(pagesDir, ...relLayoutPath.split('/')),
  )

  const outcome = parseRouteThroughCache(scope, workspace, relPath, () => {
    const readFiles = new Set<string>()
    const evalOptions: StaticEvalOptions = { preferredKey, pageBudget: createPageEvalBudget(), workspaceRoot: dir, cssModuleClassMaps, readFiles }

    const parsed = parsePageFile(file, dir, project, evalOptions)
    const pageSources = resolveComponentSources(project, file, dir, parsed)
    // See `parseStandardRouteEntry`'s matching comment — this is the page's
    // own transitive local-component set. The layout chain's own (also
    // transitive, WS-1.3-composed) set comes back on `composed.dependencyFiles`.
    const pageDependencyFiles = new Set<string>()
    const pageExpanded = inlineLocalComponents(parsed, pageSources, project, dir, { evalOptions, dependencyFiles: pageDependencyFiles })

    const composed = composeAppRouterRoute({
      page: pageExpanded,
      pageAbsFile: file,
      layoutAbsFiles,
      project,
      workspaceRoot: dir,
      evalOptions,
    })
    return {
      result: { expanded: composed.page, componentSources: { ...pageSources, ...composed.componentSources } },
      dependencyFiles: [file, ...layoutAbsFiles, ...pageDependencyFiles, ...composed.dependencyFiles, ...readFiles],
    }
  })!

  return {
    expanded: outcome.result.expanded,
    pageId,
    slug: slugFromAppRoute(route),
    title: route,
    relFile: relative(dir, file).split(sep).join('/'),
    componentSources: outcome.result.componentSources,
    dependencies: outcome.dependencies,
  }
}

export function buildAppRouterPageEntries(context: RouteParseContext, pagesDir: string): Promise<RoutePageEntry[]> {
  const routes = discoverAppRouterRoutes(pagesDir)
  const pageIds = assignAppRouterPageIds(routes)
  return parseRoutesInViewportOrder(
    context.scope.dir,
    routes,
    ({ relPath }) => pageIds.get(relPath)!,
    ({ relPath, route }) => parseAppRouterRouteEntry(context, relPath, route, pageIds.get(relPath)!, pagesDir),
  )
}
