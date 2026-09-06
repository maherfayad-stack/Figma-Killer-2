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
 * already writes. Recording it as `resolvedProps[arg].origin` would be enough
 * for the FLAT prop loop in `fsCodemodAdapter.saveSite` (it emits
 * `kind: 'literal'` aimed at the origin). It is NOT enough for a
 * `studio.instance`, and that is the concrete blocker: the adapter's
 * `callSiteProps` branch has no origin case at all — it asks
 * `isPropWritableToSource` (which an origin makes say YES) and then emits
 * `kind: 'prop'` at the call site, which here is the `export const`. Setting an
 * origin today would therefore authorise precisely the mis-aimed write the rule
 * exists to prevent. Closing that gap is a one-branch change in
 * `fsCodemodAdapter.ts` and belongs with whoever owns that file; until then
 * this module deliberately records `source` and no `origin`.
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
import { getCachedRouteParse, localSourceAbsFiles, setCachedRouteParse } from './pageParseCache'
import type { RoutePageEntry } from './routePageEntry'
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

/** The `pageParseCache` key for one story — see {@link STORY_ROUTE_KEY_PREFIX}. */
function storyCacheKey(dir: string, pageId: string): string {
  return `${dir}::${STORY_ROUTE_KEY_PREFIX}${pageId}`
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
 * {@link storyCacheKey}, with the same dependency set the other two producers
 * record: its own file plus every local component it resolved. That buys the
 * cheap half (a reopened board re-materializes only the stories whose inputs
 * moved) and, the reason it was owed, the half `reloadScope.ts` needs — a
 * story route with recorded dependencies is a route the narrow reload can
 * REASON about, instead of the blanket "this project has stories, widen
 * everything" it had to assume while stories recorded nothing.
 */
export function buildStoryRouteEntries(
  dir: string,
  project: Project,
  stories: readonly DiscoveredStory[],
  preferredKey: string | undefined,
  cssModuleClassMaps: Record<string, Record<string, string>> | undefined,
  configHash: string,
): RoutePageEntry[] {
  const entries: RoutePageEntry[] = []

  for (const story of stories) {
    const cacheKey = storyCacheKey(dir, story.summary.pageId)
    const cached = getCachedRouteParse(cacheKey, configHash)
    let built: BuiltStory | undefined
    if (cached) {
      built = { expanded: cached.expanded, componentSources: cached.componentSources }
    } else {
      const evalOptions: StaticEvalOptions = {
        preferredKey,
        pageBudget: createPageEvalBudget(),
        workspaceRoot: dir,
        cssModuleClassMaps,
      }
      built =
        story.body.kind === 'jsx'
          ? buildJsxStory(dir, project, story, story.body.fn, evalOptions)
          : buildArgsStory(dir, project, story, story.body, evalOptions)
      // A skipped story is deliberately NOT cached: "this produced nothing"
      // is the one answer worth recomputing, since the file it depends on is
      // exactly what a user fixes next.
      if (built) {
        setCachedRouteParse(
          cacheKey,
          configHash,
          [story.absFile, ...localSourceAbsFiles(built.componentSources, dir)],
          built,
        )
      }
    }
    if (!built) continue

    entries.push({
      expanded: built.expanded,
      pageId: story.summary.pageId,
      slug: story.summary.pageId,
      title: story.summary.frameTitle,
      relFile: story.relFile,
      componentSources: built.componentSources,
    })
  }

  return entries
}

interface BuiltStory {
  expanded: ParsedPage
  componentSources: Record<string, ComponentSource>
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
): BuiltStory | undefined {
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
  return {
    expanded: inlineLocalComponents(parsed, componentSources, project, dir, { evalOptions }),
    componentSources,
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
): BuiltStory | undefined {
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
  return {
    expanded: inlineLocalComponents(parsed, componentSources, project, dir, { evalOptions }),
    componentSources,
  }
}
