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
 * own module. `rewriteStudioAssetSentinels` turns a resolved local-image import into a
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
import { join, relative, sep } from 'node:path'
import {
  composeAppRouterRoute,
  createPageEvalBudget,
  createWorkspaceProject,
  cssInJsStylesheet,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  STUDIO_ASSET_SENTINEL,
  type ComponentSource,
  type CssInJsTemplate,
  type ParsedPage,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { Page } from '@core/page-tree'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { classIdsForClassName, loadStudioStyles } from './studioCss'
import { probeProject } from './studio/projectProbe'
import { ensurePrototypeShell } from './studio/prototypeShell'
import {
  getCachedRouteParse,
  hashWorkspaceConfig,
  localSourceAbsFiles,
  setCachedRouteParse,
} from './studio/pageParseCache'
import { getMemoizedStudioLoad, setMemoizedStudioLoad, workspaceLoadFingerprint } from './studio/studioLoadMemo'
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
 * Rewrites every `studio-asset:<workspace-rel>` sentinel prop value (§5.1 —
 * `parsePageFile`'s image-import resolution) into a URL the browser can
 * actually fetch: `/admin/api/studio/asset?dir=<encoded>&path=<encoded>`.
 *
 * Lives here (the page-load pipeline), not in `@core/page-parser` or
 * `@core/studio-sync/parsedPageToSitePage` (§5.2's other option): turning a
 * workspace-relative path into a URL is a route-shape decision — the query
 * param names, the endpoint path itself — that belongs with the endpoint that
 * owns that shape (`/admin/api/studio/asset`, `server/handlers/studioAsset.ts`),
 * not with the pure page-tree converter, which has no notion of `dir` or HTTP
 * routing at all today. Keeping it here means a future route change never
 * touches the parser or the converter.
 *
 * Mutates `page.nodes` in place — the pages array was just built fresh by
 * `parsedPageToSitePage` for this same request, so there is no shared/cached
 * object to accidentally corrupt.
 */
function rewriteStudioAssetSentinels(page: Page, dir: string): void {
  const dirParam = encodeURIComponent(dir)
  for (const node of Object.values(page.nodes)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'string' && value.startsWith(STUDIO_ASSET_SENTINEL)) {
        const relPath = value.slice(STUDIO_ASSET_SENTINEL.length)
        node.props[key] = `/admin/api/studio/asset?dir=${dirParam}&path=${encodeURIComponent(relPath)}`
      }
    }
  }
}

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
 * One route's parse+inline (WS-5.5 caches the expensive step, keyed by the
 * route's own file plus every local component file it resolved —
 * `pageParseCache.ts`). Extracted from `buildStandardPageEntries` (its
 * per-page loop for every non-`next-app` project, WS-1.3) so
 * `loadStudioPageInLocale` (WS-10 §4.2/Phase 4) can parse ONE route with a
 * different `preferredKey` without duplicating this. Pure extraction —
 * `buildStandardPageEntries`'s own behavior is unchanged byte for byte.
 */
