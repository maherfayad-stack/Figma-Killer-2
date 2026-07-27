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
 * WHY EVERY INLINED NODE IS LOCKED (§2.5) — read this before touching the
 * locking logic below.
 *
 * A component like `Icon` is typically called dozens of times across a page
 * (or across many pages). Every one of those call sites expands into its OWN
 * copy of `Icon.jsx`'s JSX, one per call site (see `INLINE_ID_SEPARATOR`'s
 * doc comment for why they don't collide). If an inlined node's prop/text
 * edits were writable, editing ONE instance's rendered copy would have no
 * sound place to write back to that wouldn't ALSO silently change every other
 * call site sharing that same source file — worse than read-only, because it
 * would look like a normal, isolated edit. There is also structurally no
 * single valid source location for a composite id to write to. So every node
 * this module produces gets `locked: true` with an explanatory `lockReason` —
 * matching the parser's pre-existing "rendered dynamically ⇒ read-only
 * surface" convention (`DYNAMIC_LOCK_REASON` in `./parsePageFile`), which
 * means the editor's existing edit-guards (`nodeActions`, `inlineEditSlice`)
 * already respect it with zero new work on their side.
 *
 * The CALL SITE node itself is the one exception: it's a real, unique
 * location in a real page (or a real, unique location in some ancestor
 * component's file, itself already locked if that ancestor was itself
 * inlined) — so it keeps whatever locked/lockReason it already had, and its
 * own literal props (e.g. `<Icon size={24}/>`'s `size`) remain writable. Only
 * its `kind`/`name`/`children` are rewritten so it renders as a
 * `base.container` wrapping the expanded subtree (via
 * `server/handlers/studio.ts`'s `resolveModuleId`'s existing
 * children-promotion rule — §4), instead of `alm.Icon`'s "Unknown module" box.
 * ---------------------------------------------------------------------------
 *
 * SCOPE (§2.3 — partial evaluation, not an interpreter): the ONLY prop/text
 * shapes this module resolves are (a) a destructured prop forwarded verbatim
 * as `{paramName}` (an attribute value or a lone text child) where the call
 * site passed a literal or the destructure has a literal default, (b)
 * `{children}` splicing, and (c) a `className={\`static ${dynamic}\`}`
 * template literal's static head text (visual-fidelity best-effort only —
 * the node is locked regardless). There is no control-flow execution, no
 * hook evaluation, no context resolution, and no general expression
 * evaluator — every other shape (calls, member chains, spreads, `.map`) is
 * simply left as whatever `parseJsxTree` already produced for it, never
 * guessed at.
 */
import * as path from 'node:path'
import { Node, SyntaxKind, type JsxElement, type JsxSelfClosingElement, type Project, type SourceFile } from 'ts-morph'
import {
  findComponentDeclaration,
  getFunctionLikeNode,
  getReturnedJsxRoot,
  parseJsxTree,
} from './parsePageFile'
import { resolveComponentSources, type ComponentSource } from './componentSources'
import type { FunctionLike, ParsedNode, ParsedPage } from './types'
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

/** Generic container tag used to re-home an expanded call site (§2.5, §4's promotion rule). */
const CONTAINER_ELEMENT_NAME = 'div'

type JsxOpeningLike = JsxElement | JsxSelfClosingElement
type LiteralValue = string | number | boolean

/** What `buildSubstitutionEnv` resolved a destructured prop param to. */
type Substitution = { kind: 'literal'; value: LiteralValue } | { kind: 'children' }

interface ExpandState {
  project: Project
  workspaceRoot: string
  maxDepth: number
  maxNodes: number
  /** §7 — see `InlineOptions.evalOptions`. `undefined` disables value resolution for every inlined subtree, unchanged from pre-§7 behaviour. */
  evalOptions: StaticEvalOptions | undefined
  /** Running total of nodes produced by inlining so far, across the whole page. */
  nodeCount: number
  /**
   * Ids that existed in the page as originally parsed, BEFORE any inlining —
   * real, editable, page-native node ids. `{children}` splicing (§2.3) always
   * references one of these (the call site's own literal JSX children, from
   * real source), and they must NEVER be prefixed by `prefixParsedPage` no
   * matter how many levels of inlining they get spliced through, since their
   * (unprefixed) entry already lives in the merged node map untouched.
   */
  originalIds: ReadonlySet<string>
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
      originalIds: new Set(Object.keys(parsed.nodes)),
    }

    const nodes: Record<string, ParsedNode> = { ...parsed.nodes }
    // Iterate a SNAPSHOT of the original node ids — `expandCallSite` mutates
    // `nodes` (replacing/adding entries) as it goes, and we only ever want to
    // consider call sites that existed in the page as parsed, not ones that
    // inlining itself introduces (those are handled by the recursion, keyed
    // off the sub-tree's OWN sources map).
    for (const id of Object.keys(parsed.nodes)) {
      const source = sources[id]
      if (!source || source.kind !== 'local') continue
      const node = nodes[id]
      if (!node || node.kind !== 'component') continue
      expandCallSite(id, node, source.file, nodes, state, new Set(), 0)
    }

    return { rootIds: [...parsed.rootIds], nodes }
  } catch {
    // Never throw — degrade to the unmodified input page.
    return { rootIds: [...parsed.rootIds], nodes: { ...parsed.nodes } }
  }
}

