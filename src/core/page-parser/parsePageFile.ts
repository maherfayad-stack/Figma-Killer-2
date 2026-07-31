/**
 * parsePageFile — parses a React page `.tsx` file into a neutral, flat
 * element/instance tree (see `types.ts`).
 *
 * This is the read half of a design-tool's load step: it walks the JSX
 * returned by the page's exported component and produces one `ParsedNode`
 * per JSXElement/JSXSelfClosingElement, with a source location that is
 * compatible with `../ast-codemods` (same tag-name-start convention), plus
 * "editable-surface" locking for JSX that is rendered dynamically (from a
 * `.map(...)` callback, a conditional/logical expression, or via spread
 * props) rather than structurally present in the static tree.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * 1-based line, 1-based column of the JSX element's tag-name identifier
 * start (the character immediately after `<`). Using ts-morph, that's
 * `tagNameNode.getStart()` converted via `sourceFile.getLineAndColumnAtPos`,
 * which already returns 1-based line/column.
 */
import * as path from 'node:path'
import {
  Node,
  Project,
  SyntaxKind,
  type JsxElement,
  type JsxSelfClosingElement,
  type ReturnStatement,
  type SourceFile,
} from 'ts-morph'
import type { FunctionLike, NodeLoc, ParsedNode, ParsedPage } from './types'
import { createEvalScope, type StaticEvalOptions } from './staticEval'
import { withResolutionLock } from './resolutionLock'
import {
  extractInlineStyles,
  extractProps,
  extractRawSvgMarkup,
  extractSingleText,
  LOOP_ID_SEPARATOR,
  type ParseContext,
} from './jsxAttributeReaders'
import { iterationEvalContext, loopCallbackBody, readStaticLoop } from './staticLoopExpansion'
import { serializeInlineSvg } from './inlineSvg'

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

const DYNAMIC_LOCK_REASON = 'dynamic — rendered in code'
const SPREAD_LOCK_REASON = 'spread props'
const DYNAMIC_SVG_LOCK_REASON = 'SVG built in code'
/** One of several `return`s in a component — see `getReturnedJsxRoots`. */
const BRANCH_LOCK_REASON = 'one branch of several — chosen in code'

/**
 * `project` defaults to a fresh, single-file `Project` (this file only) —
 * exactly the isolated behavior every existing caller relies on. Pass a
 * shared, workspace-wide `Project` (`../page-parser` → `createWorkspaceProject`)
 * when parsing every page of one workspace load, so cross-file imports (a
 * page importing a local component) can later be resolved against the SAME
 * parsed `SourceFile` via `resolveComponentSources` — a fresh per-file
 * Project can't see other files at all.
 */
export function parsePageFile(
  file: string,
  appDir: string,
  project: Project = new Project({ useInMemoryFileSystem: false }),
  evalOptions?: StaticEvalOptions,
): ParsedPage {
  try {
    const sourceFile = project.getSourceFile(file) ?? project.addSourceFileAtPath(file)
    const relFile = path.relative(appDir, path.resolve(file)).split(path.sep).join('/')

    const componentDecl = findComponentDeclaration(sourceFile)
    const fn = componentDecl ? getFunctionLikeNode(componentDecl) : undefined
    const roots = fn ? getReturnedJsxRoots(fn) : []

    if (roots.length === 0) return { rootIds: [], nodes: {} }

    return parseJsxTree(roots, sourceFile, relFile, fn, evalOptions)
  } catch {
    // Never throw on ordinary pages — anything unexpected just yields an
    // empty (unparsed) page rather than a crash for the caller.
    return { rootIds: [], nodes: {} }
  }
}

