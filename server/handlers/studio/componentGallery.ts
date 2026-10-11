/**
 * componentGallery — CV-2's variants gallery: for each local component that
 * declares enum/boolean props, ONE derived page whose body is the component
 * rendered once per combination of those props.
 *
 * It reuses the Storybook args-only mechanism rather than a second one:
 * every cell is a synthesized `kind: 'component'` call site handed to
 * `inlineLocalComponents`, which resolves the identifier, parses the
 * component's file, substitutes the props, and produces a `studio.instance`
 * with the component's real subtree beneath it. Nothing is written to the
 * user's source and nothing is executed (parse, never execute).
 *
 * WHAT IS REAL AND WHAT IS SCAFFOLDING
 *   - Real: each cell's inlined nodes. Their ids are composite
 *     (`<file>:<l>:<c>#<n>~<file>:<l>:<c>`), so the tail is the component's own
 *     root and selecting a cell selects that variant's root with the
 *     component's props in the inspector (CV-1's answer to "where does the main
 *     component live": the instance root's composite tail).
 *   - Scaffolding: the grid, the header and the cell labels. Their ids are
 *     `component-gallery:<page>:…`, which match no source-location grammar, so
 *     every write aimed at them is refused as "not in your source" — the same
 *     answer a synthetic page root gets.
 *
 * WHAT IS READ-ONLY, AND WHY
 *   The call site has no JSX element behind it (like an args-only story), so
 *   its props are recorded in `codeProps` and the instance is locked. The
 *   inlined subtree is the shared component's: an edit there is a
 *   shared-component edit that lands on every instance, and the editor already
 *   says so. CV-3 (Add variant) is what makes the axes writable.
 *
 * The cell grid itself is `planVariantGrid` (cap, pinned axes): this module
 * only turns a plan into nodes.
 */
import * as path from 'node:path'
import {
  createPageEvalBudget,
  findNamedComponentDeclaration,
  inlineLocalComponents,
  type ComponentSource,
  type ParsedNode,
  type ParsedPage,
  type ParsedPropValue,
  type StaticEvalOptions,
} from '@core/page-parser'
import { planVariantGrid, type GalleryAxisInput, type GalleryPlan } from '@core/component-variants'
import type { Project } from 'ts-morph'
import { pageIdFromRelPath } from '../studioPageIds'
import { extractLocalComponentCatalog, type LocalComponentSpec } from './componentSpecExtract'
import type { RouteCacheScope } from './pageParseCache'
import type { RoutePageEntry } from './routePageEntry'
import { parseRouteThroughCache } from './routeParse'
import type { WorkspaceProjectHandle } from './workspaceProject'

/** Most component galleries one project places. A repo with hundreds of variant-bearing components gets the first of them, in path order, not a board of a thousand frames. */
export const MAX_GALLERY_COMPONENTS = 60

/** The `lockReason` of a gallery cell's call site — phrased for a person, like every other. */
export const GALLERY_CALL_SITE_LOCK_REASON = 'a generated variants gallery cell, not placed in your source'

/** Marks a gallery's `pageParseCache` route key, exactly as `story:` marks a story's (`storyPages.ts`). */
const GALLERY_ROUTE_KEY_PREFIX = 'component-gallery:'

/** The `pageParseCache` route key for one gallery page. */
function galleryRouteKey(pageId: string): string {
  return `${GALLERY_ROUTE_KEY_PREFIX}${pageId}`
}

/** The gallery page id behind a `cachedRouteDependencies` key, or `null` for any other route. */
export function galleryPageIdFromRoutePath(routePath: string): string | null {
  return routePath.startsWith(GALLERY_ROUTE_KEY_PREFIX) ? routePath.slice(GALLERY_ROUTE_KEY_PREFIX.length) : null
}

/** What the board needs to know about one gallery page, and nothing the parse needs. */
export interface GallerySummary {
  /** The component's file, workspace-relative POSIX. */
  file: string
  componentName: string
  /** The frame's label. */
  title: string
  /** The page id this gallery renders — unique across pages, stories and galleries. */
  pageId: string
  /** The row the frame sits on: components in one folder share a row. */
  rowKey: string
  /** Cells rendered / combinations that exist. */
  shown: number
  total: number
}

/** A discoverable gallery: the summary plus everything `buildGalleryRouteEntries` needs. */
export interface DiscoveredGallery {
  summary: GallerySummary
  /** 1-based position of the component's declaration — a REAL position in a REAL file, which is what the call site's `loc` must be. */
  line: number
  col: number
  plan: GalleryPlan
  /** Props every cell gets beyond its axis values (sample text for required strings). */
  sampleProps: Record<string, ParsedPropValue>
  /** Whether the component takes `children`, so each cell is given a text child to show. */
  takesChildren: boolean
}

