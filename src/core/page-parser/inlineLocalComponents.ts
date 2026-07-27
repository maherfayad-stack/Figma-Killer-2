/**
 * inlineLocalComponents — expands every `kind:'component'` node in a
 * `ParsedPage` whose `ComponentSource` (from `./componentSources`) is
 * `'local'` into the JSX its own file returns, recursively. Turns a page like
 *
 *   <SheetShell title="Confirm"><Icon svg={x}/></SheetShell>
 *
 * — which today renders three "Unknown module" boxes (`alm.SheetShell`,
 * `alm.Icon`, plus `alm.StatusBar`/`alm.SheetHeader` nested inside
 * `SheetShell`'s own file) — into the actual structural tree those
 * components' own source files describe.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE PRODUCES (§2.5) — read this before touching the structure
 * or provenance logic below.
 *
 * A component like `Icon` is typically called dozens of times across a page
 * (or across many pages). Every one of those call sites expands into its OWN
 * copy of `Icon.jsx`'s JSX (see `INLINE_ID_SEPARATOR`'s doc comment for why
 * they don't collide). Those nodes are EDITABLE: a composite id's writeback
 * target is the tail — the component's own source location, which is a real,
 * valid place to write (`studioEditLocation`). What it is NOT is isolated:
 * one source file backs every instance, so an edit here lands on all of them.
 * That consequence is carried as `ParsedNode.fromComponent` and surfaced to
 * the user on the node rather than by refusing the edit.
 *
 * A node locked for its OWN reason (`.map`/ternary/spread/dynamic value) stays
 * locked — that lock is about having no single valid writeback target at all,
 * which inlining does not change.
 *
 * The CALL SITE node is REPLACED by the component's own root node(s), not
 * kept as a wrapper around them. `<SheetShell/>` renders SheetShell's own
 * root `<div>` at that position — a component call emits no element of its
 * own — so the expanded tree must not either. Leaving a wrapper div behind
 * silently breaks two things at once:
 *
 *   - Percentage and flex height chains. `.sheet-shell { height: 100% }`
 *     resolves against the wrapper's `auto` height, so the shell collapses to
 *     its own content height and every `flex: 1` descendant inside it
 *     (a scroll viewport, typically) computes to 0 — on the eSIM corpus this
 *     clipped 1447px of a screen's body down to nothing.
 *   - Every direct-child and sibling combinator crossing the call site:
 *     `.sheet-shell__panel > .booking-confirmation__scroll` stops matching
 *     once a div sits between them.
 *
 * Both are the same class of bug the per-frame iframe exists to prevent (see
 * `IframeFrameSurface`'s "no `display: contents` NodeWrapper divs" note): the
 * canvas DOM has to be the DOM React renders, or authored CSS quietly means
 * something different here than it does in the app.
 *
 * The trade-off is that a call site's own literal props (`<Icon size={24}/>`'s
 * `size`) are no longer editable as a node, because there is no longer a node
 * for the call site — those values reach the canvas through substitution into
 * the subtree instead (§2.3(a)), and are edited at the source location that
 * actually holds them.
 * ---------------------------------------------------------------------------
 *
 * SCOPE (§2.3 — partial evaluation, not an interpreter): the ONLY prop/text
 * shapes this module resolves are (a) a destructured prop forwarded verbatim
 * as `{paramName}` (an attribute value or a lone text child) where the call
 * site passed a literal or the destructure has a literal default, (b)
 * `{children}` splicing, (c) a `className={\`static ${dynamic}\`}` template
 * literal's static head text (visual-fidelity best-effort only), and (d) the
 * `style={{…}}` object and the `dangerouslySetInnerHTML` markup, re-read
 * against a scope where the component's PARAMETERS are bound to this call
 * site's values (`paramEvalContext`) — the only way a value that only exists
 * at the call site reaches the element that actually renders it.
 *
 * (d) stays inside §7's existing envelope; it adds bindings to a scope, not
 * new evaluation powers. So there is still no control-flow execution and no
 * loop expansion: `applyTokens(svg)` in the corpus's `IllustrationIcon`
 * iterates a substitution table and is therefore Tier D — it does not resolve,
 * and that icon renders empty rather than being guessed at. Every other shape
 * (spreads, `.map`) is likewise left as whatever `parseJsxTree` produced.
 */