/**
 * Expands ONE call-site node in place within `nodes` (replacing its entry),
 * merging in the (locked, id-prefixed) subtree produced by parsing and
 * substituting into the target component's own returned JSX. Returns `true`
 * if expansion happened, `false` if the node was left opaque (unresolvable
 * target, cap reached, cycle detected, or any internal parse failure) — the
 * caller does nothing further in that case, leaving the node exactly as it
 * was.
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
  nodes: Record<string, ParsedNode>,
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
    subPage = applySubstitutions(rootExpr, subPage, env, callSiteNode.children, target.sourceFile, targetRelFromRoot)

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
      expandCallSite(id, node, source.file, subPage.nodes, state, nextCyclePath, depth + 1)
    }

    // Prefix every id this subtree owns (§2.4) — deterministic and
    // collision-free even though the SAME component may be inlined at many
    // call sites, because `callSiteId` is unique per call site. Ids already
    // present before ANY inlining (spliced-in `{children}` content) are left
    // untouched — see `originalIds`'s doc comment.
    const prefixed = prefixParsedPage(subPage, callSiteId, state.originalIds)

    for (const [id, node] of Object.entries(prefixed.nodes)) {
      nodes[id] = node
    }
    state.nodeCount += Object.keys(prefixed.nodes).length

    nodes[callSiteId] = {
      ...callSiteNode,
      kind: 'element',
      name: CONTAINER_ELEMENT_NAME,
      children: prefixed.rootIds,
      text: undefined,
    }
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
 * Builds the substitution table (§2.3) from the target component's OWN
 * destructured first-parameter pattern and the call site's literal props.
 * Only a single `{ a, b: renamed, c = 1 }`-shaped object binding pattern is
 * supported (every validation-corpus component uses one) — a non-destructured
 * parameter (`function Foo(props) {…}`), a nested pattern, or a rest element
 * yields no entry for that param, so any `{paramName}` reference to it is
 * simply left unresolved (existing lock/drop path), never guessed at.
 */
function buildSubstitutionEnv(fn: FunctionLike, callSiteProps: Record<string, LiteralValue>): Map<string, Substitution> {
  const env = new Map<string, Substitution>()
  const first = fn.getParameters()[0]
  if (!first) return env

  const pattern = first.getNameNode()
  if (!Node.isObjectBindingPattern(pattern)) return env

  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue // ...rest — unsupported

    const nameNode = element.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue // nested destructuring pattern — unsupported
    const paramName = nameNode.getText()

    const propertyNameNode = element.getPropertyNameNode()
    const attrName = propertyNameNode ? propertyNameNode.getText() : paramName

    if (attrName === 'children') {
      env.set(paramName, { kind: 'children' })
      continue
    }

    if (Object.hasOwn(callSiteProps, attrName)) {
      env.set(paramName, { kind: 'literal', value: callSiteProps[attrName]! })
      continue
    }

    const initializer = element.getInitializer()
    if (!initializer) continue
    if (Node.isStringLiteral(initializer) || Node.isNumericLiteral(initializer)) {
      env.set(paramName, { kind: 'literal', value: initializer.getLiteralValue() })
    } else if (initializer.getKind() === SyntaxKind.TrueKeyword || initializer.getKind() === SyntaxKind.FalseKeyword) {
      env.set(paramName, { kind: 'literal', value: initializer.getKind() === SyntaxKind.TrueKeyword })
    }
    // Any other default (a call, a template literal, …) is not a literal —
    // intentionally left unresolved, same policy as `extractProps`.
  }

  return env
}

/**
 * Patches `subPage` (already structurally correct via `parseJsxTree`) with
 * §2.3's substitutions: a `{paramName}` prop/text reference resolved to a
 * literal via `env`, a `{children}` reference spliced with the call site's
 * own already-parsed children ids, and a `className` template literal's
 * static head text. Does NOT re-derive structure, locking, svg capture, or
 * style extraction — `parseJsxTree` already owns all of that; this only
 * fills in values `extractProps`/`extractSingleText` had to skip because
 * they were identifier references, not literals.
 *
 * Walks `rootExpr` in the same shape as the element tree (JSX
 * element/self-closing/fragment/expression) purely to re-derive each
 * element's id (same `${relFile}:${line}:${col}` convention) and match it
 * against `subPage.nodes` — it does not replicate locking or capture rules,
 * only finds where to patch.
 */