/**
 * Walks `rootExpr` (the JSX a component's return statement produces) into a
 * `ParsedPage`, exactly the tree-walk `parsePageFile` runs for a whole page —
 * extracted so `inlineLocalComponents` (§2) can reuse the SAME walk for a
 * local component's own returned JSX rather than re-implementing
 * `processElement`/`processChildren`/the locking rules/svg capture/etc.
 * `relFile` is the workspace-relative POSIX path to attribute produced node
 * ids and locations to (the component's OWN file when called for inlining,
 * not the page that references it).
 *
 * Not wrapped in try/catch itself — `parsePageFile` and `inlineLocalComponents`
 * each own their own top-level guard, since what "failure degrades to" differs
 * (an empty page vs. leaving one call site un-inlined).
 *
 * `componentFn`/`evalOptions` (§7) opt this parse into value resolution:
 * `componentFn` is the component whose OWN JSX this is (supplies its
 * component-body `const`/hook-destructuring bindings to the evaluator's
 * scope — see `createEvalScope`), and `evalOptions` carries the evaluator's
 * tuning plus the page-wide step budget shared across the whole page load,
 * including every locally-inlined subtree (`inlineLocalComponents` threads
 * the SAME `evalOptions` into its own recursive `parseJsxTree` calls). Both
 * are omitted by every caller that hasn't opted in — `extractProps`/
 * `extractInlineStyles`/`extractSingleText` then keep their pre-§7 literal-
 * only behaviour exactly, at zero extra cost.
 */
export function parseJsxTree(
  roots: readonly ReturnedJsx[],
  sourceFile: SourceFile,
  relFile: string,
  componentFn?: FunctionLike,
  evalOptions?: StaticEvalOptions,
): ParsedPage {
  const ctx: ParseContext = {
    sourceFile,
    relFile,
    nodes: {},
    ...(evalOptions ? { eval: { scope: createEvalScope(sourceFile, componentFn), options: evalOptions } } : {}),
  }
  // One `ctx` across every return, so ids and the eval budget are shared: two
  // returns in one component can never collide (their JSX is at different
  // source locations) and the page-wide step budget stays page-wide.
  const rootIds = roots.flatMap((root) => collectRootIds(root, ctx))
  return { rootIds, nodes: ctx.nodes }
}

// ---------------------------------------------------------------------------
// Component discovery: find the page's exported React component and the
// JSX it returns.
// ---------------------------------------------------------------------------

/**
 * Finds the declaration of the page's exported React component:
 *   1. `export default function Foo() {...}`
 *   2. `export default Foo` / `export default () => {...}` (resolves the
 *      identifier back to its local function/const declaration)
 *   3. The first exported function declaration or `const` with a
 *      function/arrow initializer, in source order.
 */
export function findComponentDeclaration(sourceFile: SourceFile): Node | undefined {
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isDefaultExport()) return fn
  }

  const exportAssignment = sourceFile.getExportAssignments().find((ea) => !ea.isExportEquals())
  if (exportAssignment) {
    const expr = exportAssignment.getExpression()
    if (Node.isIdentifier(expr)) {
      const declarations = expr.getSymbol()?.getDeclarations() ?? []
      const match = declarations.find((d) => Node.isVariableDeclaration(d) || Node.isFunctionDeclaration(d))
      if (match) return match
    } else if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      return expr
    }
  }

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isExported()) {
      return statement
    }
    if (Node.isVariableStatement(statement) && statement.isExported()) {
      for (const decl of statement.getDeclarations()) {
        const init = decl.getInitializer()
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return decl
        }
      }
    }
  }

  return undefined
}

/** Unwraps a `VariableDeclaration` down to its function/arrow initializer. */
export function getFunctionLikeNode(decl: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    return decl
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer()
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init
    }
  }
  return undefined
}

/** One `return` in a component's body, and whether it is the only one. */
export interface ReturnedJsx {
  expr: Node
  /**
   * True when the component has more than one `return` — at runtime exactly one
   * of them renders, and which one is a branch decision the parser does not make.
   */
  conditional: boolean
}

