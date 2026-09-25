/**
 * studioPageLoad — the page-load/parse pipeline backing
 * `GET /admin/api/studio/load?dir=<abs>` (see `server/handlers/studio.ts`'s
 * module doc for the full endpoint contract). Split out of `studio.ts`
 * because this is one coherent unit: turn a project's `pages/` directory
 * (or its `.studio/meta.json` `pagesDir` override) into the parsed, inlined,
 * Studio-shaped `Page[]` the client renders — independent of HTTP routing.
 *
 * `pageIdFromRelPath`/`assignPageIds` turn a page file's path (relative to
 * the workspace's `pages/` dir) into the stable, unique `pageId`/`slug` the
 * multi-page load scan uses. `studio/moduleMapping.ts`'s `resolveModuleId`/
 * `resolveTextProp` (bound as the two converter callbacks below) map a parsed
 * node to an Studio module id and its inline-text-edit prop — they encode the
 * base-module catalogue's rules, not this pipeline's, so they live in their
 * own module. `rewriteStudioAssetSentinels` (`studioAsset.ts`) turns a resolved local-image import into a
 * fetchable `/admin/api/studio/asset` URL. `loadStudioPages` is the per-page
 * parse → inline → convert sequence that ties all of the above together for
 * every discovered page file, sharing one workspace-wide ts-morph `Project`
 * so a page's local-component imports resolve to real files elsewhere in the
 * tree. It also builds one §7 evaluator options bag (`preferredKey` from
 * `.studio/meta.json`'s `previewLocale`, plus a fresh page-wide step budget)
 * per page, passed to BOTH that page's own `parsePageFile` call and its
 * `inlineLocalComponents` call, so a locally-inlined component's own values
 * (e.g. a nested `useLanguage()` call) resolve under the same budget.
 *
 * WS-1.3 — `loadStudioPages` branches on the cached `ProjectProfile.framework`
 * (never a guess): `framework === 'next-app'` routes through
 * `buildAppRouterPageEntries` (route-derived page ids, `RootLayout(SegmentLayout(
 * Page))` composition via `@core/page-parser`'s `composeAppRouterRoute`); every
 * other framework keeps `buildStandardPageEntries`, which is
 * `pageIdFromRelPath`/`assignPageIds`/the original per-page parse loop, moved
 * verbatim into its own function — same inputs, same outputs, byte for byte.
 *
 * WS-2.1/2.2 — `loadStudioPages` runs `styleCompile.ts`'s `compileProjectStyles`
 * BEFORE parsing any route: `import styles from './Card.module.css'`
 * resolution needs `moduleClassMaps` inside the SAME per-page evaluator
 * options bag every other value resolves through. The compiled CSS blob
 * (Tailwind/Sass/PostCSS, rewritten CSS Modules) feeds `loadStudioStyles` as
 * `extraCss`, parsed by the same `cssToStyleRules` engine as a plain import.
 *
 * WS-2.3 — `compiledStyles.vendorCss` rides the same `compileProjectStyles`
 * call but is never parsed/merged into `styleRules` — returned verbatim as
 * `StudioLoadResult.vendorCss`.
 *
 * W5-3 — Storybook is a THIRD producer of route entries, alongside
 * file-per-page and App Router routes. `buildStoryRouteEntries`
 * (`studio/storyPages.ts`) appends one entry per accepted story from the
 * project's `*.stories.*` files, deduped against the page ids already handed
 * out. It costs nothing when a project has no story files — the gate is a
 * filename glob (`storyFilesIn`), and no ts-morph work happens unless it
 * matches something. See `studio/storyDiscovery.ts` for the accepted subset
 * and the named refusals.
 *
 * WS-10 §4.2/§4.4 (Phase 4) — `loadStudioPageInLocale` (bottom of this file)
 * is the single-route sibling: same parse logic, one route, an explicit
 * `preferredKey` override — see its own doc.
 */
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  composeAppRouterRoute,
  createPageEvalBudget,
  cssInJsStylesheet,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ComponentSource,
  type CssInJsTemplate,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { Page } from '@core/page-tree'
