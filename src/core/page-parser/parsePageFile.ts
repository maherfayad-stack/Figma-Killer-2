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
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  type JsxSpreadAttribute,
  type ReturnStatement,
  type SourceFile,
} from 'ts-morph'
import type { FunctionLike, NodeLoc, ParsedNode, ParsedPage } from './types'
import { createEvalScope, type StaticEvalOptions } from './staticEval'
import { tryResolveExpression, withResolutionLock, type PageEvalContext, type Resolution } from './resolutionLock'

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

interface ParseContext {
  sourceFile: SourceFile
  /** appDir-relative POSIX path, precomputed once per parse. */
  relFile: string
  nodes: Record<string, ParsedNode>
  /**
   * Local identifier -> workspace-relative POSIX asset path, for THIS file's
   * default-imported image specifiers only (`import esimChip from
   * '../assets/x.png'`). Built once per parse (§5.1) so `extractProps` doesn't
   * re-walk import declarations per attribute — a page can reference the same
   * imported image on many elements.
   */
  imageImports: Map<string, string>
  /**
   * §7 value resolution — present ONLY when the caller opted in (passed
   * `evalOptions` to `parsePageFile`/`parseJsxTree`). `undefined` for every
   * existing caller/test: `extractProps`/`extractInlineStyles`/
   * `extractSingleText` keep their literal-only fast path unconditionally and
   * simply skip the evaluator fallback when this is absent — zero behaviour
   * change, zero cost, for a page that only uses literals. See
   * `./resolutionLock` for the wiring glue this feeds.
   */
  eval?: PageEvalContext
}

const DYNAMIC_LOCK_REASON = 'dynamic — rendered in code'
const SPREAD_LOCK_REASON = 'spread props'
const DYNAMIC_SVG_LOCK_REASON = 'dynamic SVG'

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|svg|webp|gif|avif)$/i

/**
 * Sentinel prefix `extractProps` emits (§5.1) for a prop whose value is a
 * plain identifier resolving to a default-imported image asset, e.g.
 * `props.src = 'studio-asset:assets/esim-flow/figma/esim-chip.png'`.
 *
 * Deliberately NOT a URL: `@core/page-parser` has no concept of an HTTP route
 * (it also runs against a bare workspace with no server around it). Rewriting
 * this into `/admin/api/studio/asset?dir=…&path=…` is the load handler's job
 * (`server/handlers/studio.ts`), which is the only layer that knows the route
 * shape and the project's `dir`. Exported so that layer never hardcodes the
 * prefix string.
 */
export const STUDIO_ASSET_SENTINEL = 'studio-asset:'

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
  const id = `${ctx.relFile}:${line}:${column}`

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

  const rawChildren = Node.isJsxElement(element) ? element.getJsxChildren() : []
  const children = Node.isJsxElement(element) ? processChildren(rawChildren, ctx, locked, lockReason) : []
  // Only capture text for editable-surface elements — a locked/dynamic node
  // has no writeback path, so leaving `text` unset avoids implying otherwise.
  const textResult = locked ? undefined : extractSingleText(rawChildren, ctx)
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
 * Maps `sourceFile`'s default-imported identifiers to a workspace-relative
 * POSIX asset path, for import specifiers that look like an image
 * (`import esimChip from '../assets/esim-flow/figma/esim-chip.png'`) — §5.1.
 *
 * Only RELATIVE specifiers are resolved (this is plain `path` resolution, not
 * module resolution: ts-morph's `Project` only tracks `.ts/.tsx/.js/.jsx`
 * files — see `createWorkspaceProject` — so a `.png` specifier never resolves
 * to a real `SourceFile` the way `classifyImport` in `componentSources.ts`
 * resolves a component import; there is nothing to reuse there beyond the
 * containment-check shape, which this mirrors). A bare/aliased specifier
 * (`@/assets/x.png`) is out of scope — same "small, contained widening" as
 * the rest of `extractProps`.
 *
 * A specifier that resolves outside `workspaceRoot` is dropped rather than
 * ever handed to a caller as a path — the asset-serving endpoint (§5.3) has
 * its own containment guard too, but the parser should never manufacture an
 * escaping path in the first place.
 */
function buildImageImportMap(sourceFile: SourceFile, workspaceRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  const root = path.resolve(workspaceRoot)

  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport()
    if (!defaultImport) continue

    const specifier = declaration.getModuleSpecifierValue()
    if (!specifier.startsWith('.') || !IMAGE_EXTENSION_RE.test(specifier)) continue

    const absolute = path.resolve(path.dirname(sourceFile.getFilePath()), specifier)
    const relFromRoot = path.relative(root, absolute)
    const insideRoot = relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)
    if (!insideRoot) continue

    map.set(defaultImport.getText(), relFromRoot.split(path.sep).join('/'))
  }

  return map
}

/**
 * Literal-valued attributes (mirrors `../ast-codemods/readJsxProps`), falling
 * through to §7's evaluator ONLY when the literal fast path misses AND the
 * caller opted in (`ctx.eval` present) — zero behaviour change, zero cost,
 * for a page that only uses literals (§7.8's non-regression guarantee).
 */