/**
 * Every JSX-producing `return` in a component's body, in source order.
 *
 * For a concise arrow body (`() => (<div/>)`) that is the body itself. For a
 * block body it is EVERY `return` statement belonging directly to this function
 * — nested function/arrow scopes (event handlers, `.map` callbacks) are not
 * descended into, since their returns belong to a different component.
 *
 * WHY ALL OF THEM, not the outermost one. This used to sort by block depth and
 * take the shallowest, which systematically picked the fallback and dropped the
 * special case: a multi-stage screen collapsed to its last `return`, and
 * `EsimAddonIcon`'s data-usage ring (a whole `<svg>` + label, behind
 * `if (type === 'ring')`) never appeared on any of the four cards that use it.
 *
 * Rendering all of them is the SAME rule this parser already applies one level
 * down, where a ternary or `&&` contributes nodes for both sides: conditional
 * content is shown and locked, never silently chosen between. Choosing WOULD
 * require evaluating the condition, which is the banned tier.
 */
export function getReturnedJsxRoots(fn: FunctionLike): ReturnedJsx[] {
  const body = fn.getBody()
  if (!body) return []

  if (!Node.isBlock(body)) {
    return [{ expr: unwrapParens(body), conditional: false }]
  }

  const returns: ReturnStatement[] = []
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      traversal.skip()
      return
    }
    if (Node.isReturnStatement(node)) returns.push(node)
  })

  // Only JSX-BEARING returns count towards "more than one". `if (!data) return
  // null` is the most common early return there is, and it contributes no nodes
  // — letting it mark the component's real tree conditional would lock an entire
  // editable screen for a guard clause.
  const exprs: Node[] = []
  for (const statement of returns) {
    const expr = statement.getExpression()
    if (!expr) continue
    const unwrapped = unwrapParens(expr)
    if (containsJsx(unwrapped)) exprs.push(unwrapped)
  }

  return exprs.map((expr) => ({ expr, conditional: exprs.length > 1 }))
}

const JSX_ROOT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.JsxElement,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.JsxFragment,
])

/** Whether `node` is JSX or has JSX anywhere inside it (`cond ? <A/> : <B/>`). */
function containsJsx(node: Node): boolean {
  if (JSX_ROOT_KINDS.has(node.getKind())) return true
  return node.getFirstDescendant((d) => JSX_ROOT_KINDS.has(d.getKind())) !== undefined
}

function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression()
  }
  return current
}

// ---------------------------------------------------------------------------
// JSX tree walk
// ---------------------------------------------------------------------------

function collectRootIds(root: ReturnedJsx, ctx: ParseContext): string[] {
  const { expr: rootExpr } = root
  // One of several `return`s: the subtree renders, but which branch runs is a
  // condition this parser does not evaluate, so it is not an editable surface —
  // exactly the treatment a ternary's two sides already get.
  const branchLocked = root.conditional
  const branchReason = branchLocked ? BRANCH_LOCK_REASON : undefined

  if (Node.isJsxElement(rootExpr) || Node.isJsxSelfClosingElement(rootExpr)) {
    return [processElement(rootExpr, ctx, branchLocked, branchReason)]
  }
  if (Node.isJsxFragment(rootExpr)) {
    return processChildren(rootExpr.getJsxChildren(), ctx, branchLocked, branchReason)
  }
  // The component's own return is itself a dynamic expression (e.g.
  // `return cond ? <A/> : <B/>`) — still walk it, honoring the same locking
  // rule as a nested `{...}` child would get.
  const triggers = isLockingExpression(rootExpr)
  return collectFromExpression(
    rootExpr,
    ctx,
    triggers || branchLocked,
    triggers ? DYNAMIC_LOCK_REASON : branchReason,
  )
}

/**
 * The three JSX-bearing shapes an expression can take, dispatched the same way
 * everywhere: an element, a fragment, or something that merely *contains* JSX.
 *
 * `collectFromExpression` walks DESCENDANTS, so it never sees an expression that
 * is itself an element — hence this wrapper rather than calling it directly.
 */
function collectJsx(
  expr: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
): string[] {
  if (Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr)) {
    return [processElement(expr, ctx, locked, reason)]
  }
  if (Node.isJsxFragment(expr)) {
    return processChildren(expr.getJsxChildren(), ctx, locked, reason)
  }
  return collectFromExpression(expr, ctx, locked, reason)
}