function parseStandardRouteEntry(
  relPath: string,
  pageId: string,
  pagesDir: string,
  dir: string,
  project: ReturnType<typeof createWorkspaceProject>,
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  configHash: string,
): RoutePageEntry {
  const file = join(pagesDir, ...relPath.split('/'))
  const cacheKey = `${dir}::${relPath}`

  const cached = getCachedRouteParse(cacheKey, configHash)
  let expanded: ParsedPage
  let sources: Record<string, ComponentSource>
  if (cached) {
    expanded = cached.expanded
    sources = cached.componentSources
  } else {
    // §7 — one evaluator options bag PER PAGE, shared between this page's
    // own parse and every locally-inlined subtree's parse below, so the
    // page-wide step budget (and the module-namespace memo cache inside
    // staticEval.ts) covers the whole page's worth of value resolution,
    // not just one call. `workspaceRoot` enables `?raw` text-import
    // resolution (inline SVG icons). `cssModuleClassMaps` (WS-2.2) is
    // `styleCompile.ts`'s compiled output — enables `import styles from
    // './Card.module.css'` -> `styles.card`.
    const evalOptions: StaticEvalOptions = { preferredKey, pageBudget: createPageEvalBudget(), workspaceRoot: dir, cssModuleClassMaps }
    const parsed = parsePageFile(file, dir, project, evalOptions)
    // `resolveComponentSources` MUST run on the pre-inline tree — it keys
    // off call-site node ids, which only exist before splicing (§2.6).
    // Nested local components discovered while expanding a sub-tree are
    // resolved fresh, inside `inlineLocalComponents` itself, against that
    // sub-tree's own file.
    sources = resolveComponentSources(project, file, dir, parsed)
    expanded = inlineLocalComponents(parsed, sources, project, dir, { evalOptions })
    setCachedRouteParse(cacheKey, configHash, [file, ...localSourceAbsFiles(sources, dir)], {
      expanded,
      componentSources: sources,
    })
  }

  return {
    expanded,
    pageId,
    slug: pageId,
    title: relPath.split('/').pop()!.replace(/\.(tsx|jsx)$/, ''),
    relFile: relative(dir, file).split(sep).join('/'),
    componentSources: sources,
  }
}

