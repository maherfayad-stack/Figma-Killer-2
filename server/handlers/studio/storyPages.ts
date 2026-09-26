/**
 * storyPages — turning an accepted Storybook story into one board page, using
 * the EXISTING parse pipeline rather than a second one.
 *
 * `storyDiscovery.ts` decides WHICH stories can be read and in which of the two
 * accepted shapes. This module decides what each shape becomes, and the whole
 * point of the split is that neither half needs a new parser:
 *
 *   **jsx-only** — the story's JSX genuinely exists in the `.stories.tsx`, so
 *   it goes through exactly what an ordinary page goes through:
 *   `getReturnedJsxRoots` -> `parseJsxTree` -> `resolveComponentSources` ->
 *   `inlineLocalComponents`. Its nodes therefore carry real
 *   `relFile:line:col` ids in the story file, are editable exactly as far as
 *   any page's nodes are, and refuse exactly where any page's nodes refuse. No
 *   special case reaches the canvas, the panel, or the writeback path.
 *
 *   **args-only** — there is no JSX. The story says "this component, these
 *   args", and the args are an object literal, not an element. So this module
 *   hands `inlineLocalComponents` a ONE-NODE `ParsedPage` whose single
 *   `kind: 'component'` node is a synthesized call site: `meta.component`'s
 *   identifier as its name, the merged args as its props, and the STORY
 *   EXPORT'S OWN declaration position as its `loc`. Inlining then does the
 *   real work — it resolves the identifier through the story file's own
 *   imports, parses the component's file, substitutes the args, and produces
 *   a `studio.instance` node with the component's real subtree beneath it,
 *   every descendant carrying a composite id anchored in the COMPONENT's file.
 *   Those descendants are as editable (and as shared) as any inlined
 *   component's, which is the whole value: a design system's variants become
 *   an editable board.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ARGS-ONLY STORY'S OWN PROPS ARE READ-ONLY (and what would change it)
 *
 * The synthesized call site's `loc` is a real position in a real file — the
 * `export const Primary` identifier — because trap #2 forbids inventing one.
 * But no JSX element lives there, so `setJsxProp` has nothing to rewrite. Every
 * arg is therefore recorded in `codeProps` (and explained in `resolvedProps`,
 * which `parsedPageToSitePage` re-keys into the `callSiteProps:` namespace for
 * an instance node), and `isPropWritableToSource` refuses it. The panel shows
 * the value and says where it came from; it does not pretend to write it.
 *
 * The honest target EXISTS — `label: 'Click me'` is an ordinary string literal
 * at a known `rel:line:col`, exactly the shape `textOrigin`/`setStringLiteral`
 * already writes. Since P3-C the save side is ready for it: `nodeDiffWriteback.ts`
 * writes every origin-backed value — an instance's `callSiteProps:<name>`
 * included — as a `kind: 'literal'` edit at the origin, never a `prop` edit at
 * the call site. What is still missing is HERE: `storyDiscovery` reads the
 * args to plain values and keeps no literal positions, so there is no origin
 * to record. Recording one needs the arg's own literal (a story's `args`
 * entry, not a `meta.args` one every story inherits — that would be the
 * shared-default case `componentSubstitution.ts` refuses). Until then this
 * module records `source` and no `origin`.
 * ---------------------------------------------------------------------------
 */
import {
  createPageEvalBudget,
  getReturnedJsxRoots,
  inlineLocalComponents,
  parseJsxTree,
  resolveComponentSources,
  type ComponentSource,
  type FunctionLike,
  type ParsedNode,
  type ParsedPage,
  type StaticEvalOptions,
} from '@core/page-parser'
import type { Project } from 'ts-morph'
import type { RouteCacheScope } from './pageParseCache'
import type { RoutePageEntry } from './routePageEntry'
import { parseRouteThroughCache } from './routeParse'
import type { WorkspaceProjectHandle } from './workspaceProject'
import type { DiscoveredStory } from './storyDiscovery'

/**
 * The structural `lockReason` a synthesized story call site carries.
 *
 * Phrased for a person, like every other `lockReason` (`refuseStructuralEdit`
 * renders it verbatim into "The code decides where this element goes (…)").
 * It is the literal truth: a story's position on the board comes from a CSF
 * export, not from JSX placed in a file, so there is no sibling to reorder it
 * against and nothing to delete.
 */