/**
 * Expands `items.map(item => <Row/>)` into one subtree per item, or returns
 * `undefined` to leave the expression opaque (today's single locked
 * placeholder). See `staticLoopExpansion` for what qualifies and why this is
 * not the banned "execute the code" tier.
 */
function expandStaticLoop(expr: Node, ctx: ParseContext): string[] | undefined {
  const evalCtx = ctx.eval
  if (!evalCtx) return undefined
  const loop = readStaticLoop(expr, evalCtx)
  if (!loop) return undefined
  const body = loopCallbackBody(loop.callback)
  if (!body) return undefined

  const ids: string[] = []
  loop.items.forEach((item, index) => {
    const iterationCtx: ParseContext = {
      ...ctx,
      eval: iterationEvalContext(loop, item, index, evalCtx),
      idSuffix: `${ctx.idSuffix ?? ''}${LOOP_ID_SEPARATOR}${index}`,
    }
    // Locked with a reason naming the item, not the generic dynamic-surface
    // message: the row IS resolved, it just has no isolated place to write to.
    ids.push(...collectJsx(body, iterationCtx, true, `item ${index + 1} of ${loop.sourceText}`))
  })
  return ids
}

/**
 * The `ParsedNode.codeProps` list for one element: prop names whose value is
 * code, plus its style properties under the `style:` prefix the editor's
 * inline-style surface reads back.
 */
function codePropNames(propNames: string[], styleNames: string[]): string[] {
  return [...propNames, ...styleNames.map((key) => `style:${key}`)]
}