import * as path from 'node:path'
import { Node, type Project, type SourceFile } from 'ts-morph'
import {
  findComponentDeclaration,
  getFunctionLikeNode,
  getReturnedJsxRoot,
  parseJsxTree,
} from './parsePageFile'
import { applySubstitutions, buildSubstitutionEnv } from './componentSubstitution'
import { resolveComponentSources, type ComponentSource } from './componentSources'
import type { ParsedNode, ParsedPage } from './types'
import type { StaticEvalOptions } from './staticEval'

export interface InlineOptions {
  /** Hard cap on nesting depth. Default 6. */
  maxDepth?: number
  /** Hard cap on total nodes produced by inlining one page. Default 4000. */
  maxNodes?: number
  /**
   * §7 value resolution, threaded into every locally-inlined component's OWN
   * `parseJsxTree` call (e.g. `SheetHeader.jsx`'s own `useLanguage()` call) —
   * a call site's page-level parse already resolved ITS values before
   * inlining even runs; this is what resolves values reached only once a
   * local component's own file is walked. Omitted entirely (as every
   * pre-§7 caller does) disables value resolution for inlined subtrees too,
   * unchanged.
   */
  evalOptions?: StaticEvalOptions
}

/**
 * Separator between a call-site node's id and the inlined node's own
 * (component-file-relative) id.
 *
 * An inlined node's natural id is its own source location, e.g.
 * `components/Icon.jsx:3:5` — but a component like `Icon` is commonly used
 * dozens of times per page, so every instance would collide on that same id
 * and destroy the flat node map. The rule: an inlined node's id is
 * `` `${callSiteNodeId}${INLINE_ID_SEPARATOR}${componentNodeId}` ``, e.g.
 * `src/screens/HomepageScreen.jsx:77:19~components/Icon.jsx:3:5` —
 * deterministic, collision-free (the call site half is always unique), and
 * encodes provenance for debugging. Nested inlining (a locally-inlined
 * component that itself calls another local component) chains additional
 * segments the same way.
 *
 * Exported so every consumer that needs to recognise a composite id
 * (writeback guards in `server/handlers/studio.ts` and `fsCodemodAdapter.ts`)
 * shares this literal from one place rather than each hardcoding `'~'`.
 */
export const INLINE_ID_SEPARATOR = '~'

const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_NODES = 4000

interface ExpandState {
  project: Project
  workspaceRoot: string
  maxDepth: number
  maxNodes: number
  /** §7 — see `InlineOptions.evalOptions`. `undefined` disables value resolution for every inlined subtree, unchanged from pre-§7 behaviour. */
  evalOptions: StaticEvalOptions | undefined
  /** Running total of nodes produced by inlining so far, across the whole page. */
  nodeCount: number
}

/**
 * Expands every `kind:'component'` node whose `ComponentSource` is `local`
 * into the JSX its own file returns, recursively. Returns a NEW `ParsedPage`;
 * never mutates `parsed`, never throws (mirrors `parsePageFile`'s contract) —
 * any internal failure (unparseable target, unresolvable declaration, cap
 * exceeded, cycle) degrades that ONE call site to its original, un-inlined,
 * opaque form rather than aborting the page.
 *
 * `sources` must be `resolveComponentSources` run against `parsed` — the
 * PRE-inline tree, since it keys off call-site node ids. Nested local
 * components discovered while expanding a sub-tree are resolved fresh against
 * that sub-tree's own file (see `expandCallSite` below) — that is this
 * function's job, not the caller's.
 */