import type { Project } from 'ts-morph'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { classIdsForClassName, loadStudioStyles } from './studioCss'
import { probeProject } from './studio/projectProbe'
import { ensureDesignSystemFiles } from './studio/designSystemFiles'
import { ensurePrototypeShell } from './studio/prototypeShell'
import { consistentStamps, digestOf, fileContentDigest } from './studio/loadDigest'
import { viewportPriorityOrder } from './studio/loadPriority'
import { scheduleParseCacheWrites, type RouteCacheScope } from './studio/pageParseCache'
import { parseRouteThroughCache } from './studio/routeParse'
import { memoizedStudioLoad, type ComputedStudioLoad } from './studio/studioLoadMemo'
import { prewarmWorkspaceProgram, withWorkspaceProject, type WorkspaceProjectHandle } from './studio/workspaceProject'
import { collectLoadWarnings } from './studio/loadWarnings'
import { rewriteStudioAssetSentinels } from './studioAsset'
// Re-exported so `loadStudioPages`' own module stays the obvious import site
// for its result shape — see `studioLoadContract.ts` for why they live apart.
export type { StudioLoadOptions, StudioLoadResult } from './studio/studioLoadContract'
import type { StudioLoadOptions, StudioLoadResult } from './studio/studioLoadContract'
import { resolveModuleId, resolveTextProp } from './studio/moduleMapping'
import { compileProjectStyles } from './studio/styleCompile'
import { readStudioMeta } from './studio/studioMeta'
import { styledStyleRuleSources } from './studio/styledStyleRuleSources'
import type { RoutePageEntry } from './studio/routePageEntry'
import { discoverStories, storyFilesIn, type DiscoveredStory } from './studio/storyDiscovery'
import { buildStoryRouteEntries } from './studio/storyPages'
import {
  collectAppRouterLayoutChain,
  discoverAppRouterRoutes,
  discoverPageFiles,
  projectPagesDir,
  projectPreviewLocale,
} from './studioProjects'
import {
  assignAppRouterPageIds,
  assignPageIds,
  slugFromAppRoute,
} from './studioPageIds'

/**
 * W4-4 Phase A — the `extraCss` blob `loadStudioStyles` parses: the compiled
 * Tailwind/Sass/CSS-Modules output, plus every CSS-in-JS template the parse
 * extracted across these routes.
 *
 * They share one bucket on purpose. An `extraCss` rule gets no
 * `StyleRuleSources` entry, so the `kind: 'css'` write-back refuses it as
 * unmapped and `StyleTargetChip` says so — which is exactly the read-only
 * presentation a styled template needs, inherited rather than re-derived.
 *
 * `cssInJsStylesheet` dedupes by class name (content-addressed, so identical
 * name means identical template): one component file is re-parsed once per
 * call site it is inlined at, and per route that inlines it, so a shared
 * `styled.div` legitimately arrives many times.
 */
function cssInJsExtraCss(compiledCss: string, templates: readonly CssInJsTemplate[]): string {
  return [compiledCss, cssInJsStylesheet(templates)].filter(Boolean).join('\n')
}

/** Every CSS-in-JS template these routes contributed — the input to both `cssInJsExtraCss` (render) and `styledStyleRuleSources` (write-back). */
function cssInJsTemplatesOf(entries: readonly RoutePageEntry[]): CssInJsTemplate[] {
  return entries.flatMap((entry) => entry.expanded.cssInJs?.templates ?? [])
}

/**
 * Everything one load's route parses share: the cache scope and the kept
 * `Project` they parse against. Built once per load by {@link routeParseContext}.
 */