const NON_GALLERY_FILE_RE = /\.(stories|test|spec)\.[cm]?[jt]sx?$/

/** `isDisabled` / `primary_color` -> `Is disabled` / `Primary color` — sample text for a required string prop. */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function axesOf(spec: LocalComponentSpec): GalleryAxisInput[] {
  const axes: GalleryAxisInput[] = []
  for (const prop of spec.props) {
    const defaultValue = prop.defaultValue === undefined ? {} : { defaultValue: prop.defaultValue }
    if (prop.kind.kind === 'enum') axes.push({ name: prop.name, kind: 'enum', members: prop.kind.values, ...defaultValue })
    else if (prop.kind.kind === 'boolean') axes.push({ name: prop.name, kind: 'boolean', members: [], ...defaultValue })
  }
  return axes
}

/** A required plain-string prop with no default would render empty; give it a humanized name as sample text. */
function samplePropsOf(spec: LocalComponentSpec): Record<string, ParsedPropValue> {
  const sample: Record<string, ParsedPropValue> = {}
  for (const prop of spec.props) {
    if (prop.kind.kind === 'string' && prop.required && prop.defaultValue === undefined) sample[prop.name] = humanize(prop.name)
  }
  return sample
}

/**
 * Every local component worth a gallery: it declares at least one enum/boolean
 * prop with two or more values, it is not a page, a story or a test, and its
 * declaration is findable BY NAME in its own file (the same-file call-site
 * resolution `inlineLocalComponents` uses — an anonymous default export has no
 * name to put in a call site).
 *
 * `excludeFiles` is the set of route files the load already turned into pages;
 * `takenPageIds` is the set of ids pages and stories already hold, so a gallery
 * can never shadow one.
 */
export function discoverGalleries(
  project: Project,
  dir: string,
  excludeFiles: ReadonlySet<string>,
  takenPageIds: ReadonlySet<string>,
): DiscoveredGallery[] {
  const taken = new Set(takenPageIds)
  const found: DiscoveredGallery[] = []
  const perFile = new Map<string, number>()
  const specs = extractLocalComponentCatalog(project, dir, { analyzeBindings: false })
  for (const spec of specs) perFile.set(spec.file, (perFile.get(spec.file) ?? 0) + 1)

  for (const spec of specs) {
    if (found.length >= MAX_GALLERY_COMPONENTS) break
    if (excludeFiles.has(spec.file) || NON_GALLERY_FILE_RE.test(spec.file)) continue
    const plan = planVariantGrid(axesOf(spec))
    if (!plan) continue
    const sourceFile = project.getSourceFile(path.join(dir, ...spec.file.split('/')))
    const declaration = sourceFile && findNamedComponentDeclaration(sourceFile, spec.name, false)
    if (!sourceFile || !declaration) continue
    const { line, column } = sourceFile.getLineAndColumnAtPos(declaration.getStart())

    const slug = pageIdFromRelPath(spec.file)
    const nameSlug = pageIdFromRelPath(spec.name)
    const several = perFile.get(spec.file)! > 1 && !slug.endsWith(nameSlug)
    const base = `component-${several ? `${slug}-${nameSlug}` : slug}`
    let pageId = base
    for (let n = 2; taken.has(pageId); n++) pageId = `${base}-${n}`
    taken.add(pageId)

    found.push({
      summary: {
        file: spec.file,
        componentName: spec.name,
        title: `Components / ${spec.name}`,
        pageId,
        rowKey: path.posix.dirname(spec.file),
        shown: plan.cells.length,
        total: plan.total,
      },
      line,
      col: column,
      plan,
      sampleProps: samplePropsOf(spec),
      takesChildren: spec.props.some((prop) => prop.name === 'children'),
    })
  }
  return found
}

/** `Button: 12 of 36 variants (held at size=md)` — says what the grid does not vary. */
function headerText(gallery: DiscoveredGallery): string {
  const { plan, summary } = gallery
  const count = plan.cells.length === plan.total ? `${plan.total} variants` : `${plan.cells.length} of ${plan.total} variants`
  const pinned = plan.pinned.map(({ name, value }) => `${name}=${String(value)}`).join(', ')
  return pinned ? `${summary.componentName}: ${count} (held at ${pinned})` : `${summary.componentName}: ${count}`
}

/** One synthetic scaffold element. `loc` is the component's file: the node has no source of its own, but the page's stylesheet discovery keys off `loc.file`. */
function scaffold(
  id: string,
  name: string,
  file: string,
  fields: Pick<ParsedNode, 'children'> & Partial<Pick<ParsedNode, 'inlineStyles' | 'text'>>,
): ParsedNode {
  return {
    id,
    kind: 'element',
    name,
    props: {},
    loc: { file, line: 1, col: 1 },
    locked: true,
    lockReason: GALLERY_CALL_SITE_LOCK_REASON,
    ...fields,
  }
}