export function inlineLocalComponents(
  parsed: ParsedPage,
  sources: Record<string, ComponentSource>,
  project: Project,
  workspaceRoot: string,
  opts: InlineOptions = {},
): ParsedPage {
  try {
    const state: ExpandState = {
      project,
      workspaceRoot: path.resolve(workspaceRoot),
      maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
      evalOptions: opts.evalOptions,
      nodeCount: Object.keys(parsed.nodes).length,
    }

    const page: ParsedPage = { rootIds: [...parsed.rootIds], nodes: { ...parsed.nodes } }
    // Iterate a SNAPSHOT of the original node ids — `expandCallSite` mutates
    // `page` (removing the call site, adding its expansion) as it goes, and we
    // only ever want to consider call sites that existed in the page as parsed,
    // not ones that inlining itself introduces (those are handled by the
    // recursion, keyed off the sub-tree's OWN sources map).
    for (const id of Object.keys(parsed.nodes)) {
      const source = sources[id]
      if (!source || source.kind !== 'local') continue
      const node = page.nodes[id]
      if (!node || node.kind !== 'component') continue
      expandCallSite(id, node, source.file, page, state, new Set(), 0)
    }

    return page
  } catch {
    // Never throw — degrade to the unmodified input page.
    return { rootIds: [...parsed.rootIds], nodes: { ...parsed.nodes } }
  }
}

/**
 * Expands ONE call-site node within `page`: merges in the (id-prefixed) subtree
 * produced by parsing and substituting into the target component's own returned
 * JSX, then REPLACES the call-site node with that subtree's root(s) wherever it
 * was referenced (see this module's header — a call site is not an element).
 * Returns `true` if expansion happened, `false` if the node was left opaque
 * (unresolvable target, cap reached, cycle detected, or any internal parse
 * failure) — the caller does nothing further in that case, leaving the node
 * exactly as it was.
 *
 * `cyclePath` is the set of `${file}#${exportName}` keys on the CURRENT
 * recursion path (not a global visited set — the same component legitimately
 * expands at multiple, unrelated call sites; only re-entering itself along
 * one path is a cycle).
 */
function expandCallSite(
  callSiteId: string,
  callSiteNode: ParsedNode,
  targetRelFile: string,
  page: ParsedPage,
  state: ExpandState,
  cyclePath: Set<string>,
  depth: number,
): boolean {
  if (depth >= state.maxDepth) return false
  if (state.nodeCount >= state.maxNodes) return false

  try {
    const targetAbsPath = path.resolve(state.workspaceRoot, targetRelFile)
    const identifier = callSiteNode.name.split('.')[0]!
    // The call site's OWN file — needed to tell whether `identifier` is a
    // default import, a named import (honouring a rename), or declared
    // directly in that same file (see `resolveCallTarget`).
    const callerAbsPath = path.resolve(state.workspaceRoot, callSiteNode.loc.file)
    const callerSourceFile = state.project.getSourceFile(callerAbsPath)
    const target = callerSourceFile
      ? resolveCallTarget(callerSourceFile, identifier, targetAbsPath, state.project)
      : defaultExportTarget(targetAbsPath, state.project)
    if (!target) return false

    const cycleKey = `${target.sourceFile.getFilePath()}#${target.exportedName ?? 'default'}`
    if (cyclePath.has(cycleKey)) return false

    const declaration = target.exportedName === undefined
      ? findComponentDeclaration(target.sourceFile)
      : findNamedComponentDeclaration(target.sourceFile, target.exportedName, !target.sameFile)
    const fn = declaration ? getFunctionLikeNode(declaration) : undefined
    const rootExpr = fn ? getReturnedJsxRoot(fn) : undefined
    if (!rootExpr || !fn) return false

    const targetRelFromRoot = path.relative(state.workspaceRoot, target.sourceFile.getFilePath()).split(path.sep).join('/')
    let subPage = parseJsxTree(rootExpr, target.sourceFile, targetRelFromRoot, state.workspaceRoot, fn, state.evalOptions)
    const env = buildSubstitutionEnv(fn, callSiteNode.props)
    subPage = applySubstitutions(rootExpr, subPage, env, callSiteNode.children, target.sourceFile, targetRelFromRoot, fn, state.evalOptions)

    // §2.5 — tag every node this call site's subtree produces with the
    // component whose file it came from. These nodes are EDITABLE: their
    // writeback target is that component's own source location (the tail of
    // the composite id — see `studioEditLocation`), which is a real, valid
    // place to write. What the tag carries is the consequence: one source file
    // backs every instance, so an edit here lands on all of them. The editor
    // surfaces that as a warning on the node rather than refusing the edit.
    //
    // A node that is locked for its OWN reason (`.map`/ternary/spread/dynamic
    // SVG) stays locked — that lock is about the node having no single valid
    // writeback target at all, which inlining does not change. Must happen
    // BEFORE recursing so a deeper inlining's own tag isn't clobbered below.
    const displayName = callSiteNode.name
    for (const node of Object.values(subPage.nodes)) {
      if (!node.fromComponent) node.fromComponent = displayName
    }

    // Recurse into the sub-tree's own local components — resolved fresh
    // against ITS OWN file, since `sources` (this function's caller's
    // parameter) only classified the ORIGINAL page's call sites.
    const subSources = resolveComponentSources(state.project, target.sourceFile.getFilePath(), state.workspaceRoot, subPage)
    const nextCyclePath = new Set(cyclePath)
    nextCyclePath.add(cycleKey)
    for (const id of Object.keys(subPage.nodes)) {
      const source = subSources[id]
      if (!source || source.kind !== 'local') continue
      const node = subPage.nodes[id]
      if (!node || node.kind !== 'component') continue
      expandCallSite(id, node, source.file, subPage, state, nextCyclePath, depth + 1)
    }

    // Prefix every id this subtree owns (§2.4) — deterministic and
    // collision-free even though the SAME component may be inlined at many
    // call sites, because `callSiteId` is unique per call site.
    const prefixed = prefixParsedPage(subPage, callSiteId)

    for (const [id, node] of Object.entries(prefixed.nodes)) {
      page.nodes[id] = node
    }
    state.nodeCount += Object.keys(prefixed.nodes).length

    // The call site itself contributes no element — its expansion takes its
    // place, wherever it was referenced (module header, "The CALL SITE node is
    // REPLACED"). A fragment root legitimately yields several roots; they all
    // splice in at the call site's position, in order.
    delete page.nodes[callSiteId]
    spliceReference(page, callSiteId, prefixed.rootIds)
    return true
  } catch {
    // Any unexpected failure (syntax error in the target file, an
    // unsupported ts-morph shape, …) leaves this ONE call site opaque —
    // exactly today's "Unknown module" behaviour — rather than losing the
    // rest of the page.
    return false
  }
}