interface RouteParseContext {
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
function routeParseContext(
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
 * One route's parse+inline, through the WS-5.5/P6-B cache (`routeParse.ts`).
 * Extracted from `buildStandardPageEntries` (its per-page loop for every
 * non-`next-app` project, WS-1.3) so `loadStudioPageInLocale` (WS-10
 * §4.2/Phase 4) can parse ONE route with a different `preferredKey` without
 * duplicating this.
 */
function parseStandardRouteEntry(context: RouteParseContext, relPath: string, pageId: string, pagesDir: string): RoutePageEntry {
  const { scope, workspace, cssModuleClassMaps } = context
  const { dir, preferredKey } = scope
  const { project } = workspace
  const file = join(pagesDir, ...relPath.split('/'))

  const outcome = parseRouteThroughCache(scope, workspace, relPath, () => {
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

function buildStandardPageEntries(context: RouteParseContext, pagesDir: string): Promise<RoutePageEntry[]> {
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
function parseAppRouterRouteEntry(context: RouteParseContext, relPath: string, route: string, pageId: string, pagesDir: string): RoutePageEntry {
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

function buildAppRouterPageEntries(context: RouteParseContext, pagesDir: string): Promise<RoutePageEntry[]> {
  const routes = discoverAppRouterRoutes(pagesDir)
  const pageIds = assignAppRouterPageIds(routes)
  return parseRoutesInViewportOrder(
    context.scope.dir,
    routes,
    ({ relPath }) => pageIds.get(relPath)!,
    ({ relPath, route }) => parseAppRouterRouteEntry(context, relPath, route, pageIds.get(relPath)!, pagesDir),
  )
}

/**
 * W5-3 — every accepted Storybook story in the project, with its page id
 * guaranteed not to collide with an already-assigned PAGE id.
 *
 * The glob gate comes first and is the whole zero-cost story: a project with
 * no `*.stories.*` file never constructs a scan context, never touches
 * ts-morph, and never allocates. Refusals are dropped here on purpose — the
 * load path has nowhere to show them, and `GET /admin/api/studio/stories`
 * (`studio/storiesRoutes.ts`) is the surface that reports them.
 *
 * `enabled` is `.studio/meta.json`'s `stories.enabled` (absent means on) —
 * the project's explicit off switch, written by
 * `POST /admin/api/studio/stories`.
 *
 * Story ids are derived by `storyDiscovery.ts` (file path + export name) and
 * pages' by `studioPageIds.ts` (file path alone), so the two rules can
 * genuinely produce the same string — `pages/Card.tsx` and
 * `pages/Card.stories.tsx`'s `Stories` export both slug near `card-stories`.
 * The suffix rule is `assignPageIds`': first one wins, later ones get `-2`,
 * `-3`, …, with the PAGE always winning because it was assigned first.
 */
function discoverProjectStories(
  dir: string,
  project: Project,
  pageEntries: readonly RoutePageEntry[],
  enabled: boolean,
): DiscoveredStory[] {
  if (!enabled) return []
  const storyFiles = storyFilesIn(dir)
  if (storyFiles.length === 0) return []

  const taken = new Set(pageEntries.map((entry) => entry.pageId))
  return discoverStories(dir, project, storyFiles).stories.map((story) => {
    if (!taken.has(story.summary.pageId)) {
      taken.add(story.summary.pageId)
      return story
    }
    for (let n = 2; ; n++) {
      const candidate = `${story.summary.pageId}-${n}`
      if (taken.has(candidate)) continue
      taken.add(candidate)
      return { ...story, summary: { ...story.summary, pageId: candidate } }
    }
  })
}

/**
 * Recursively discovers every page/route under `dir`'s pages directory
 * (`projectPagesDir` — `<dir>/pages` by default, or the `.studio/meta.json`
 * `pagesDir` override) and parses EACH into an Studio `Page`. Returns empty
 * results (not an error) when the pages directory doesn't exist yet.
 *
 * ## `options.pageIds` — what a narrowed load actually skips
 *
 * A targeted reload (`GET /load?pageIds=`, driven by `reloadScope.ts`) asks
 * for one or two pages out of forty. Three stages run below, and only one of
 * them can honestly be narrowed:
 *
 *   - **Parse + inline stays project-wide.** `loadStudioStyles` builds the
 *     style registry from EVERY route's imported stylesheets together (shared
 *     files, cascade order, `classIdsByName`), so it needs every route's
 *     parsed tree in hand. Dropping the unrequested ones would shrink
 *     `styleRules` — and the client replaces its registry wholesale from this
 *     response, so the requested page would then render against a registry
 *     missing every rule only its siblings import. That is the exact failure
 *     `canvas-14` fixed; it is not being reintroduced for a parse that
 *     `pageParseCache.ts` already answers from memory (a warm cache — which a
 *     targeted reload always has, by construction — costs one `statSync` per
 *     tracked file per route).
 *   - **Style resolution stays project-wide,** for the same reason, computed
 *     once and reused by every converted page below. This is genuinely global
 *     work, not per-page work being done N times.
 *   - **Convert IS narrowed.** `parsedPageToSitePage` + the asset-sentinel
 *     rewrite walk every node of every page and allocate a whole `Page`
 *     object graph per route, on every call, cached by nothing. That is the
 *     one stage whose cost scales with project size and buys the caller
 *     nothing when it asked for one page — so it now runs only for the
 *     requested ids. All three route producers narrow together (file-per-page,
 *     App Router, W5-3 stories); `stories` itself is still reported IN FULL,
 *     because the route reads it to place board frames and a narrowed reload
 *     must never retract one.
 *
 * An id that matches no route is simply absent from the result; naming the
 * missing ones is the ROUTE's job (`studioLoadResponse.ts`), which is the only
 * layer that knows what the client asked for.
 *
 * Branches on the cached `ProjectProfile.framework` (`meta-04`'s probe),
 * never a guess: `next-app` routes through `buildAppRouterPageEntries`
 * (route-derived ids, `RootLayout(SegmentLayout(Page))` composition); every
 * other framework — including an unprobed project, no `.studio/meta.json`
 * `profile` yet — keeps `buildStandardPageEntries` exactly as it always was.
 *
 * Every page is parsed against one shared, workspace-wide ts-morph `Project`
 * (`workspaceProject.ts`'s kept `createWorkspaceProject`) so a page's local-component imports resolve to
 * real files elsewhere in the tree; `resolveComponentSources` classifies each
 * `kind: 'component'` node as **local** (import resolves inside the
 * workspace) or **package** (an npm dependency, read-only prop surface). The
 * merged classification for every page/route is returned as
 * `componentSources`, keyed by node id.
 *
 * ## Parse order
 *
 * Routes are parsed in viewport order (`loadPriority.ts`) with a yield to the
 * event loop between two, so a cold parse neither makes the visible frames
 * wait on the rest nor blocks every other request while it runs; the result
 * keeps discovery order.
 *
 * ## The memo in front of this
 *
 * `loadStudioPages` is a thin wrapper: the real work below runs only when
 * `studioLoadMemo.ts` says something the last full load was built from moved.
 * Read that module for what it checks and why a narrowed load is
 * served-but-never-stored. What this returns beside the result is what the
 * memo checks: every file the load read, as the stamps it read them at.
 */
async function computeStudioPages(dir: string): Promise<ComputedStudioLoad> {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) {
    return {
      result: { pages: [], componentSources: {}, styleRules: {}, styleRuleSources: {}, styledStyleRuleSources: {}, conditions: [], vendorCss: '', authoredCss: '', stories: [], warnings: [] },
      dependencies: new Map(),
    }
  }

  // The moment this load begins bringing its `Project` in step with the
  // disk — the parse cache's race rule measures "written while we worked"
  // from here (`pageParseCache.ts`).
  const startedAt = Date.now()
  // One shared, workspace-wide ts-morph Project so a page's local
  // component imports resolve to real files elsewhere in the tree —
  // a fresh per-file Project (parsePageFile's own default) can't see
  // across files at all. Kept across loads and synced to the disk by
  // `workspaceProject.ts` — rebuilding it was the whole cost of a resync.
  try {
    return await withWorkspaceProject(dir, (workspace) => computeStudioPagesWith(dir, pagesDir, workspace, startedAt))
  } finally {
    // Both off this load's path, after its response has left: the parses it
    // made reach the disk tier (`pageParseCache.ts`), and — for a load
    // answered from the parse cache, which never built the TypeScript
    // program — the program is built before the first gesture needs it.
    scheduleParseCacheWrites()
    prewarmWorkspaceProgram(dir)
  }
}

/**
 * The load's own dependency set for the memo: every route's recorded stamps,
 * plus the stylesheets the registry read and the two config files every load
 * consults — or `null` when any of it cannot vouch for the result (a route
 * that could not be cached, a file read at two different versions by two
 * routes, a stylesheet that moved while it was read).
 */
function loadDependencies(
  routeEntries: readonly RoutePageEntry[],
  otherFiles: readonly string[],
  scope: RouteCacheScope,
): Map<string, string> | null {
  const dependencies = new Map<string, string>()
  for (const entry of routeEntries) {
    if (!entry.dependencies) return null
    for (const [file, stamp] of entry.dependencies) {
      const seen = dependencies.get(file)
      if (seen !== undefined && seen !== stamp) return null
      dependencies.set(file, stamp)
    }
  }
  const others = consistentStamps(otherFiles, { startedAtMs: scope.startedAt, knownStamp: scope.projectStamp })
  if (!others) return null
  for (const [file, stamp] of others) {
    const seen = dependencies.get(file)
    if (seen !== undefined && seen !== stamp) return null
    dependencies.set(file, stamp)
  }
  return dependencies
}

async function computeStudioPagesWith(
  dir: string,
  pagesDir: string,
  workspace: WorkspaceProjectHandle,
  startedAt: number,
): Promise<ComputedStudioLoad> {
  const { project } = workspace
  // §7.4 — `preferredKey` for a dynamically-indexed dictionary (`translations[lang]`).
  const preferredKey = projectPreviewLocale(dir)
  const meta = readStudioMeta(dir)
  const framework = meta.profile?.framework

  // WS-2.1 — compile Tailwind/Sass/PostCSS/CSS-Modules BEFORE parsing: WS-2.2
  // needs `moduleClassMaps` in hand so `import styles from './Card.module.css'`
  // resolves during the SAME evaluator pass that resolves everything else.
  // Never re-probes (`meta.profile` only) and never persists — this is the
  // read path, same posture as `tryServeStudioProbe`'s GET branch.
  const profile = meta.profile ?? probeProject(dir)
  const { styles: compiledStyles } = await compileProjectStyles(dir, profile)

  const context = routeParseContext(dir, workspace, framework, preferredKey, compiledStyles.moduleClassMaps, startedAt)

  // Parse + inline EVERY route first, then resolve CSS, then convert. The CSS
  // registry is site-wide (pages routinely share a stylesheet), so it has to be
  // complete before any page can turn a `className` into `classIds`.
  const pageEntries = framework === 'next-app'
    ? await buildAppRouterPageEntries(context, pagesDir)
    : await buildStandardPageEntries(context, pagesDir)

  // W5-3 — Storybook stories, appended as ordinary route entries. Guarded by
  // the filename glob FIRST (`storyFilesIn`), so a project without stories
  // pays one directory walk it was already paying and nothing else. Story
  // page ids are deduped against the page ids already in hand — the two
  // producers derive ids from different rules and could otherwise collide.
  const stories = discoverProjectStories(dir, project, pageEntries, meta.stories?.enabled !== false)
  const storyEntries = buildStoryRouteEntries(context.scope, workspace, stories, compiledStyles.moduleClassMaps)
  const routeEntries = [...pageEntries, ...storyEntries]

  const componentSources: Record<string, ComponentSource> = {}
  for (const entry of routeEntries) Object.assign(componentSources, entry.componentSources)

  // §6 — read every stylesheet the pages import, in cascade order, plus the
  // WS-2.1 compiled blob (Tailwind/Sass/PostCSS output, rewritten CSS Modules)
  // and W4-4's CSS-in-JS templates.
  const cssInJsTemplates = cssInJsTemplatesOf(routeEntries)
  const { styleRules, conditions, classIdsByName, sources: styleRuleSources, authoredCss, stylesheetFiles } = await loadStudioStyles(
    routeEntries.map(({ expanded, relFile }) => ({ parsed: expanded, relFile })),
    project,
    dir,
    cssInJsExtraCss(compiledStyles.css, cssInJsTemplates),
    // The inverse of this map is what lets a compiled CSS-Modules rule point
    // back at the `.module.css` it was renamed from — without it every such
    // rule is unmapped, which is what produced "Style not saved to source".
    compiledStyles.moduleClassMaps,
  )
  const resolveClassIds = (className: string): string[] => classIdsForClassName(className, classIdsByName)

  // Every route is converted, even for a narrowed load: the convert is the
  // cheap stage, and converting all of them is what lets `loadStudioPages`
  // memoize this result as the project-wide truth and answer the NEXT load
  // — full or narrowed — without parsing anything.
  const pages = routeEntries.map(({ expanded, pageId, slug, title }) => {
    const page = parsedPageToSitePage(expanded, {
      pageId,
      slug,
      title,
      // Bound over the SITE-WIDE merged `componentSources` (built above, not
      // this route's own) — a node id is unique across the whole load (App
      // Router layout composition aside, which merges into the same map), so
      // one shared lookup is correct for every page.
      resolveModuleId: (node) => resolveModuleId(node, componentSources),
      resolveTextProp,
      resolveClassIds,
    })
    // §5.2 — turn any `studio-asset:` sentinel (resolved image imports) into
    // a real fetchable URL now that `dir` is in scope.
    rewriteStudioAssetSentinels(page, dir)
    return page
  })

  // Only the stories that actually BECAME a page are reported — a story whose
  // materialization degraded to nothing (`buildStoryRouteEntries` skips it)
  // must not get a board frame pointing at a page that does not exist.
  const builtStoryPageIds = new Set(storyEntries.map((entry) => entry.pageId))
  const storySummaries = stories
    .filter((story) => builtStoryPageIds.has(story.summary.pageId))
    .map((story) => story.summary)

  return {
    result: {
      pages,
      componentSources,
      styleRules,
      styleRuleSources,
      // W4-4 Phase B — computed AFTER the registry, from the same templates the
      // stylesheet was built out of, because it maps rule IDS and only
      // `loadStudioStyles` has minted those.
      styledStyleRuleSources: styledStyleRuleSources(styleRules, cssInJsTemplates),
      conditions,
      vendorCss: compiledStyles.vendorCss,
      authoredCss,
      stories: storySummaries,
      warnings: collectLoadWarnings(dir, project, workspace.warnings, routeEntries),
    },
    dependencies: loadDependencies(
      routeEntries,
      [...stylesheetFiles, join(dir, 'tsconfig.json'), join(dir, 'package.json')],
      context.scope,
    ),
  }
}

/** The route files the load would discover now, joined — the memo's route-list check (`studioLoadMemo.ts`, rule 3). */
function routeListing(dir: string): string {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return ''
  return readStudioMeta(dir).profile?.framework === 'next-app'
    ? discoverAppRouterRoutes(pagesDir).map(({ relPath }) => relPath).join('\n')
    : discoverPageFiles(pagesDir).join('\n')
}

/**
 * The memoized load, SHARED with every other caller — the `/load` route's
 * entry point, which only serialises what it gets. Never mutate the result
 * (or anything reachable from it): the next caller receives the same objects.
 * Everyone else uses {@link loadStudioPages}, which hands out a private copy.
 *
 * W9-5 lever 1: one real load per turn. An agent turn loads from the live
 * digest, `studio_compare`, `studio_screenshot`, `studio_quality_check` and
 * the fidelity tools, all against a project that did not change between them.
 * `pageParseCache.ts` already answered the per-route parses; the memo answers
 * everything around them (the workspace ts-morph project, the style compile,
 * the directory walks, the site-wide style registry, the per-page convert).
 *
 * A narrowed load is SERVED from a stored full result (its `pages` filtered to
 * the requested ids — exactly what a narrowed compute returns) but never
 * STORED, because it never computed the routes it was not asked for.
 */
export async function loadStudioPagesShared(dir: string, options: StudioLoadOptions = {}): Promise<Readonly<StudioLoadResult>> {
  // Scaffold (or refresh) the runnable preview shell — `prototype/`,
  // `index.html`, `vite.config.js`. A workspace created before the shell
  // existed grows one the first time it is opened, and every later open brings
  // the two `.generated` files back in step with `.studio/`.
  //
  // BEFORE the memo, deliberately. `workspaceLoadFingerprint` covers the
  // user's SOURCE, not `.studio/boards.json` — so creating a board is a memo
  // HIT, and a regeneration placed inside `computeStudioPages` would be
  // skipped exactly when the boards it reads have changed. It never throws and
  // writes nothing when nothing changed.
  ensurePrototypeShell(dir)
  // And the design system this project carries a copy of, for the same reason
  // and in the same place: a project whose `design-system/` folder is stale
  // relative to Studio's own vendored copy is one whose canvas and whose
  // `npm run dev` disagree. A no-op unless `.studio/meta.json` says this
  // project is design-system-backed AND the content hash has moved; never
  // throws. See `./studio/designSystemFiles.ts`.
  ensureDesignSystemFiles(dir)

  // Always the full result, always memoized — a narrowed load is the SAME
  // compute with fewer pages returned, so storing it costs nothing extra and
  // means the full load that follows a canvas resync is a memo hit.
  const result = await memoizedStudioLoad(dir, {
    compute: () => computeStudioPages(dir),
    routeListing: () => routeListing(dir),
  })
  return narrowLoadResult(result, options.pageIds)
}

/**
 * The memoized entry point every caller but the `/load` route uses — see
 * `computeStudioPages` above for what the load itself does, and
 * `studio/studioLoadMemo.ts` for what makes a memo hit valid. Returns a
 * private copy the caller may mutate freely (`loadStudioPages` itself
 * rewrote asset sentinels in place once, and a tool's edit must never become
 * the next tool's input).
 */
export async function loadStudioPages(dir: string, options: StudioLoadOptions = {}): Promise<StudioLoadResult> {
  return structuredClone(await loadStudioPagesShared(dir, options))
}

/** The `options.pageIds` filter, applied to a computed FULL result. */
function narrowLoadResult(result: Readonly<StudioLoadResult>, pageIds: readonly string[] | undefined): Readonly<StudioLoadResult> {
  if (!pageIds) return result
  const wanted = new Set(pageIds)
  return { ...result, pages: result.pages.filter((page) => wanted.has(page.id)) }
}

/**
 * WS-10 §4.2/§4.4 (Phase 4) — `(dir, pageId, locale) → Page | null`, parsing
 * JUST that one route under an EXPLICIT `preferredKey` override, never the
 * whole project. `null` when `pageId` doesn't exist (never throws) — the
 * caller (`localizedPageSlice.ts`) falls back to the default tree (§7.4
 * degrade-honestly). Reuses `parseStandardRouteEntry`/`parseAppRouterRouteEntry`
 * — the SAME logic every route already runs, for one route with `locale` as
 * `preferredKey`. `configHash` already includes `preferredKey`, so this
 * naturally gets its OWN on-disk cache entry (`pageParseCache.ts`) rather
 * than colliding with the default parse.
 *
 * Reuses the site-wide COMPILED CSS (cached) but computes `classIdsByName`
 * scoped to just this route — locale never changes which stylesheets a page
 * imports, only which dictionary branch a TEXT prop reads. `styleRuleId` is
 * content-hash deterministic (not sequential) over `kind|name|file`, so a
 * narrower scan's ids are byte-identical to the site-wide registry's — but
 * ONLY if it's given the SAME `moduleClassMaps` the full load used, because
 * that map is what lets a compiled CSS-Modules rule resolve back to the
 * `file` half of that hash (see `loadStudioStyles`'s call below, and
 * `cssModuleSource` in `studioCss.ts`). Drop the map and every such rule
 * hashes on `''` instead of its real path — a DIFFERENT id from the one the
 * client's already-loaded `site.styleRules` used, so the frame renders
 * completely unstyled. That exact regression shipped once; keep the two
 * `loadStudioStyles` call sites' 5th argument in sync.
 *
 * Known limitation, not solved here: a `.map()` array whose LENGTH differs
 * by locale would give the variant a different expanded-node COUNT than the
 * default tree — trap #2 still holds, but the two trees would disagree on
 * which suffixed ids exist for that subtree. Not observed on the real eSIM
 * corpus; flagged rather than assumed away.
 */
export async function loadStudioPageInLocale(dir: string, pageId: string, locale: string): Promise<Page | null> {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return null
  const startedAt = Date.now()
  return withWorkspaceProject(dir, (workspace) => loadStudioPageInLocaleWith(dir, pagesDir, workspace, pageId, locale, startedAt))
}

async function loadStudioPageInLocaleWith(
  dir: string,
  pagesDir: string,
  workspace: WorkspaceProjectHandle,
  pageId: string,
  locale: string,
  startedAt: number,
): Promise<Page | null> {
  const { project } = workspace
  const meta = readStudioMeta(dir)
  const framework = meta.profile?.framework
  const profile = meta.profile ?? probeProject(dir)
  const { styles: compiledStyles } = await compileProjectStyles(dir, profile)
  const context = routeParseContext(dir, workspace, framework, locale, compiledStyles.moduleClassMaps, startedAt)

  let entry: RoutePageEntry | undefined
  if (framework === 'next-app') {
    const routes = discoverAppRouterRoutes(pagesDir)
    const pageIds = assignAppRouterPageIds(routes)
    const match = routes.find(({ relPath }) => pageIds.get(relPath) === pageId)
    if (match) entry = parseAppRouterRouteEntry(context, match.relPath, match.route, pageId, pagesDir)
  } else {
    const relPaths = discoverPageFiles(pagesDir)
    const pageIds = assignPageIds(relPaths)
    const relPath = relPaths.find((rp) => pageIds.get(rp) === pageId)
    if (relPath) entry = parseStandardRouteEntry(context, relPath, pageId, pagesDir)
  }
  if (!entry) return null
  const { expanded, componentSources } = entry

  // Scoped (this route only) style resolution. `styleRuleId` bakes the
  // AUTHORING FILE into the id (see its own doc), so a CSS-Modules rule's id
  // is only consistent with the full-load registry if this call passes the
  // SAME `moduleClassMaps` the full load does — that map is what lets
  // `cssModuleSource` attribute a compiled class back to the `.module.css`
  // it was renamed from. Omit it and `cssModuleSource` can't resolve a file,
  // so every such rule silently re-mints under `''` instead of its real path
  // — a DIFFERENT id than the one the client's already-loaded site-wide
  // `site.styleRules` used. The client keeps `site.styleRules` from the full
  // load and only patches this call's tree + `classIdsByName` in
  // (`ensureLocalizedPage`), so an id mismatch here doesn't error — it just
  // fails to resolve any class name, and the frame renders completely
  // unstyled (this was a real, reproduced bug, not a hypothetical).
  const { classIdsByName } = await loadStudioStyles(
    [{ parsed: expanded, relFile: entry.relFile }],
    project,
    dir,
    cssInJsExtraCss(compiledStyles.css, cssInJsTemplatesOf([entry])),
    compiledStyles.moduleClassMaps,
  )
  const resolveClassIds = (className: string): string[] => classIdsForClassName(className, classIdsByName)

  const page = parsedPageToSitePage(expanded, {
    pageId: entry.pageId,
    slug: entry.slug,
    title: entry.title,
    resolveModuleId: (node) => resolveModuleId(node, componentSources),
    resolveTextProp,
    resolveClassIds,
  })
  rewriteStudioAssetSentinels(page, dir)
  return page
}
