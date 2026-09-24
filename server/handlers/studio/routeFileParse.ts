/**
 * routeFileParse — ONE file's parse + inline, cached (WS-5.5): the step every
 * file-per-page route runs, and — since P5-G — every free-canvas layer module
 * too (`canvasLayerLoad.ts`).
 *
 * Extracted from `studioPageLoad.ts`'s `parseStandardRouteEntry` so a layer
 * module is parsed by the SAME code a page is, with the same evaluator budget,
 * the same local-component inlining and the same cache invalidation — and not
 * by a second copy of it. A layer is "a page that is not a page": its content
 * has to resolve exactly as it would inside a frame, or dragging it into one
 * would change what it looks like.
 */
import {
  createPageEvalBudget,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ComponentSource,
  type ParsedPage,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { Project } from 'ts-morph'
import { getCachedRouteParse, setCachedRouteParse } from './pageParseCache'

export interface RouteFileParseInput {
  /** Absolute path of the file whose default export is parsed. */
  file: string
  /** `pageParseCache.ts`'s key: `${dir}::<route path>`. */
  cacheKey: string
  dir: string
  project: Project
  preferredKey: string | undefined
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined
  configHash: string
}

export interface RouteFileParse {
  expanded: ParsedPage
  componentSources: Record<string, ComponentSource>
}

export function parseRouteFile(input: RouteFileParseInput): RouteFileParse {
  const { file, cacheKey, dir, project, preferredKey, cssModuleClassMaps, configHash } = input
  const cached = getCachedRouteParse(cacheKey, configHash)
  if (cached) return { expanded: cached.expanded, componentSources: cached.componentSources }

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
  const componentSources = resolveComponentSources(project, file, dir, parsed)
  // `dependencyFiles` collects the TRANSITIVE local-component set —
  // `inlineLocalComponents` populates it at every nesting level, not just
  // the direct call sites `sources` classified. See its own doc for why
  // this closes the "a component three levels deep changed and this route's
  // cache never noticed" gap `pageParseCache.ts` used to have.
  const dependencyFiles = new Set<string>()
  const expanded = inlineLocalComponents(parsed, componentSources, project, dir, { evalOptions, dependencyFiles })
  setCachedRouteParse(cacheKey, configHash, [file, ...dependencyFiles, ...readFiles], { expanded, componentSources })
  return { expanded, componentSources }
}