/** Creates the `ParsedNode` for one JSXElement/JSXSelfClosingElement. */
function processElement(
  element: JsxOpeningLike,
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
): string {
  const tagNameNode = Node.isJsxElement(element)
    ? element.getOpeningElement().getTagNameNode()
    : element.getTagNameNode()

  const name = tagNameNode.getText()
  const kind: ParsedNode['kind'] = /^[A-Z]/.test(name) ? 'component' : 'element'

  const pos = tagNameNode.getStart()
  const { line, column } = ctx.sourceFile.getLineAndColumnAtPos(pos)
  const loc: NodeLoc = { file: ctx.relFile, line, col: column }
  // `loc` stays the real source location even for an expanded loop iteration —
  // that IS where this element is written. Only the id is made unique.
  const id = `${ctx.relFile}:${line}:${column}${ctx.idSuffix ?? ''}`

  const attributes = Node.isJsxElement(element)
    ? element.getOpeningElement().getAttributes()
    : element.getAttributes()

  const hasSpread = attributes.some((a) => Node.isJsxSpreadAttribute(a))
  const locked = inheritedLocked || hasSpread
  const lockReason = inheritedLocked ? inheritedReason : hasSpread ? SPREAD_LOCK_REASON : undefined

  const propsResult = extractProps(attributes, ctx, kind)
  const styleResult = extractInlineStyles(attributes, ctx)

  // <svg> is captured as one opaque unit for `base.svg` (raw inline markup) —
  // do NOT recurse into <path>/<circle>/<g>/… below, they are not page-tree
  // modules. `className`/`style` are still captured above so they reach the
  // canvas (§4/§6 depend on that).
  if (kind === 'element' && name.toLowerCase() === 'svg') {
    // Serialised from the JSX rather than copied out of the source text: the
    // source is JSX, not markup — `className=` is not a class attribute, and an
    // embedded expression (`strokeDashoffset={C*(1-pct/100)}`) is not an
    // attribute value at all. `serializeInlineSvg` resolves those through §7 and
    // writes real attribute names. Copying the text verbatim, and blanking the
    // whole graphic whenever it contained a `{`, is what left six empty rings on
    // the eSIM corpus.
    const markup = serializeInlineSvg(element, ctx.eval)
    // Nothing usable came back (a spread-driven or oversized graphic). Keep the
    // node so its class/style/position are still visible, but lock it — there is
    // no markup to edit. A `.map`/ternary/spread lock upstream, if any, is
    // superseded by this more specific reason.
    const svgLock = withResolutionLock(
      locked || markup === undefined,
      markup === undefined ? DYNAMIC_SVG_LOCK_REASON : lockReason,
      [...propsResult.resolutions, ...styleResult.resolutions],
    )
    const svgNode: ParsedNode = {
      id,
      kind,
      name,
      props: markup === undefined ? propsResult.props : { ...propsResult.props, svg: markup },
      children: [],
      loc,
      locked: svgLock.locked,
      ...(svgLock.lockReason ? { lockReason: svgLock.lockReason } : {}),
      // `svg` is markup serialised from the JSX children, not an attribute —
      // there is nothing at this location for a scalar write to land on.
      codeProps: codePropNames([...propsResult.codeProps, 'svg'], styleResult.codeStyles),
      ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
      ...(svgLock.resolution ? { resolution: svgLock.resolution } : {}),
    }
    ctx.nodes[id] = svgNode
    return id
  }

  // `dangerouslySetInnerHTML={{ __html: rawSvgImport }}` — the standard way a
  // real repo inlines an icon. The element keeps its own tag, classes, and
  // inline styles (they size and colour the icon); the resolved markup rides
  // along on `svg`, which `resolveModuleId` uses to pick `base.svg`. Children
  // are irrelevant here — React ignores them when this prop is set.
  const rawSvg = extractRawSvgMarkup(attributes, ctx)
  if (rawSvg !== undefined) {
    const rawLock = withResolutionLock(locked, lockReason, [...propsResult.resolutions, ...styleResult.resolutions])
    const rawNode: ParsedNode = {
      id,
      kind,
      name,
      props: { ...propsResult.props, svg: rawSvg },
      children: [],
      loc,
      locked: rawLock.locked,
      ...(rawLock.lockReason ? { lockReason: rawLock.lockReason } : {}),
      // `svg` is resolved out of `dangerouslySetInnerHTML={{__html: …}}`, an
      // expression — see the sibling branch above.
      codeProps: codePropNames([...propsResult.codeProps, 'svg'], styleResult.codeStyles),
      ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
      ...(rawLock.resolution ? { resolution: rawLock.resolution } : {}),
    }
    ctx.nodes[id] = rawNode
    return id
  }

  const rawChildren = Node.isJsxElement(element) ? element.getJsxChildren() : []
  const children = Node.isJsxElement(element) ? processChildren(rawChildren, ctx, locked, lockReason) : []
  // Capture text whether or not the node is locked.
  //
  // This used to skip locked nodes, reasoning that a node with no writeback path
  // should not imply an editable surface. But `locked` is what carries that
  // meaning — the editor's edit guards read it — and withholding the text does
  // not make a node less editable, it makes it BLANK. Every `.map` row, every
  // `{cond && <span>Saved</span>}`, every spread-bearing element rendered as an
  // empty box on the canvas while its text sat in plain sight in the source.
  //
  // §7 already settled this the other way: a resolved value sets `text` AND
  // locks the node (`withResolutionLock`). The two rules contradicted each
  // other; this is the one that shows the user their screen.
  const textResult = extractSingleText(rawChildren, ctx)
  const text = textResult?.text

  const lock = withResolutionLock(locked, lockReason, [
    ...(textResult?.resolution ? [textResult.resolution] : []),
    ...propsResult.resolutions,
    ...styleResult.resolutions,
  ])

  const codeProps = codePropNames(propsResult.codeProps, styleResult.codeStyles)

  const node: ParsedNode = {
    id,
    kind,
    name,
    props: propsResult.props,
    children,
    loc,
    locked: lock.locked,
    ...(lock.lockReason ? { lockReason: lock.lockReason } : {}),
    ...(codeProps.length > 0 ? { codeProps } : {}),
    ...(textResult?.resolution ? { codeText: true } : {}),
    ...(text !== undefined ? { text } : {}),
    // Only when the text came from a `.map` iteration's own scope would this be
    // ambiguous, and `idSuffix` marks those ids as unwritable anyway.
    ...(textResult?.origin ? { textOrigin: textResult.origin } : {}),
    // WS-8.3 — where the import naming this node's resolved image lives, when
    // one of its props traced back to one. See `ParsedNode.assetOrigin`.
    ...(propsResult.assetOrigin ? { assetOrigin: propsResult.assetOrigin } : {}),
    ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
    ...(lock.resolution ? { resolution: lock.resolution } : {}),
  }
  ctx.nodes[id] = node

  return id
}