/** The one-page `ParsedPage` for a gallery: header + a wrapping grid of labelled call sites. Pure — `inlineLocalComponents` does the rest. */
export function synthesizeGalleryPage(gallery: DiscoveredGallery): { parsed: ParsedPage; sources: Record<string, ComponentSource> } {
  const { summary, plan, line, col } = gallery
  const prefix = `component-gallery:${summary.pageId}`
  const nodes: Record<string, ParsedNode> = {}
  const sources: Record<string, ComponentSource> = {}
  const cellIds: string[] = []

  for (const cell of plan.cells) {
    const callSiteId = `${summary.file}:${line}:${col}#${cell.index}`
    const props: Record<string, ParsedPropValue> = { ...gallery.sampleProps, ...cell.values }
    const names = Object.keys(props)
    const childIds: string[] = []
    if (gallery.takesChildren) {
      const childId = `${prefix}:child:${cell.index}`
      nodes[childId] = scaffold(childId, 'span', summary.file, { children: [], text: summary.componentName })
      childIds.push(childId)
    }
    nodes[callSiteId] = {
      id: callSiteId,
      kind: 'component',
      name: summary.componentName,
      props,
      children: childIds,
      loc: { file: summary.file, line, col },
      locked: true,
      lockReason: GALLERY_CALL_SITE_LOCK_REASON,
      codeProps: names,
      resolvedProps: Object.fromEntries(names.map((name) => [name, { source: `variants.${name}`, note: 'variants gallery' }])),
    }
    sources[callSiteId] = { kind: 'local', file: summary.file }

    const labelId = `${prefix}:label:${cell.index}`
    nodes[labelId] = scaffold(labelId, 'span', summary.file, {
      children: [],
      text: cell.label,
      inlineStyles: { fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' },
    })
    const cellId = `${prefix}:cell:${cell.index}`
    nodes[cellId] = scaffold(cellId, 'div', summary.file, {
      children: [labelId, callSiteId],
      inlineStyles: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
    })
    cellIds.push(cellId)
  }

  const headerId = `${prefix}:header`
  nodes[headerId] = scaffold(headerId, 'p', summary.file, {
    children: [],
    text: headerText(gallery),
    inlineStyles: { margin: 0, width: '100%', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, color: '#374151' },
  })
  const rootId = `${prefix}:grid`
  nodes[rootId] = scaffold(rootId, 'div', summary.file, {
    children: [headerId, ...cellIds],
    inlineStyles: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 32, padding: 32 },
  })
  return { parsed: { rootIds: [rootId], nodes }, sources }
}

/**
 * One `RoutePageEntry` per discovered gallery, cached under a
 * `component-gallery:` key like a story, with the same TRANSITIVE dependency
 * set — so an edit to the component (or anything it inlines) re-materializes
 * just that gallery, and `reloadScope.ts` can name its page.
 *
 * A gallery whose component the inliner declined (an unreadable body, a
 * cycle) has no `instanceOf` anywhere and is SKIPPED, not emitted as a grid of
 * empty cells.
 */
export function buildGalleryRouteEntries(
  scope: RouteCacheScope,
  workspace: WorkspaceProjectHandle,
  galleries: readonly DiscoveredGallery[],
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
): RoutePageEntry[] {
  const { dir, preferredKey } = scope
  const entries: RoutePageEntry[] = []
  for (const gallery of galleries) {
    const outcome = parseRouteThroughCache(scope, workspace, galleryRouteKey(gallery.summary.pageId), () => {
      const readFiles = new Set<string>()
      const evalOptions: StaticEvalOptions = {
        preferredKey,
        pageBudget: createPageEvalBudget(),
        workspaceRoot: dir,
        cssModuleClassMaps,
        readFiles,
      }
      const { parsed, sources } = synthesizeGalleryPage(gallery)
      const dependencyFiles = new Set<string>()
      const expanded = inlineLocalComponents(parsed, sources, workspace.project, dir, { evalOptions, dependencyFiles })
      if (!Object.values(expanded.nodes).some((node) => node.instanceOf)) return null
      return {
        result: { expanded, componentSources: sources },
        dependencyFiles: [path.join(dir, ...gallery.summary.file.split('/')), ...dependencyFiles, ...readFiles],
      }
    })
    if (!outcome) continue
    entries.push({
      expanded: outcome.result.expanded,
      pageId: gallery.summary.pageId,
      slug: gallery.summary.pageId,
      title: gallery.summary.title,
      relFile: gallery.summary.file,
      componentSources: outcome.result.componentSources,
      dependencies: outcome.dependencies,
    })
  }
  return entries
}
