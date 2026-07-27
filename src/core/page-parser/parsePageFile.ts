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
  buildImageImportMap,
  extractInlineStyles,
  extractProps,
  extractRawSvgMarkup,
  extractSingleText,
  LOOP_ID_SEPARATOR,
  type ParseContext,
} from './jsxAttributeReaders'
import { iterationEvalContext, loopCallbackBody, readStaticLoop } from './staticLoopExpansion'

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

const DYNAMIC_LOCK_REASON = 'dynamic — rendered in code'
const SPREAD_LOCK_REASON = 'spread props'
const DYNAMIC_SVG_LOCK_REASON = 'dynamic SVG'

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
    const rootExpr = fn ? getReturnedJsxRoot(fn) : undefined

    if (!rootExpr) return { rootIds: [], nodes: {} }

    return parseJsxTree(rootExpr, sourceFile, relFile, appDir, fn, evalOptions)
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
 * not the page that references it); `workspaceRoot` is only consulted for
 * image-import resolution (§5.1) and should stay the same workspace root used
 * for the whole load so `studio-asset:` sentinels stay workspace-relative.
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
  rootExpr: Node,
  sourceFile: SourceFile,
  relFile: string,
  workspaceRoot: string,
  componentFn?: FunctionLike,
  evalOptions?: StaticEvalOptions,
): ParsedPage {
  const ctx: ParseContext = {
    sourceFile,
    relFile,
    nodes: {},
    imageImports: buildImageImportMap(sourceFile, workspaceRoot),
    ...(evalOptions ? { eval: { scope: createEvalScope(sourceFile, componentFn), options: evalOptions } } : {}),
  }
  const rootIds = collectRootIds(rootExpr, ctx)
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

/**
 * Gets the JSX the component's outermost return produces.
 *
 * For a concise arrow body (`() => (<div/>)`), that's the body itself. For a
 * block body, it's the expression of the "outermost" (least nested inside
 * an `if`/other block) `return` statement that belongs directly to this
 * function — nested function/arrow scopes (event handlers, `.map` callbacks,
 * etc.) are not descended into, since their returns belong to a different
 * component.
 */
export function getReturnedJsxRoot(fn: FunctionLike): Node | undefined {
  const body = fn.getBody()
  if (!body) return undefined

  if (!Node.isBlock(body)) {
    return unwrapParens(body)
  }

  const candidates: { node: ReturnStatement; depth: number }[] = []
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      traversal.skip()
      return
    }
    if (Node.isReturnStatement(node)) {
      candidates.push({ node, depth: blockDepth(node, body) })
    }
  })

  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => a.depth - b.depth)

  const expr = candidates[0].node.getExpression()
  return expr ? unwrapParens(expr) : undefined
}

/** Counts how many nested `{ ... }` blocks sit between `node` and `root`. */
function blockDepth(node: Node, root: Node): number {
  let depth = 0
  let current = node.getParent()
  while (current && current !== root) {
    if (Node.isBlock(current)) depth += 1
    current = current.getParent()
  }
  return depth
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

function collectRootIds(rootExpr: Node, ctx: ParseContext): string[] {
  if (Node.isJsxElement(rootExpr) || Node.isJsxSelfClosingElement(rootExpr)) {
    return [processElement(rootExpr, ctx, false, undefined)]
  }
  if (Node.isJsxFragment(rootExpr)) {
    return processChildren(rootExpr.getJsxChildren(), ctx, false, undefined)
  }
  // The component's own return is itself a dynamic expression (e.g.
  // `return cond ? <A/> : <B/>`) — still walk it, honoring the same locking
  // rule as a nested `{...}` child would get.
  const triggers = isLockingExpression(rootExpr)
  return collectFromExpression(rootExpr, ctx, triggers, triggers ? DYNAMIC_LOCK_REASON : undefined)
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

  const propsResult = extractProps(attributes, ctx)
  const styleResult = extractInlineStyles(attributes, ctx)

  // <svg> is captured as one opaque unit for `base.svg` (raw inline markup) —
  // do NOT recurse into <path>/<circle>/<g>/… below, they are not page-tree
  // modules. `className`/`style` are still captured above so they reach the
  // canvas (§4/§6 depend on that).
  if (kind === 'element' && name.toLowerCase() === 'svg') {
    const svgText = element.getText()
    // Embedded JSX expressions (`{...}`) — e.g. a progress ring's
    // `strokeDashoffset={C*(1-pct/100)}` — mean the captured text is not
    // valid standalone SVG. Keep the node (so its class/style/position are
    // still visible) but drop the unusable markup and lock it, rather than
    // ever emitting broken markup. `.map`/ternary/spread locks upstream, if
    // any, are superseded by this more specific reason.
    const dynamic = svgText.includes('{')
    const svgLock = withResolutionLock(
      locked || dynamic,
      dynamic ? DYNAMIC_SVG_LOCK_REASON : lockReason,
      [...propsResult.resolutions, ...styleResult.resolutions],
    )
    const svgNode: ParsedNode = {
      id,
      kind,
      name,
      props: dynamic ? propsResult.props : { ...propsResult.props, svg: svgText },
      children: [],
      loc,
      locked: svgLock.locked,
      ...(svgLock.lockReason ? { lockReason: svgLock.lockReason } : {}),
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

  const node: ParsedNode = {
    id,
    kind,
    name,
    props: propsResult.props,
    children,
    loc,
    locked: lock.locked,
    ...(lock.lockReason ? { lockReason: lock.lockReason } : {}),
    ...(text !== undefined ? { text } : {}),
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
 */
function collectFromExpression(
  expr: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
): string[] {
  const ids: string[] = []

  expr.forEachDescendant((node, traversal) => {
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