export const STORY_CALL_SITE_LOCK_REASON = 'a Storybook story, declared as args rather than placed as JSX'

/**
 * Marks a story's `pageParseCache` key so the route half of it stays tellable
 * apart from a page route's. A page route's key half is the route file's
 * project-relative path (`marketing/Landing.tsx`) or an App Router route path,
 * both of which end in a file extension and neither of which can start with
 * this prefix; a story's is its assigned `pageId`, which `reloadScope.ts` can
 * therefore read straight back out instead of re-running discovery (which
 * would mean re-parsing every story file to answer a question about which
 * pages to reload).
 */
const STORY_ROUTE_KEY_PREFIX = 'story:'

/** The `pageParseCache` route key for one story — see {@link STORY_ROUTE_KEY_PREFIX}. */
function storyRouteKey(pageId: string): string {
  return `${STORY_ROUTE_KEY_PREFIX}${pageId}`
}

/**
 * The story page id behind a `cachedRouteDependencies` key, or `null` when
 * that key belongs to an ordinary page route. The inverse of
 * {@link storyCacheKey}, and the only thing outside this module that needs to
 * know the prefix exists.
 */
export function storyPageIdFromRoutePath(routePath: string): string | null {
  return routePath.startsWith(STORY_ROUTE_KEY_PREFIX) ? routePath.slice(STORY_ROUTE_KEY_PREFIX.length) : null
}

/**
 * One `RoutePageEntry` per accepted story, in discovery order.
 *
 * `preferredKey`/`cssModuleClassMaps` are threaded through to a FRESH
 * evaluator options bag per story — same discipline `parseStandardRouteEntry`
 * follows per page, so one story's runaway expression cannot spend another
 * story's step budget.
 *
 * A story whose materialization degrades to nothing (an inlining the parser
 * declined, a `SourceFile` the project no longer holds) is SKIPPED rather than
 * emitted as an empty frame — an empty frame on the board is indistinguishable
 * from a broken one.
 *
 * Each built story is recorded in `pageParseCache` under
 * {@link storyCacheKey}, with the same TRANSITIVE dependency set the other two
 * producers record: its own file plus every local component `inlineLocalComponents`
 * read while expanding it, at every nesting level (`FreshBuiltStory.dependencyFiles`,
 * below). That buys the cheap half (a reopened board re-materializes only the
 * stories whose inputs moved) and, the reason it was owed, the half
 * `reloadScope.ts` needs — a story route with recorded dependencies is a route
 * the narrow reload can REASON about, instead of the blanket "this project has
 * stories, widen everything" it had to assume while stories recorded nothing.
 */
export function buildStoryRouteEntries(
  scope: RouteCacheScope,
  workspace: WorkspaceProjectHandle,
  stories: readonly DiscoveredStory[],
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
): RoutePageEntry[] {
  const { dir, preferredKey } = scope
  const { project } = workspace
  const entries: RoutePageEntry[] = []

  for (const story of stories) {
    // A skipped story (the parse returns `null`) is deliberately NOT cached:
    // "this produced nothing" is the one answer worth recomputing, since the
    // file it depends on is exactly what a user fixes next.
    const outcome = parseRouteThroughCache(scope, workspace, storyRouteKey(story.summary.pageId), () => {
      // WB-2 — every file a value was read out of, recorded with the rest.
      const readFiles = new Set<string>()
      const evalOptions: StaticEvalOptions = {
        preferredKey,
        pageBudget: createPageEvalBudget(),
        workspaceRoot: dir,
        cssModuleClassMaps,
        readFiles,
      }
      const fresh =
        story.body.kind === 'jsx'
          ? buildJsxStory(dir, project, story, story.body.fn, evalOptions)
          : buildArgsStory(dir, project, story, story.body, evalOptions)
      if (!fresh) return null
      return {
        result: { expanded: fresh.expanded, componentSources: fresh.componentSources },
        dependencyFiles: [story.absFile, ...fresh.dependencyFiles, ...readFiles],
      }
    })
    if (!outcome) continue

    entries.push({
      expanded: outcome.result.expanded,
      pageId: story.summary.pageId,
      slug: story.summary.pageId,
      title: story.summary.frameTitle,
      relFile: story.relFile,
      componentSources: outcome.result.componentSources,
      dependencies: outcome.dependencies,
    })
  }

  return entries
}

