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
 */
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  STUDIO_ASSET_SENTINEL,
  type ComponentSource,
  type ParsedPropValue,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'
import { TEXT_HTML_TAG_SET } from '@modules/base/utils/htmlTag'
import { parsedPageToSitePage } from '@core/studio-sync/parsedPageToSitePage'
import { classIdsForClassName, loadStudioStyles } from './studioCss'
import { discoverPageFiles, projectPagesDir, projectPreviewLocale } from './studioProjects'

const CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside',
])

/**
 * Map a parsed node to an Studio moduleId (design-system → alm.*, host tags
 * → base.*).
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
function resolveModuleId(node: {
  kind: 'element' | 'component'
  name: string
  children: string[]
  text?: string
  props?: Record<string, ParsedPropValue>
}): string {
  if (node.kind === 'component') return `alm.${node.name}`
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
  /** §6 — imported `.css` parsed into style rules, keyed by rule id. READ-ONLY: never written back to disk. */
  styleRules: Record<string, StyleRule>
  /** §6 — reusable `@media`/`@container`/`@supports` conditions the rules reference. */
  conditions: ConditionDef[]
}

/**
 * Recursively discovers every page file under `dir`'s pages directory
 * (`projectPagesDir` — `<dir>/pages` by default, or the `.studio/meta.json`
 * `pagesDir` override) and parses EACH into an Studio `Page`. Returns empty
 * results (not an error) when the pages directory doesn't exist yet.
 *
 * Every page is parsed against one shared, workspace-wide ts-morph `Project`
 * (`createWorkspaceProject`) so a page's local-component imports resolve to
 * real files elsewhere in the tree; `resolveComponentSources` classifies each
 * `kind: 'component'` node as **local** (import resolves inside the
 * workspace) or **package** (an npm dependency, read-only prop surface). The
 * merged classification for every page is returned as `componentSources`,
 * keyed by node id.
 */
export async function loadStudioPages(dir: string): Promise<StudioLoadResult> {
  const pagesDir = projectPagesDir(dir)
  if (!existsSync(pagesDir)) return { pages: [], componentSources: {}, styleRules: {}, conditions: [] }

  const relPaths = discoverPageFiles(pagesDir)
  const pageIds = assignPageIds(relPaths)

  // One shared, workspace-wide ts-morph Project so a page's local
  // component imports resolve to real files elsewhere in the tree —
  // a fresh per-file Project (parsePageFile's own default) can't see
  // across files at all. See createWorkspaceProject's doc comment.
  const project = createWorkspaceProject(dir)
  const componentSources: Record<string, ComponentSource> = {}
  // §7.4 — `preferredKey` for a dynamically-indexed dictionary (`translations[lang]`).
  const preferredKey = projectPreviewLocale(dir)

  // Parse + inline EVERY page first, then resolve CSS, then convert. The CSS
  // registry is site-wide (pages routinely share a stylesheet), so it has to be
  // complete before any page can turn a `className` into `classIds`.
  const expandedPages = relPaths.map((relPath) => {
    const file = join(pagesDir, ...relPath.split('/'))
    const pageId = pageIds.get(relPath)!
    // §7 — one evaluator options bag PER PAGE, shared between this page's own
    // parse and every locally-inlined subtree's parse below, so the page-wide
    // step budget (and the module-namespace memo cache inside staticEval.ts)
    // covers the whole page's worth of value resolution, not just one call.
    // `workspaceRoot` enables `?raw` text-import resolution (inline SVG icons).
    const evalOptions: StaticEvalOptions = { preferredKey, pageBudget: createPageEvalBudget(), workspaceRoot: dir }
    const parsed = parsePageFile(file, dir, project, evalOptions)
    // `resolveComponentSources` MUST run on the pre-inline tree — it keys
    // off call-site node ids, which only exist before splicing (§2.6).
    // Nested local components discovered while expanding a sub-tree are
    // resolved fresh, inside `inlineLocalComponents` itself, against that
    // sub-tree's own file.
    const sources = resolveComponentSources(project, file, dir, parsed)
    Object.assign(componentSources, sources)
    const expanded = inlineLocalComponents(parsed, sources, project, dir, { evalOptions })
    return { expanded, pageId, relPath, relFile: relative(dir, file).split(sep).join('/') }
  })

  // §6 — read every stylesheet the pages import, in cascade order.
  const { styleRules, conditions, classIdsByName } = await loadStudioStyles(
    expandedPages.map(({ expanded, relFile }) => ({ parsed: expanded, relFile })),
    project,
    dir,
  )
  const resolveClassIds = (className: string): string[] => classIdsForClassName(className, classIdsByName)

  const pages = expandedPages.map(({ expanded, pageId, relPath }) => {
    const page = parsedPageToSitePage(expanded, {
      pageId,
      slug: pageId,
      title: relPath.split('/').pop()!.replace(/\.(tsx|jsx)$/, ''),
      resolveModuleId,
      resolveTextProp,
      resolveClassIds,
    })
    // §5.2 — turn any `studio-asset:` sentinel (resolved image imports) into
    // a real fetchable URL now that `dir` is in scope.
    rewriteStudioAssetSentinels(page, dir)
    return page
  })

  return { pages, componentSources, styleRules, conditions }
}
