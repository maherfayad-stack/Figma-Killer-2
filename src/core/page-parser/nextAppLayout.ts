/**
 * nextAppLayout — WS-1.3 of `STUDIO-IMPORT-V2-PLAN.md`: composes a Next.js
 * App Router route's rendered tree, `RootLayout(SegmentLayout(Page))`, out of
 * pieces every one of which is already parsed the ordinary way.
 *
 * Deliberately NOT a new inliner. `inlineLocalComponents`/`componentSubstitution`
 * already know how to splice `{children}` into a component's own JSX — that is
 * exactly what composing a layout around a page needs, because
 * `function RootLayout({ children }) { return <html><body>{children}</body></html> }`
 * is, structurally, a component whose one parameter is a slot. The only thing
 * missing for App Router is a caller that has no real JSX call site (Next
 * composes layout/page implicitly, outside any file's own markup) — so this
 * module builds the substitution env `buildSubstitutionEnv` would have built
 * FROM a call site's props, and hands it `applySubstitutions` directly.
 *
 * Never executes anything (§0's invariant, unchanged): a layout/page's own
 * JSX is walked exactly the way `parsePageFile` walks any other file. An
 * `async` component (a genuine server component that awaits data) is not run
 * either — `applyAsyncServerComponentFinding` below records THAT it is async,
 * not what it would have rendered.
 *
 * WRITEBACK SAFETY: composition never rewrites a node's `id`. A page's own
 * nodes keep their `page.tsx`-relative ids, a layout's own nodes keep their
 * `layout.tsx`-relative ids (unlike `inlineLocalComponents`, which prefixes
 * ids with `${callSiteId}~` because the SAME component file can appear at
 * many call sites on one page — a layout file backs exactly one composed
 * position per route, so there is nothing to disambiguate). An edit to a node
 * that came from `app/layout.tsx` therefore still decodes to `app/layout.tsx`
 * after composition — `decodeSourceNodeId` never sees a difference between a
 * composed node and an ordinarily-parsed one.
 */
import * as path from 'node:path'
import { Node, type Project, type SourceFile } from 'ts-morph'
import { applySubstitutions, buildSubstitutionEnv } from './componentSubstitution'
import { resolveComponentSources, type ComponentSource } from './componentSources'
import { inlineLocalComponents } from './inlineLocalComponents'
import { findComponentDeclaration, getFunctionLikeNode, getReturnedJsxRoots, parseJsxTree } from './parsePageFile'
import type { FunctionLike, ParsedPage } from './types'
import type { StaticEvalOptions } from './staticEval'

// ---------------------------------------------------------------------------
// Async server component — a structured "we chose, and we said so" finding,
// not a new evaluation power.
// ---------------------------------------------------------------------------

/** Best-effort component name for the finding's prose only — never affects structure or ids. */
function componentDisplayName(fn: FunctionLike): string {
  if (Node.isFunctionDeclaration(fn)) return fn.getName() || 'default export'
  const parent = fn.getParent()
  if (Node.isVariableDeclaration(parent)) return parent.getName()
  return 'default export'
}

/**
 * Records the one thing worth saying about an `async` server component: the
 * data it awaits (a `fetch`, a database read, …) is invisible to a static
 * parser — `parseJsxTree` never runs it, by design. Without a marker, a route
 * that renders mostly from awaited data comes back looking parsed-but-broken
 * (blank text, missing children) with nothing explaining why, which reads as
 * a defect rather than an honestly-stated limitation.
 *
 * Reuses `ParsedNode.resolution`'s existing `{ source, note }` shape — the
 * same one Tier B.4's dictionary-branch pick attaches (`staticEvalCore.ts`'s
 * `withNote`) — rather than inventing a new field; WS-9's fidelity report is
 * specced to read exactly this shape off a node.
 *
 * Deliberately does NOT lock the node the way `withResolutionLock` always
 * does for an actual resolved VALUE. `withResolutionLock`'s lock protects a
 * writeback target from being baked over with a literal that would delete a
 * binding — nothing here is being baked over anything, and the component's
 * STRUCTURE is not a runtime choice the way a multi-`return`'s branches are
 * (that stays `BRANCH_LOCK_REASON`'s job). Locking every node here would
 * misrepresent structure the parser is in fact certain of. Only the VALUES it
 * could not read are missing, and those already silently drop out of
 * `props`/`text` on their own — this note is what explains why.
 */
