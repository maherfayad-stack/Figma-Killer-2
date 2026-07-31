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
 * multi-page load scan uses. `resolveModuleId`/`resolveTextProp` map a parsed
 * node to an Studio module id and its inline-text-edit prop.
 * `rewriteStudioAssetSentinels` turns a resolved local-image import into a
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
 * BEFORE parsing any route, for one reason: WS-2.2's `import styles from
 * './Card.module.css'` resolution needs `moduleClassMaps` inside the SAME
 * per-page evaluator options bag every other value resolves through, so it has
 * to exist before `parsePageFile`/`inlineLocalComponents` run. The compiled
 * CSS blob (Tailwind/Sass/PostCSS output, rewritten CSS Modules selectors) is
 * threaded into `loadStudioStyles` as `extraCss`, parsed by the same
 * `cssToStyleRules` engine as every plain-CSS import.
 *
 * WS-2.3 — `compiledStyles.vendorCss` (package `.css` reached via a bare-
 * specifier import) rides along on the SAME `compileProjectStyles` call but
 * takes a completely separate path from there: it is never parsed, never
 * merged into `styleRules`/`classIds`, and is returned to the caller
 * verbatim as `StudioLoadResult.vendorCss` — see that field's doc.
 */
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  composeAppRouterRoute,
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  STUDIO_ASSET_SENTINEL,
  type ComponentSource,
  type ParsedPage,
  type ParsedPropValue,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'
import { TEXT_HTML_TAG_SET } from '@modules/base/utils/htmlTag'
import { packageModuleId } from '@core/module-engine'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { classIdsForClassName, loadStudioStyles, type StyleRuleSource } from './studioCss'
import { probeProject } from './studio/projectProbe'
import { getCachedRouteParse, hashWorkspaceConfig, setCachedRouteParse } from './studio/pageParseCache'
import { compileProjectStyles } from './studio/styleCompile'
import { readStudioMeta } from './studio/studioMeta'
import {
  collectAppRouterLayoutChain,
  discoverAppRouterRoutes,
  discoverPageFiles,
  projectPagesDir,
  projectPreviewLocale,
  type AppRouterRoute,
} from './studioProjects'

const CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside',
])

/**
 * `@alm-design/design-system` keeps resolving to `alm.<Name>` (WS-3's
 * hardcoded, build-time-manifested path) rather than the generic
 * `pkg.<sanitized>.<Name>` scheme every other package gets. `standing-07`
 * (STATE.md): the generic pipeline is not yet PROVEN to render the eSIM
 * board — the one real corpus that actually uses this package — visually
 * equivalently to the hardcoded `alm.*` registration in
 * `src/modules/alm/register.tsx`. Routing this one specifier through the new
 * scheme before that dogfood pass would regress the only corpus that
 * currently renders correctly. Revisit only once `standing-07`'s five
 * preconditions all hold — see the `pkg-01` STATE.md entry.
 */
const ALM_DESIGN_PACKAGE_SPECIFIER = '@alm-design/design-system'

/**
 * Map a parsed node to an Studio moduleId (design-system → alm.* / pkg.*, host
 * tags → base.*).
 *
 * WS-3.3 — a `kind: 'component'` node whose `componentSources` classification
 * (computed earlier in `loadStudioPages`, from the PRE-inline tree — see that
 * function's doc) says it's a `package` import gets the generic
 * `pkg.<sanitized-package>.<ComponentName>` id (`packageModuleId`), so
 * `registerProjectModules.ts` can register — and the canvas can find — a
 * module for whatever npm design system the project actually imports, not
 * just the one hardcoded `@alm-design/design-system` case (kept on `alm.*`
 * — see `ALM_DESIGN_PACKAGE_SPECIFIER`'s doc). A `kind: 'component'` node with
 * no package classification at all (a LOCAL component `inlineLocalComponents`
 * declined to expand — recursion, missing declaration, cap reached) keeps the
 * old `alm.<Name>` id: there is no package to bundle for it, so it renders
 * "Unknown module" exactly as it did before this change, which is the honest
 * outcome for content this pipeline cannot materialize.
 *
 * `base.text` and `base.button` are the two modules that need care, because
 * they share two properties: both are leaves (`canHaveChildren: false`) and
 * both render a hardcoded placeholder — the literal words "Text" and "Button" —
 * when their content prop is empty. That placeholder is the right affordance
 * for a hand-authored page (an empty text block stays visible and clickable),
 * but on an imported page it is pure noise: real repos are full of elements
 * that carry no text at all, like `<span className="hp-avatar" />` used purely
 * as a CSS-styled icon slot.
 *
 * So those two modules apply only to an element that BOTH has captured text and
 * has no element children. Everything else that isn't a genuine HTML leaf
 * becomes `base.container`, which preserves the real host tag through its
 * `tag`/`customTag` props (see `parsedPageToSitePage`) and renders children —
 * so an `<h1>` stays an `<h1>`, and an icon-only `<button>` still emits
 * `<button>`, just without a phantom label.
 *
 * Measured on the eSIM corpus before this rule: 154 nodes rendered the literal
 * word "Text", 21 rendered "Button", and 10 buttons silently dropped their
 * children.
 */
function resolveModuleId(
  node: {
    id: string
    kind: 'element' | 'component'
    name: string
    children: string[]
    text?: string
    props?: Record<string, ParsedPropValue>
    /** WS-4.2 — present when `inlineLocalComponents` successfully expanded this call site into an instance. */
    instanceOf?: { componentName: string; source: 'local' | 'package'; sourceFile: string | null }
  },
  componentSources: Record<string, ComponentSource>,
): string {
  if (node.kind === 'component') {
    // WS-4.2 — a call site `inlineLocalComponents` actually expanded renders
    // as the zero-DOM instance fragment, whatever `componentSources` says
    // about it (it will say `local`, since only local expansion produces
    // this field — checked FIRST, not merged into the branch below, so a
    // future package-instance producer of this same field doesn't have to
    // fight the `alm.`/`pkg.` fallback order). A `kind: 'component'` node
    // with NO `instanceOf` is either a package reference (never inlined) or
    // a local call site inlining DECLINED to expand — both keep the
    // pre-WS-4 fallback below unchanged.
    if (node.instanceOf) return 'studio.instance'
    const source = componentSources[node.id]
    if (source?.kind === 'package' && source.specifier !== ALM_DESIGN_PACKAGE_SPECIFIER) {
      return packageModuleId(source.specifier, node.name)
    }
    return `alm.${node.name}`
  }
  // An element carrying resolved raw SVG markup renders as `base.svg`
  // whatever its tag — the `<span dangerouslySetInnerHTML={{__html: icon}} />`
  // shape is how real repos inline an icon, and the markup is the content.
  if (typeof node.props?.svg === 'string' && node.props.svg.length > 0) return 'base.svg'
  const tag = node.name.toLowerCase()
  if (CONTAINER_TAGS.has(tag)) return 'base.container'
  // Genuine HTML leaves, plus `base.link` which does accept children.
  if (tag === 'img') return 'base.image'
  if (tag === 'svg') return 'base.svg'
  if (tag === 'a') return 'base.link'
  // No element children AND non-empty text. `''` counts as no content — an
  // element whose text is empty or whitespace-only would render the
  // placeholder just the same.
  if (node.children.length > 0 || !node.text) return 'base.container'
  if (tag === 'button') return 'base.button'
  // `base.text` has no custom-tag escape hatch, so a tag it cannot render
  // (`<label>`, `<figcaption>`, …) would silently come out as its default
  // `<p>`. Those go to `base.container`, which can represent any tag.
  return TEXT_HTML_TAG_SET.has(tag) ? 'base.text' : 'base.container'
}

/**
 * Map a resolved moduleId to the single prop key its module's
 * `inlineTextEdit` declares. MUST stay in sync with the base modules'
 * `inlineTextEdit.prop` (`src/modules/base/{text,button,link}/index.ts`) —
 * the browser-side `fsCodemodAdapter` reads the same contract off the actual
 * module registry (`@core/module-engine`), which this server-side handler
 * intentionally does not import (page-parser/ast-codemods run here in Node,
 * decoupled from the browser module bundle). `alm.*` design-system
 * components declare no `inlineTextEdit` — out of scope for source
 * writeback this slice.
 */
function resolveTextProp(moduleId: string): string | null {
  switch (moduleId) {
    case 'base.text':
      return 'text'
    case 'base.button':
      return 'label'
    case 'base.link':
      return 'text'
    default:
      return null
  }
}

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
 * Derive a stable page id (also used as the slug) from a page file's path,
 * relative to the workspace's `pages/` dir — kebab-casing every path segment
 * and joining with `-` so nested files don't collide with a differently-
 * nested one that merely shares a basename: "Home.tsx" -> "home",
 * "MyPage.tsx" -> "my-page", "marketing/Landing.tsx" -> "marketing-landing".
 * Pure so it's unit-testable without touching the filesystem.
 *
 * Two DIFFERENT relPaths can still slugify to the same string (e.g.
 * "Marketing/Landing.tsx" and "marketing-landing.tsx" both ->
 * "marketing-landing") — `assignPageIds` is the layer that guarantees
 * uniqueness across a whole discovered set; this function only derives the
 * per-path slug.
 */
export function pageIdFromRelPath(relPath: string): string {
  const segments = relPath.split('/').filter((segment) => segment.length > 0)
  const slug = segments
    .map((segment, i) => {
      const base = i === segments.length - 1 ? segment.replace(/\.(tsx|jsx)$/, '') : segment
      return base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    })
    .filter((segment) => segment.length > 0)
    .join('-')
  return slug.length > 0 ? slug : 'page'
}

/**
 * Assigns a unique pageId (also used as the slug) to each entry of
 * `relPaths`, processed in the given order. `pageIdFromRelPath` is
 * deterministic per path, but two different nested paths can slugify to the
 * same string (see its doc comment) — on a collision, every path after the
 * first gets a numeric suffix (`-2`, `-3`, …), so ids stay unique for a given
 * input ordering. Pure; callers get reproducible ids by passing a
 * consistently-ordered list (`discoverPageFiles` already returns sorted paths).
 */
export function assignPageIds(relPaths: readonly string[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const assigned = new Map<string, string>()
  for (const relPath of relPaths) {
    const base = pageIdFromRelPath(relPath)
    const seen = seenCounts.get(base) ?? 0
    seenCounts.set(base, seen + 1)
    assigned.set(relPath, seen === 0 ? base : `${base}-${seen + 1}`)
  }
  return assigned
}

/** Result of the load pipeline: every parsed page, the merged component classification (keyed by node id), and the merged imported-CSS registry. */
export interface StudioLoadResult {
  pages: Page[]
  componentSources: Record<string, ComponentSource>
  /**
   * §6 — imported `.css` parsed into style rules, keyed by rule id. Edits in
   * the CSS Classes panel apply to this in-memory registry immediately;
   * whether they ALSO reach disk depends on `styleRuleSources` below —
   * `panel-02` wires the write-back for rules with a mapped source.
   */
  styleRules: Record<string, StyleRule>
  /**
   * `panel-02` (WS-6.3) — `StyleRule.id -> (file, selector)` for every rule
   * parsed from a real, hand-authored `.css` file. Absent for a rule
   * contributed by `extraCss` (Tailwind/Sass/PostCSS output, rewritten CSS
   * Modules) or a non-`.css` stylesheet — see `studioCss.ts`'s "Write-back
   * mapping" doc for why those stay unmapped on purpose. The client diffs
   * `site.styleRules` against this to decide which class edits can become a
   * `kind: 'css'` `StudioEdit`.
   */
  styleRuleSources: Record<string, StyleRuleSource>
  /** §6 — reusable `@media`/`@container`/`@supports` conditions the rules reference. */
  conditions: ConditionDef[]
  /**
   * WS-2.3 — `styleCompile.ts`'s `CompiledStyles.vendorCss`: raw CSS read
   * from package `.css` files reached via a bare-specifier import. NEVER
   * parsed into `styleRules`/`classIds` above — the client injects it as its
   * own read-only, below-`user-authored` cascade-layer bucket
   * (`ProjectCssInjector`).
   */
  vendorCss: string
}

/** One route's worth of parsed content, whatever framework produced it — the common shape `loadStudioPages`'s style-collection + convert tail operates over. */
interface RoutePageEntry {
  expanded: ParsedPage
  pageId: string
  slug: string
  title: string
  /** The route's OWN file, workspace-relative POSIX — `collectPageStylesheets`'s "page first" anchor. A composed route's layout files still contribute their own CSS, discovered from their nodes' own `loc.file` (see that module's doc). */
  relFile: string
  componentSources: Record<string, ComponentSource>
}

/** Absolute file paths of every `kind: 'local'` entry in `sources`, deduplicated — see `pageParseCache.ts`'s "one level deep" limitation. */
function localSourceAbsFiles(sources: Record<string, ComponentSource>, dir: string): string[] {
  const files = new Set<string>()
  for (const source of Object.values(sources)) {
    if (source.kind === 'local') files.add(join(dir, ...source.file.split('/')))
  }
  return [...files]
}

/**
 * `assignPageIds`'s per-page parse loop — moved into its own function so
 * `loadStudioPages` can branch on framework without touching this path at
 * all. Every non-`next-app` project's page discovery and parse produces the
 * same output as before WS-1.3; WS-5.5 adds a cache check/write around the
 * expensive parse+inline sequence, keyed by this route's own file plus every
 * local component file it resolved (`pageParseCache.ts`).
 */
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

  return relPaths.map((relPath) => {
    const file = join(pagesDir, ...relPath.split('/'))
    const pageId = pageIds.get(relPath)!
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
  })
}

/**
 * Assigns each App Router route its page id: the ROUTE ITSELF
 * (`app/(marketing)/pricing/page.tsx` -> `/pricing`), not the generic
 * kebab-cased file-path id `assignPageIds` derives for every other
 * framework — which for App Router would slug EVERY route to end in
 * `-page` (the file is always literally named `page.tsx`) and would embed a
 * route group's parens as if they were a real path segment.
 *
 * Two route FILES legitimately deriving the SAME route is not something a
 * real Next.js build would allow, but an imported/hand-edited repo might
 * still have it (e.g. two route groups both defining `/pricing`) — collision
 * gets the same numeric-suffix dedupe `assignPageIds` uses, so ids stay
 * unique for whatever `discoverAppRouterRoutes` returns.
 */
function assignAppRouterPageIds(routes: readonly AppRouterRoute[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const assigned = new Map<string, string>()
  for (const { relPath, route } of routes) {
    const seen = seenCounts.get(route) ?? 0
    seenCounts.set(route, seen + 1)
    assigned.set(relPath, seen === 0 ? route : `${route}-${seen + 1}`)
  }
  return assigned
}

/**
 * A URL-safe form of a derived route, for `Page.slug` (documented as
 * "URL-safe" in `page.ts`) — the route itself carries `/`, `:`, and `*`, none
 * of which belong in a slug. `/` (the root route) becomes `'home'`, matching
 * the same fallback `pageIdFromRelPath` uses when a path slugs to nothing.
 */
function slugFromAppRoute(route: string): string {
  const slug = route.replace(/^\//, '').replace(/\//g, '-').replace(/[:*]/g, '')
  return slug.length > 0 ? slug : 'home'
}

/**
 * WS-1.3 — one entry per App Router ROUTE (`page.tsx`), each composed with
 * its layout chain via `@core/page-parser`'s `composeAppRouterRoute`. The
 * page's own local-component inlining runs exactly as it does for every
 * other framework; composition (and the layout chain's OWN local-component
 * inlining) is `composeAppRouterRoute`'s job — see that module's doc for why
 * order matters and what it declines rather than guesses at.
 *
 * WS-5.5 — the cache key covers the composed result (route + its full layout
 * chain), and tracked dependency files include every layout file in the
 * chain, not just the route's own `page.tsx`: editing a shared `layout.tsx`
 * must invalidate every route beneath it, exactly the many-routes-share-one-
 * layout shape `meta-05`/`store-01`'s `nodeIdToPageIds` index already had to
 * account for.
 */
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

  return routes.map(({ relPath, route }) => {
    const file = join(pagesDir, ...relPath.split('/'))
    const pageId = pageIds.get(relPath)!
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
  })
}

/**
 * Recursively discovers every page/route under `dir`'s pages directory
 * (`projectPagesDir` — `<dir>/pages` by default, or the `.studio/meta.json`
 * `pagesDir` override) and parses EACH into an Studio `Page`. Returns empty
 * results (not an error) when the pages directory doesn't exist yet.
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
 */
export async function loadStudioPages(dir: string): Promise<StudioLoadResult> {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) {
    return { pages: [], componentSources: {}, styleRules: {}, styleRuleSources: {}, conditions: [], vendorCss: '' }
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
  const routeEntries = framework === 'next-app'
    ? buildAppRouterPageEntries(pagesDir, dir, project, preferredKey, compiledStyles.moduleClassMaps, configHash)
    : buildStandardPageEntries(pagesDir, dir, project, preferredKey, compiledStyles.moduleClassMaps, configHash)

  const componentSources: Record<string, ComponentSource> = {}
  for (const entry of routeEntries) Object.assign(componentSources, entry.componentSources)

  // §6 — read every stylesheet the pages import, in cascade order, plus the
  // WS-2.1 compiled blob (Tailwind/Sass/PostCSS output, rewritten CSS Modules).
  const { styleRules, conditions, classIdsByName, sources: styleRuleSources } = await loadStudioStyles(
    routeEntries.map(({ expanded, relFile }) => ({ parsed: expanded, relFile })),
    project,
    dir,
    compiledStyles.css,
  )
  const resolveClassIds = (className: string): string[] => classIdsForClassName(className, classIdsByName)

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

  return { pages, componentSources, styleRules, styleRuleSources, conditions, vendorCss: compiledStyles.vendorCss }
}