interface CallTarget {
  sourceFile: SourceFile
  /** `undefined` = resolve the target file's DEFAULT export. */
  exportedName: string | undefined
  /**
   * `true` when the call site's identifier is declared directly in its OWN
   * file (a private helper component, e.g. `BookingReferenceRow` inside
   * `BookingDetailsScreen.jsx` — never imported, and often never `export`ed
   * at all since nothing outside the file needs to see it).
   * `findNamedComponentDeclaration` must NOT require `isExported()` in this
   * case — `export` only matters for a CROSS-FILE import to succeed (which
   * `componentSources.ts` already verified when it classified this as
   * `local` in the first place); it says nothing about same-file visibility.
   */
  sameFile: boolean
}

/**
 * Resolves which declaration inside `targetSourceFile` the JSX tag
 * `identifier` (used in `callerSourceFile`) actually refers to — a default
 * import, a named import (honouring a rename, `import { Foo as Bar }`), or a
 * same-file declaration (a small helper component defined directly in the
 * page/component file that calls it, never imported at all).
 */
function resolveCallTarget(
  callerSourceFile: SourceFile,
  identifier: string,
  targetAbsPath: string,
  project: Project,
): CallTarget | undefined {
  const targetSourceFile = project.getSourceFile(targetAbsPath)
  if (!targetSourceFile) return undefined

  if (path.resolve(callerSourceFile.getFilePath()) === path.resolve(targetAbsPath)) {
    return { sourceFile: targetSourceFile, exportedName: identifier, sameFile: true }
  }

  for (const decl of callerSourceFile.getImportDeclarations()) {
    const defaultImport = decl.getDefaultImport()
    if (defaultImport?.getText() === identifier) {
      return { sourceFile: targetSourceFile, exportedName: undefined, sameFile: false }
    }
    for (const named of decl.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getNameNode().getText()
      if (localName === identifier) {
        return { sourceFile: targetSourceFile, exportedName: named.getNameNode().getText(), sameFile: false }
      }
    }
  }
  return undefined
}