function applySubstitutions(
  rootExpr: Node,
  subPage: ParsedPage,
  env: Map<string, Substitution>,
  callSiteChildrenIds: string[],
  sourceFile: SourceFile,
  relFile: string,
): ParsedPage {
  if (env.size === 0) return subPage
  const nodes = { ...subPage.nodes }

  const idFor = (el: Node): string => {
    const { line, column } = sourceFile.getLineAndColumnAtPos(el.getStart())
    return `${relFile}:${line}:${column}`
  }

  const patchElement = (el: JsxOpeningLike): void => {
    const isElement = Node.isJsxElement(el)
    const tagNameNode = isElement ? el.getOpeningElement().getTagNameNode() : el.getTagNameNode()
    const id = idFor(tagNameNode)
    const existing = nodes[id]
    if (existing) {
      const attributes = isElement ? el.getOpeningElement().getAttributes() : el.getAttributes()

      let patchedProps: Record<string, LiteralValue> | undefined
      for (const attr of attributes) {
        if (!Node.isJsxAttribute(attr)) continue
        const attrName = attr.getNameNode().getText()
        if (attrName in existing.props) continue // already captured as a literal
        const initializer = attr.getInitializer()
        if (!initializer || !Node.isJsxExpression(initializer)) continue
        const expr = initializer.getExpression()
        if (!expr || !Node.isIdentifier(expr)) continue
        const sub = env.get(expr.getText())
        if (sub?.kind !== 'literal') continue
        patchedProps ??= { ...existing.props }
        patchedProps[attrName] = sub.value
      }

      // §2.3's `className={\`static ${dynamic}\`}` row — keep the STATIC
      // head text even though the whole node is locked anyway (visual
      // fidelity, not an editability concern).
      if (!('className' in (patchedProps ?? existing.props))) {
        const classNameAttr = attributes.find(
          (a): a is typeof attributes[number] & { getNameNode(): Node } =>
            Node.isJsxAttribute(a) && a.getNameNode().getText() === 'className',
        )
        const classInitializer = Node.isJsxAttribute(classNameAttr) ? classNameAttr.getInitializer() : undefined
        if (classInitializer && Node.isJsxExpression(classInitializer)) {
          const expr = classInitializer.getExpression()
          if (expr && Node.isTemplateExpression(expr)) {
            const head = expr.getHead().getLiteralText().trim()
            if (head.length > 0) {
              patchedProps ??= { ...existing.props }
              patchedProps.className = head
            }
          }
        }
      }

      let patchedText = existing.text
      if (existing.text === undefined && existing.children.length === 0 && isElement) {
        const meaningful = el
          .getJsxChildren()
          .filter((c) => !(Node.isJsxText(c) && c.getText().trim().length === 0))
        if (meaningful.length === 1 && Node.isJsxExpression(meaningful[0])) {
          const expr = meaningful[0].getExpression()
          if (expr && Node.isIdentifier(expr)) {
            const sub = env.get(expr.getText())
            if (sub?.kind === 'literal') patchedText = String(sub.value)
          }
        }
      }

      let patchedChildren = existing.children
      if (isElement) {
        let insertAt = 0
        for (const child of el.getJsxChildren()) {
          if (Node.isJsxText(child)) continue
          if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child)) {
            insertAt += 1
            continue
          }
          if (Node.isJsxExpression(child)) {
            const expr = child.getExpression()
            if (expr && Node.isIdentifier(expr) && env.get(expr.getText())?.kind === 'children') {
              patchedChildren = [
                ...existing.children.slice(0, insertAt),
                ...callSiteChildrenIds,
                ...existing.children.slice(insertAt),
              ]
            }
          }
        }
      }

      if (patchedProps || patchedText !== existing.text || patchedChildren !== existing.children) {
        nodes[id] = {
          ...existing,
          ...(patchedProps ? { props: patchedProps } : {}),
          ...(patchedText !== undefined ? { text: patchedText } : {}),
          children: patchedChildren,
        }
      }
    }

    if (isElement) {
      for (const child of el.getJsxChildren()) walk(child)
    }
  }

  const walk = (node: Node): void => {
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) {
      patchElement(node)
      return
    }
    if (Node.isJsxFragment(node)) {
      for (const child of node.getJsxChildren()) walk(child)
      return
    }
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression()
      if (expr) walk(expr)
      return
    }
    // Ternary/logical/`.map(...)` bodies — descend to find any JSX literal
    // reachable inside, same reachability `parseJsxTree` already used to
    // decide what got a node at all.
    node.forEachChild(walk)
  }

  walk(rootExpr)

  return { rootIds: subPage.rootIds, nodes }
}

/**
 * Replaces every id `subPage` owns with
 * `${callSiteId}${INLINE_ID_SEPARATOR}${originalId}` (§2.4) — except ids in
 * `originalIds` (real, page-native ids spliced in via `{children}`), which
 * are left exactly as they are at every level of nesting.
 */
function prefixParsedPage(subPage: ParsedPage, callSiteId: string, originalIds: ReadonlySet<string>): ParsedPage {
  const prefix = (id: string): string => (originalIds.has(id) ? id : `${callSiteId}${INLINE_ID_SEPARATOR}${id}`)

  const nodes: Record<string, ParsedNode> = {}
  for (const [id, node] of Object.entries(subPage.nodes)) {
    const newId = prefix(id)
    nodes[newId] = { ...node, id: newId, children: node.children.map(prefix) }
  }
  return { rootIds: subPage.rootIds.map(prefix), nodes }
}