export function applyAsyncServerComponentFinding(parsed: ParsedPage, fn: FunctionLike, relFile: string): ParsedPage {
  if (!fn.isAsync() || parsed.rootIds.length === 0) return parsed
  const resolution = {
    source: relFile,
    note: `'${componentDisplayName(fn)}' is an async server component — data it awaits (a fetch, a database read, …) can't be statically read, so only literal or statically-derivable content renders here.`,
  }
  const nodes = { ...parsed.nodes }
  for (const rootId of parsed.rootIds) {
    const node = nodes[rootId]
    if (node && !node.resolution) nodes[rootId] = { ...node, resolution }
  }
  return { rootIds: parsed.rootIds, nodes }
}

// ---------------------------------------------------------------------------
// File → component lookup, shared by the page and every layout in its chain.
// ---------------------------------------------------------------------------

function findFileComponent(project: Project, absFile: string): { sourceFile: SourceFile; fn: FunctionLike } | undefined {
  try {
    const sourceFile = project.getSourceFile(absFile) ?? project.addSourceFileAtPath(absFile)
    const declaration = findComponentDeclaration(sourceFile)
    const fn = declaration ? getFunctionLikeNode(declaration) : undefined
    return fn ? { sourceFile, fn } : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether any of `childRootIds` is reachable by following `.children` edges
 * from `patched.rootIds` — i.e. whether the `{children}` splice actually
 * landed somewhere. An empty `childRootIds` (the child page produced zero
 * nodes) trivially "reaches" — there is nothing to fail on, and composing an
 * empty page into its layout is still an honest structural result.
 */
function childrenIdsAppearInTree(patched: ParsedPage, childRootIds: readonly string[]): boolean {
  if (childRootIds.length === 0) return true
  const childSet = new Set(childRootIds)
  const visited = new Set<string>()
  const stack = [...patched.rootIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (childSet.has(id)) return true
    if (visited.has(id)) continue
    visited.add(id)
    const node = patched.nodes[id]
    if (node) stack.push(...node.children)
  }
  return false
}

/**
 * Composes ONE layout file around `childPage` (either the route's own page,
 * or the result of composing a more-nested layout already). Returns
 * `undefined` — decline this layer, and every layer further out — when the
 * file has no parseable component, no JSX-bearing return, or no `{children}`
 * slot `applySubstitutions` can find: a partially-wrong composition (content
 * landing somewhere the source doesn't actually put it) is worse than
 * stopping and showing the page without that layer of chrome.
 *
 * Order matters: `applySubstitutions` (the `{children}` splice) runs BEFORE
 * `inlineLocalComponents`. A layout that renders through its own local
 * wrapper (`<Shell>{children}</Shell>`, `Shell` a local component) parses
 * with `{children}` structurally empty — nothing is bound to it yet — so if
 * `<Shell>` were inlined first, expansion would splice ZERO children into
 * `Shell`'s own markup. Splicing this layout's top-level `{children}` FIRST
 * fills in the `<Shell>` call site's own `children` field with the real page
 * content, so inlining `<Shell>` afterwards carries it one level deeper,
 * correctly.
 */
function composeOneLayout(
  layoutAbsFile: string,
  childPage: ParsedPage,
  project: Project,
  workspaceRoot: string,
  evalOptions: StaticEvalOptions | undefined,
  componentSourcesOut: Record<string, ComponentSource>,
): { page: ParsedPage; relFile: string } | undefined {
  try {
    const found = findFileComponent(project, layoutAbsFile)
    if (!found) return undefined
    const { sourceFile, fn } = found
    const relFile = path.relative(workspaceRoot, layoutAbsFile).split(path.sep).join('/')

    const roots = getReturnedJsxRoots(fn)
    if (roots.length === 0) return undefined

    let layoutParsed = parseJsxTree(roots, sourceFile, relFile, fn, evalOptions)
    if (layoutParsed.rootIds.length === 0) return undefined
    layoutParsed = applyAsyncServerComponentFinding(layoutParsed, fn, relFile)

    // `buildSubstitutionEnv` sets a `children` binding whenever the function's
    // first (destructured) parameter includes one — regardless of any real
    // call-site props, which is exactly right here: there is no call site,
    // only the fact that this function's `children` parameter IS the page.
    const env = buildSubstitutionEnv(fn, {})
    if (![...env.values()].some((sub) => sub.kind === 'children')) return undefined

    const patched = applySubstitutions(roots, layoutParsed, env, childPage.rootIds, sourceFile, relFile, fn, evalOptions)
    if (!childrenIdsAppearInTree(patched, childPage.rootIds)) return undefined

    // The layout's own local components (e.g. a shared `<Navbar/>`) get the
    // exact same treatment a page's do — resolved and inlined AFTER the
    // `{children}` splice above, so content flows through a local wrapper too.
    const sources = resolveComponentSources(project, layoutAbsFile, workspaceRoot, patched)
    Object.assign(componentSourcesOut, sources)
    const expanded = inlineLocalComponents(patched, sources, project, workspaceRoot, { evalOptions })

    return { page: { rootIds: expanded.rootIds, nodes: { ...expanded.nodes, ...childPage.nodes } }, relFile }
  } catch {
    // Never throw — this ONE layer of composition is declined, exactly like
    // `inlineLocalComponents`'s own per-call-site failure handling.
    return undefined
  }
}

export interface ComposeAppRouterRouteOptions {
  /** The route's own `page.tsx`/`page.jsx`, already parsed AND local-component-inlined — exactly the same pipeline every other page goes through. */
  page: ParsedPage
  /** Absolute path to the page's own file — used only to find its `FunctionLike`, for the async-component check. */
  pageAbsFile: string
  /** Absolute paths to the route's layout chain, OUTERMOST first (`collectAppRouterLayoutChain` in `studioProjects.ts`, resolved to absolute). */
  layoutAbsFiles: readonly string[]
  project: Project
  workspaceRoot: string
  evalOptions: StaticEvalOptions | undefined
}

export interface ComposeAppRouterRouteResult {
  /** The composed route tree — `RootLayout(SegmentLayout(Page))`, or just the page when the chain is empty or every layer declined. */
  page: ParsedPage
  /**
   * Node ids contributed by a layout/template file — i.e. every id in
   * `page.nodes` that is NOT one of the route's own page nodes. The "show
   * layout chrome" toggle (frame header, WS-1.3 item 2) is meant to hide
   * exactly these when off — showing the page's own node ids alone shows the
   * page without its layout(s). Not yet wired to a UI control — see the
   * handoff note in `STATE.md`'s `server-04` entry for what's left.
   */
  chromeNodeIds: string[]
  /** Workspace-relative POSIX paths of the layout files actually composed in, outermost first. Shorter than the input chain when composition declined partway up. */
  composedLayoutFiles: string[]
  /** `resolveComponentSources` results for every local component inlined while expanding the layout chain — merge into the caller's page-wide `componentSources` map, same as a page's own. */
  componentSources: Record<string, ComponentSource>
}

/**
 * Composes a Next.js App Router route: the page wrapped by each layout in its
 * chain, innermost first (so the tree wraps correctly outward), plus the
 * async-server-component finding for the page itself. Never throws — a
 * layer that can't compose is simply not included (see `composeOneLayout`).
 */
export function composeAppRouterRoute(opts: ComposeAppRouterRouteOptions): ComposeAppRouterRouteResult {
  const pageRelFile = path.relative(opts.workspaceRoot, opts.pageAbsFile).split(path.sep).join('/')
  const pageComponent = findFileComponent(opts.project, opts.pageAbsFile)
  let composed = pageComponent ? applyAsyncServerComponentFinding(opts.page, pageComponent.fn, pageRelFile) : opts.page

  const pageOwnNodeIds = new Set(Object.keys(composed.nodes))
  const componentSources: Record<string, ComponentSource> = {}
  const composedLayoutFiles: string[] = []

  for (let i = opts.layoutAbsFiles.length - 1; i >= 0; i--) {
    const result = composeOneLayout(
      opts.layoutAbsFiles[i]!,
      composed,
      opts.project,
      opts.workspaceRoot,
      opts.evalOptions,
      componentSources,
    )
    if (!result) break // decline this layer AND everything further out — see `composeOneLayout`'s doc.
    composed = result.page
    composedLayoutFiles.unshift(result.relFile)
  }

  const chromeNodeIds = Object.keys(composed.nodes).filter((id) => !pageOwnNodeIds.has(id))
  return { page: composed, chromeNodeIds, composedLayoutFiles, componentSources }
}