/** Fallback for the (unexpected) case the caller's own SourceFile couldn't be found — resolve the target's default export. */
function defaultExportTarget(targetAbsPath: string, project: Project): CallTarget | undefined {
  const targetSourceFile = project.getSourceFile(targetAbsPath)
  if (!targetSourceFile) return undefined
  return { sourceFile: targetSourceFile, exportedName: undefined, sameFile: false }
}

/**
 * Finds a specific NAMED (non-default) declaration — a function declaration
 * or a `const` with a function/arrow initializer. `requireExport` is `false`
 * only for a same-file declaration (see `CallTarget.sameFile`'s doc comment)
 * — a cross-file named import can only exist if the target IS exported
 * (`componentSources.ts` already verified that via ts-morph's own import
 * resolution), so `requireExport` stays `true` there as a defence-in-depth
 * check, not a guess.
 */
function findNamedComponentDeclaration(sourceFile: SourceFile, name: string, requireExport: boolean): Node | undefined {
  const fn = sourceFile.getFunction(name)
  if (fn && (!requireExport || fn.isExported())) return fn

  const variableDecl = sourceFile.getVariableDeclaration(name)
  if (variableDecl) {
    const statement = variableDecl.getVariableStatement()
    const init = variableDecl.getInitializer()
    if ((!requireExport || statement?.isExported()) && init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return variableDecl
    }
  }
  return undefined
}

/**
 * Replaces every id `subPage` OWNS with
 * `${callSiteId}${INLINE_ID_SEPARATOR}${originalId}` (§2.4).
 *
 * "Owns" is decided structurally: an id present in `subPage.nodes`. Anything
 * `subPage` merely *references* without holding — a `{children}` splice point
 * (§2.3(b)), whose nodes live in the enclosing page's map — is left exactly as
 * it is, at every level of nesting, because its entry over there is what the
 * reference has to keep pointing at.
 *
 * Reading it off the node map rather than threading a set of "ids that existed
 * before inlining" is what makes it correct under call-site replacement: a
 * nested expansion's replacement ids are in `subPage.nodes`, so they still get
 * prefixed here and stay unique per call site, while spliced-in children — the
 * only dangling references a subtree can hold — still don't.
 */
function prefixParsedPage(subPage: ParsedPage, callSiteId: string): ParsedPage {
  const prefix = (id: string): string =>
    subPage.nodes[id] ? `${callSiteId}${INLINE_ID_SEPARATOR}${id}` : id

  const nodes: Record<string, ParsedNode> = {}
  for (const [id, node] of Object.entries(subPage.nodes)) {
    const newId = prefix(id)
    nodes[newId] = { ...node, id: newId, children: node.children.map(prefix) }
  }
  return { rootIds: subPage.rootIds.map(prefix), nodes }
}

/**
 * Splices `withIds` in for the single reference to `id` — in whichever node's
 * `children` holds it, or in `page.rootIds` when the call site was a root.
 *
 * A tree references each id exactly once, so the first hit is the only hit.
 * Scanning for it beats threading a child→parent map: expansion order is not
 * top-down (an inner call site can be expanded before the outer one that
 * splices its children), so any precomputed parent map would be stale by the
 * time it was read.
 */
function spliceReference(page: ParsedPage, id: string, withIds: readonly string[]): void {
  const spliced = (ids: string[]): string[] | null => {
    const at = ids.indexOf(id)
    return at === -1 ? null : [...ids.slice(0, at), ...withIds, ...ids.slice(at + 1)]
  }

  const roots = spliced(page.rootIds)
  if (roots) {
    page.rootIds.splice(0, page.rootIds.length, ...roots)
    return
  }
  for (const [nodeId, node] of Object.entries(page.nodes)) {
    const children = spliced(node.children)
    if (children) {
      page.nodes[nodeId] = { ...node, children }
      return
    }
  }
}