function buildStandardPageEntries(
  pagesDir: string,
  dir: string,
  project: ReturnType<typeof createWorkspaceProject>,
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  configHash: string,
): RoutePageEntry[] {
  const relPaths = discoverPageFiles(pagesDir)
  const pageIds = assignPageIds(relPaths)

  return relPaths.map((relPath) =>
    parseStandardRouteEntry(relPath, pageIds.get(relPath)!, pagesDir, dir, project, preferredKey, cssModuleClassMaps, configHash),
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
function parseAppRouterRouteEntry(
  relPath: string,
  route: string,
  pageId: string,
  pagesDir: string,
  dir: string,
  project: ReturnType<typeof createWorkspaceProject>,
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  configHash: string,
): RoutePageEntry {
  const file = join(pagesDir, ...relPath.split('/'))
  const cacheKey = `${dir}::${relPath}`
  const layoutAbsFiles = collectAppRouterLayoutChain(pagesDir, relPath).map((relLayoutPath) =>
    join(pagesDir, ...relLayoutPath.split('/')),
  )

  const cached = getCachedRouteParse(cacheKey, configHash)
  let expanded: ParsedPage
  let sources: Record<string, ComponentSource>
  if (cached) {
    expanded = cached.expanded
    sources = cached.componentSources
  } else {
    const evalOptions: StaticEvalOptions = { preferredKey, pageBudget: createPageEvalBudget(), workspaceRoot: dir, cssModuleClassMaps }

    const parsed = parsePageFile(file, dir, project, evalOptions)
    const pageSources = resolveComponentSources(project, file, dir, parsed)
    const pageExpanded = inlineLocalComponents(parsed, pageSources, project, dir, { evalOptions })

    const composed = composeAppRouterRoute({
      page: pageExpanded,
      pageAbsFile: file,
      layoutAbsFiles,
      project,
      workspaceRoot: dir,
      evalOptions,
    })
    expanded = composed.page
    sources = { ...pageSources, ...composed.componentSources }
    setCachedRouteParse(
      cacheKey,
      configHash,
      [file, ...layoutAbsFiles, ...localSourceAbsFiles(sources, dir)],
      { expanded, componentSources: sources },
    )
  }

  return {
    expanded,
    pageId,
    slug: slugFromAppRoute(route),
    title: route,
    relFile: relative(dir, file).split(sep).join('/'),
    componentSources: sources,
  }
}

function buildAppRouterPageEntries(
  pagesDir: string,
  dir: string,
  project: ReturnType<typeof createWorkspaceProject>,
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  configHash: string,
): RoutePageEntry[] {
  const routes = discoverAppRouterRoutes(pagesDir)
  const pageIds = assignAppRouterPageIds(routes)

  return routes.map(({ relPath, route }) =>
    parseAppRouterRouteEntry(relPath, route, pageIds.get(relPath)!, pagesDir, dir, project, preferredKey, cssModuleClassMaps, configHash),
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
  project: ReturnType<typeof createWorkspaceProject>,
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
 * (`createWorkspaceProject`) so a page's local-component imports resolve to
 * real files elsewhere in the tree; `resolveComponentSources` classifies each
 * `kind: 'component'` node as **local** (import resolves inside the
 * workspace) or **package** (an npm dependency, read-only prop surface). The
 * merged classification for every page/route is returned as
 * `componentSources`, keyed by node id.
 *
 * ## The memo in front of this
 *
 * `loadStudioPages` is a thin wrapper: the real work below runs only when
 * `studioLoadMemo.ts` says the workspace changed since the last full load.
 * Read that module for what the fingerprint covers and why a narrowed load is
 * served-but-never-stored.
 */
async function computeStudioPages(dir: string, options: StudioLoadOptions): Promise<StudioLoadResult> {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) {
    return { pages: [], componentSources: {}, styleRules: {}, styleRuleSources: {}, styledStyleRuleSources: {}, conditions: [], vendorCss: '', authoredCss: '', stories: [] }
  }

  // One shared, workspace-wide ts-morph Project so a page's local
  // component imports resolve to real files elsewhere in the tree —
  // a fresh per-file Project (parsePageFile's own default) can't see
  // across files at all. See createWorkspaceProject's doc comment.
  const project = createWorkspaceProject(dir)
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

  // WS-5.5 — everything besides per-file mtimes that feeds the parse/eval
  // pass below: a changed framework classification, preview locale, or
  // compiled CSS-Modules class map invalidates every route's cache entry at
  // once (`pageParseCache.ts`'s own doc explains why a per-file mtime alone
  // can't catch this).
  const configHash = hashWorkspaceConfig([framework, preferredKey, compiledStyles.moduleClassMaps])

  // Parse + inline EVERY route first, then resolve CSS, then convert. The CSS
  // registry is site-wide (pages routinely share a stylesheet), so it has to be
  // complete before any page can turn a `className` into `classIds`.
  const pageEntries = framework === 'next-app'
    ? buildAppRouterPageEntries(pagesDir, dir, project, preferredKey, compiledStyles.moduleClassMaps, configHash)
    : buildStandardPageEntries(pagesDir, dir, project, preferredKey, compiledStyles.moduleClassMaps, configHash)

  // W5-3 — Storybook stories, appended as ordinary route entries. Guarded by
  // the filename glob FIRST (`storyFilesIn`), so a project without stories
  // pays one directory walk it was already paying and nothing else. Story
  // page ids are deduped against the page ids already in hand — the two
  // producers derive ids from different rules and could otherwise collide.
  const stories = discoverProjectStories(dir, project, pageEntries, meta.stories?.enabled !== false)
  const storyEntries = buildStoryRouteEntries(dir, project, stories, preferredKey, compiledStyles.moduleClassMaps, configHash)
  const routeEntries = [...pageEntries, ...storyEntries]

  const componentSources: Record<string, ComponentSource> = {}
  for (const entry of routeEntries) Object.assign(componentSources, entry.componentSources)

  // §6 — read every stylesheet the pages import, in cascade order, plus the
  // WS-2.1 compiled blob (Tailwind/Sass/PostCSS output, rewritten CSS Modules)
  // and W4-4's CSS-in-JS templates.
  const cssInJsTemplates = cssInJsTemplatesOf(routeEntries)
  const { styleRules, conditions, classIdsByName, sources: styleRuleSources, authoredCss } = await loadStudioStyles(
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

  // The one narrowable stage — see this function's `options.pageIds` doc.
  const requestedPageIds = options.pageIds ? new Set(options.pageIds) : null
  const convertedEntries = requestedPageIds
    ? routeEntries.filter(({ pageId }) => requestedPageIds.has(pageId))
    : routeEntries

  const pages = convertedEntries.map(({ expanded, pageId, slug, title }) => {
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
  }
}

/**
 * The memoized entry point every caller uses — see `computeStudioPages` above
 * for what the load itself does, and `studio/studioLoadMemo.ts` for what makes
 * a memo hit valid.
 *
 * W9-5 lever 1: one real load per turn. An agent turn calls this from the live
 * digest, `studio_compare`, `studio_screenshot`, `studio_quality_check` and
 * the fidelity tools, all against a project that did not change between them.
 * `pageParseCache.ts` already answered the per-route parses from memory; this
 * answers everything around them (the workspace ts-morph project, the style
 * compile, the directory walks, the site-wide style registry, the per-page
 * convert) — measured 26 ms → 2.5 ms per repeat call on a 36-page project.
 *
 * A narrowed load is SERVED from a stored full result (its `pages` filtered to
 * the requested ids — exactly what a narrowed compute returns) but never
 * STORED, because it never computed the routes it was not asked for.
 */
export async function loadStudioPages(dir: string, options: StudioLoadOptions = {}): Promise<StudioLoadResult> {
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

  const fingerprint = workspaceLoadFingerprint(dir)
  const memoized = getMemoizedStudioLoad(dir, fingerprint)
  if (memoized) return narrowLoadResult(memoized, options.pageIds)

  const result = await computeStudioPages(dir, options)
  if (!options.pageIds) setMemoizedStudioLoad(dir, fingerprint, result)
  return result
}

/** The `options.pageIds` filter, applied to an already-computed FULL result — the same narrowing `computeStudioPages` does at its convert stage. */
function narrowLoadResult(result: StudioLoadResult, pageIds: readonly string[] | undefined): StudioLoadResult {
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
 * content-hash deterministic (not sequential), so a narrower scan's ids are
 * byte-identical to the site-wide registry's — no second registry to merge.
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

  const project = createWorkspaceProject(dir)
  const meta = readStudioMeta(dir)
  const framework = meta.profile?.framework
  const profile = meta.profile ?? probeProject(dir)
  const { styles: compiledStyles } = await compileProjectStyles(dir, profile)
  const configHash = hashWorkspaceConfig([framework, locale, compiledStyles.moduleClassMaps])

  let entry: RoutePageEntry | undefined
  if (framework === 'next-app') {
    const routes = discoverAppRouterRoutes(pagesDir)
    const pageIds = assignAppRouterPageIds(routes)
    const match = routes.find(({ relPath }) => pageIds.get(relPath) === pageId)
    if (match) entry = parseAppRouterRouteEntry(match.relPath, match.route, pageId, pagesDir, dir, project, locale, compiledStyles.moduleClassMaps, configHash)
  } else {
    const relPaths = discoverPageFiles(pagesDir)
    const pageIds = assignPageIds(relPaths)
    const relPath = relPaths.find((rp) => pageIds.get(rp) === pageId)
    if (relPath) entry = parseStandardRouteEntry(relPath, pageId, pagesDir, dir, project, locale, compiledStyles.moduleClassMaps, configHash)
  }
  if (!entry) return null
  const { expanded, componentSources } = entry

  // Scoped (this route only) style resolution — see this function's own doc
  // for why a narrower scan here still produces ids consistent with the
  // client's already-loaded site-wide `site.styleRules`.
  const { classIdsByName } = await loadStudioStyles(
    [{ parsed: expanded, relFile: entry.relFile }],
    project,
    dir,
    cssInJsExtraCss(compiledStyles.css, cssInJsTemplatesOf([entry])),
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