/**
 * Walks a JSX element's children (`getJsxChildren()` output). Plain text is
 * skipped (not a node). Fragments are flattened (not a node themselves, but
 * their children become children of the enclosing element). `{expression}`
 * containers are not nodes either, but any JSX literal reachable inside one
 * is — locked when the expression is a dynamic-rendering construct.
 */
function processChildren(
  children: Node[],
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
): string[] {
  const ids: string[] = []

  for (const child of children) {
    if (Node.isJsxText(child)) continue

    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) {
      ids.push(processElement(child, ctx, inheritedLocked, inheritedReason))
      continue
    }

    if (Node.isJsxFragment(child)) {
      ids.push(...processChildren(child.getJsxChildren(), ctx, inheritedLocked, inheritedReason))
      continue
    }

    if (Node.isJsxExpression(child)) {
      const expr = child.getExpression()
      if (!expr) continue

      const expanded = expandStaticLoop(expr, ctx)
      if (expanded) {
        ids.push(...expanded)
        continue
      }

      const triggers = isLockingExpression(expr)
      const locked = inheritedLocked || triggers
      const reason = inheritedLocked ? inheritedReason : triggers ? DYNAMIC_LOCK_REASON : undefined
      ids.push(...collectFromExpression(expr, ctx, locked, reason))
    }
  }

  return ids
}

/**
 * Finds the "top-level" JSX elements reachable inside an arbitrary
 * expression (e.g. the body of a `.map` callback, or the branches of a
 * ternary/logical expression), without descending into elements once found
 * — their own children are handled by `processElement` → `processChildren`
 * as usual.
 *
 * A `.map` met on the way down is EXPANDED here, not walked into. Loop
 * expansion used to live only in `processChildren`, so it fired for a list
 * written as a direct `{items.map(…)}` child and silently did not for the same
 * list written one wrapper deeper — `{cond ? A.map(…) : B.map(…)}`, `{ok &&
 * items.map(…)}`, or a `return` that is itself the ternary. The list then
 * collapsed to ONE row per branch, with every value that depended on the loop
 * item left unresolved: the corpus's package picker rendered two blank radio
 * rows instead of four priced ones. Which of two equivalent ways a repo happens
 * to write its list is not something the result may depend on.
 */
function collectFromExpression(
  expr: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
): string[] {
  const ids: string[] = []

  expr.forEachDescendant((node, traversal) => {
    const expanded = expandStaticLoop(node, ctx)
    if (expanded) {
      ids.push(...expanded)
      traversal.skip()
      return
    }
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) {
      ids.push(processElement(node, ctx, locked, reason))
      traversal.skip()
    }
    // JsxFragment nodes are intentionally not skipped — traversal continues
    // into their children so those get flattened in automatically.
  })

  return ids
}

/**
 * An element is on the "dynamic surface" (locked) when it is rendered from
 * inside a `.map(...)` callback (a CallExpression), or a
 * conditional/ternary or logical (`&&` / `||`) JSX expression, rather than
 * being structurally present in the static tree.
 */
function isLockingExpression(expr: Node): boolean {
  const node = unwrapParens(expr)

  if (Node.isCallExpression(node)) return true
  if (Node.isConditionalExpression(node)) return true
  if (Node.isBinaryExpression(node)) {
    const opKind = node.getOperatorToken().getKind()
    return opKind === SyntaxKind.AmpersandAmpersandToken || opKind === SyntaxKind.BarBarToken
  }

  return false
}