interface BuiltStory {
  expanded: ParsedPage
  componentSources: Record<string, ComponentSource>
}

/**
 * A freshly-built story additionally carries its TRANSITIVE local-component
 * dependency set — `inlineLocalComponents`' `dependencyFiles` out-param,
 * populated at every nesting level, not just the story's own direct call
 * sites. A CACHE HIT (`BuiltStory` alone, above) has no need of it: the
 * dependency set was already recorded in `pageParseCache` the first time this
 * story was built, and re-deriving it on every hit would defeat the cache.
 */
interface FreshBuiltStory extends BuiltStory {
  dependencyFiles: Set<string>
}

/**
 * The jsx-only shape: the story's function IS a component for parsing
 * purposes, so it takes the identical path a page component takes. Passing the
 * function as `parseJsxTree`'s `componentFn` is what lets §7 read its own
 * parameter destructuring and any module-scope `const` the JSX references.
 */
function buildJsxStory(
  dir: string,
  project: Project,
  story: DiscoveredStory,
  fn: FunctionLike,
  evalOptions: StaticEvalOptions,
): FreshBuiltStory | undefined {
  const sourceFile = project.getSourceFile(story.absFile)
  if (!sourceFile) return undefined

  const roots = getReturnedJsxRoots(fn)
  if (roots.length === 0) return undefined

  const parsed = parseJsxTree(roots, sourceFile, story.relFile, fn, evalOptions)
  if (parsed.rootIds.length === 0) return undefined

  // `resolveComponentSources` MUST run on the pre-inline tree — it keys off
  // call-site node ids, which only exist before splicing. Same order, same
  // reason, as `parseStandardRouteEntry`.
  const componentSources = resolveComponentSources(project, story.absFile, dir, parsed)
  const dependencyFiles = new Set<string>()
  return {
    expanded: inlineLocalComponents(parsed, componentSources, project, dir, { evalOptions, dependencyFiles }),
    componentSources,
    dependencyFiles,
  }
}

/**
 * The args-only shape: a synthesized, one-node call site handed to the real
 * inliner. See this module's header for why the node is locked and its props
 * are all `codeProps`.
 */
function buildArgsStory(
  dir: string,
  project: Project,
  story: DiscoveredStory,
  body: Extract<DiscoveredStory['body'], { kind: 'args' }>,
  evalOptions: StaticEvalOptions,
): FreshBuiltStory | undefined {
  const callSiteId = `${story.relFile}:${story.line}:${story.col}`
  const argNames = Object.keys(body.args)

  const callSite: ParsedNode = {
    id: callSiteId,
    kind: 'component',
    name: body.componentName,
    props: body.args,
    children: [],
    loc: { file: story.relFile, line: story.line, col: story.col },
    locked: true,
    lockReason: STORY_CALL_SITE_LOCK_REASON,
    // Every arg is a real value with no writable JSX attribute behind it.
    // `parsedPageToSitePage` re-keys these into `callSiteProps:<name>` once
    // inlining turns this node into a `studio.instance`, so plain names here
    // are correct for BOTH outcomes (inlined instance, or an un-inlined
    // package reference that keeps its flat props).
    codeProps: argNames,
    resolvedProps: Object.fromEntries(
      argNames.map((name) => [name, { source: `args.${name}`, note: `Storybook story "${story.summary.storyName}"` }]),
    ),
  }

  const parsed: ParsedPage = { rootIds: [callSiteId], nodes: { [callSiteId]: callSite } }
  const componentSources: Record<string, ComponentSource> = { [callSiteId]: body.componentSource }
  const dependencyFiles = new Set<string>()
  return {
    expanded: inlineLocalComponents(parsed, componentSources, project, dir, { evalOptions, dependencyFiles }),
    componentSources,
    dependencyFiles,
  }
}