function extractProps(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
): { props: Record<string, string | number | boolean>; resolutions: Resolution[] } {
  const result: Record<string, string | number | boolean> = {}
  const resolutions: Resolution[] = []

  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue // skip {...spread} attributes

    const name = attribute.getNameNode().getText()
    const initializer = attribute.getInitializer()

    if (initializer === undefined) {
      // Valueless shorthand (`<Foo primary />`) is JSX sugar for `true`.
      result[name] = true
      continue
    }

    if (Node.isStringLiteral(initializer)) {
      result[name] = initializer.getLiteralValue()
      continue
    }

    if (Node.isJsxExpression(initializer)) {
      const expression = initializer.getExpression()
      if (expression === undefined) continue

      if (Node.isNumericLiteral(expression)) {
        result[name] = expression.getLiteralValue()
        continue
      }
      if (Node.isStringLiteral(expression)) {
        result[name] = expression.getLiteralValue()
        continue
      }
      if (Node.isTrueLiteral(expression)) {
        result[name] = true
        continue
      }
      if (Node.isFalseLiteral(expression)) {
        result[name] = false
        continue
      }
      if (Node.isIdentifier(expression)) {
        // §5.1 — a bare identifier that resolves to a default-imported image
        // (`<img src={esimChip}/>`) is captured as a sentinel path rather than
        // skipped outright, so an imported screen's images can be served
        // (see STUDIO_ASSET_SENTINEL's doc comment for why this isn't a URL
        // yet).
        const assetPath = ctx.imageImports.get(expression.getText())
        if (assetPath !== undefined) {
          result[name] = `${STUDIO_ASSET_SENTINEL}${assetPath}`
          continue
        }
      }
      // Any other expression kind (call, template, object, member access, a
      // plain identifier that isn't an image import, …) is not a literal —
      // §7's evaluator gets a shot at it now, still skipped unchanged when
      // `ctx.eval` is absent. The `style={{…}}` object is captured separately
      // by `extractInlineStyles` so the canvas can render the authored
      // inline styles.
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        result[name] = resolved.value
        resolutions.push({ source: expression.getText(), note: resolved.note })
      }
    }
  }

  return { props: result, resolutions }
}

/**
 * Flatten an element's `style={{ … }}` object-literal attribute into its
 * literal (string/number) entries, so the canvas renders the inline styles
 * actually authored in source (`node.inlineStyles` → `NodeRenderer`). Mirrors
 * `extractProps`' literal-fast-path-then-evaluator-fallback policy: a
 * property whose value isn't a string/number literal (an identifier, a
 * `var(--x)` reference held in a const, a template, …) falls through to §7's
 * evaluator (still skipped when `ctx.eval` is absent). Returns `styles:
 * undefined` when there's no `style` attribute, it isn't a plain object
 * literal, or it has no resolvable entries.
 */
function extractInlineStyles(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
): { styles: Record<string, string | number> | undefined; resolutions: Resolution[] } {
  const styleAttr = attributes.find(
    (a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'style',
  )
  if (!styleAttr) return { styles: undefined, resolutions: [] }

  const initializer = styleAttr.getInitializer()
  if (initializer === undefined || !Node.isJsxExpression(initializer)) return { styles: undefined, resolutions: [] }
  const expression = initializer.getExpression()
  if (expression === undefined || !Node.isObjectLiteralExpression(expression)) return { styles: undefined, resolutions: [] }

  const styles: Record<string, string | number> = {}
  const resolutions: Resolution[] = []
  for (const property of expression.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue // skip shorthand / spread / methods
    const nameNode = property.getNameNode()
    const key = Node.isIdentifier(nameNode)
      ? nameNode.getText()
      : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : null
    if (key === null) continue // computed keys are not statically known
    const valueNode = property.getInitializer()
    if (valueNode === undefined) continue
    if (Node.isStringLiteral(valueNode)) {
      styles[key] = valueNode.getLiteralValue()
      continue
    }
    if (Node.isNumericLiteral(valueNode)) {
      styles[key] = valueNode.getLiteralValue()
      continue
    }
    // Non-literal values (var refs, calls, templates, nested objects) fall
    // through to §7's evaluator — e.g. a `const accent = 'var(--text-link-default)'`
    // reference, or `width: \`${pct}%\``. A style value is never boolean, so a
    // resolved boolean (unlike for `extractProps`) isn't a usable style value.
    const resolved = tryResolveExpression(valueNode, ctx.eval)
    if (resolved && typeof resolved.value !== 'boolean') {
      styles[key] = resolved.value
      resolutions.push({ source: valueNode.getText(), note: resolved.note })
    }
  }

  return { styles: Object.keys(styles).length > 0 ? styles : undefined, resolutions }
}

/**
 * When an element's only meaningful child is a single non-whitespace text
 * node — either raw JSX text or a `{"..."}` / `{'...'}` string-literal
 * expression container — returns that trimmed string. Falls through to §7's
 * evaluator when the sole child is some OTHER expression (`{t.homepage.greeting}`,
 * `` {`${pct}%`} ``, …). Elements with element children, more than one
 * meaningful child, or an unresolvable expression get no `text` (their
 * `children` are still walked structurally by `processChildren` instead,
 * exactly as before this capture existed).
 *
 * Mirrors `assertTextOnlyChildren` in `../ast-codemods/setJsxText` — a
 * captured `text` is always a shape that codemod is willing to overwrite
 * (§7.6: a RESOLVED text value is additionally always locked, see
 * `withResolutionLock`, since writing an edit back over the original
 * expression would destroy it).
 */
function extractSingleText(children: Node[], ctx: ParseContext): { text: string | undefined; resolution?: Resolution } {
  if (children.length !== 1) return { text: undefined }
  const only = children[0]!

  if (Node.isJsxText(only)) {
    const text = only.getText().trim()
    return { text: text.length > 0 ? text : undefined }
  }

  if (Node.isJsxExpression(only)) {
    const expression = only.getExpression()
    if (expression !== undefined) {
      if (Node.isStringLiteral(expression)) return { text: expression.getLiteralValue() }
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        return { text: String(resolved.value), resolution: { source: expression.getText(), note: resolved.note } }
      }
    }
  }

  return { text: undefined }
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
