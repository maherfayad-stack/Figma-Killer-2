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
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  type JsxSpreadAttribute,
  type ReturnStatement,
  type SourceFile,
} from 'ts-morph'
import type { NodeLoc, ParsedNode, ParsedPage } from './types'

type FunctionLike = ArrowFunction | FunctionDeclaration | FunctionExpression
type JsxOpeningLike = JsxElement | JsxSelfClosingElement

interface ParseContext {
  sourceFile: SourceFile
  /** appDir-relative POSIX path, precomputed once per parse. */
  relFile: string
  nodes: Record<string, ParsedNode>
}

const DYNAMIC_LOCK_REASON = 'dynamic — rendered in code'
const SPREAD_LOCK_REASON = 'spread props'

export function parsePageFile(file: string, appDir: string): ParsedPage {
  try {
    const project = new Project({ useInMemoryFileSystem: false })
    const sourceFile = project.addSourceFileAtPath(file)
    const relFile = path.relative(appDir, path.resolve(file)).split(path.sep).join('/')

    const componentDecl = findComponentDeclaration(sourceFile)
    const fn = componentDecl ? getFunctionLikeNode(componentDecl) : undefined
    const rootExpr = fn ? getReturnedJsxRoot(fn) : undefined

    if (!rootExpr) return { rootIds: [], nodes: {} }

    const ctx: ParseContext = { sourceFile, relFile, nodes: {} }
    const rootIds = collectRootIds(rootExpr, ctx)
    return { rootIds, nodes: ctx.nodes }
  } catch {
    // Never throw on ordinary pages — anything unexpected just yields an
    // empty (unparsed) page rather than a crash for the caller.
    return { rootIds: [], nodes: {} }
  }
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
function findComponentDeclaration(sourceFile: SourceFile): Node | undefined {
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
function getFunctionLikeNode(decl: Node): FunctionLike | undefined {
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
function getReturnedJsxRoot(fn: FunctionLike): Node | undefined {
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

  const props = extractProps(attributes)
  const rawChildren = Node.isJsxElement(element) ? element.getJsxChildren() : []
  const children = Node.isJsxElement(element) ? processChildren(rawChildren, ctx, locked, lockReason) : []
  // Only capture text for editable-surface elements — a locked/dynamic node
  // has no writeback path, so leaving `text` unset avoids implying otherwise.
  const text = locked ? undefined : extractSingleText(rawChildren)

  const node: ParsedNode = {
    id,
    kind,
    name,
    props,
    children,
    loc,
    locked,
    ...(lockReason ? { lockReason } : {}),
    ...(text !== undefined ? { text } : {}),
  }
  ctx.nodes[id] = node

  return id
}

/** Literal-valued attributes only (mirrors `../ast-codemods/readJsxProps`). */
function extractProps(attributes: (JsxAttribute | JsxSpreadAttribute)[]): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}

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
      } else if (Node.isStringLiteral(expression)) {
        result[name] = expression.getLiteralValue()
      } else if (Node.isTrueLiteral(expression)) {
        result[name] = true
      } else if (Node.isFalseLiteral(expression)) {
        result[name] = false
      }
      // Any other expression kind (identifier, call, template, object, …)
      // is not a literal — intentionally skipped (still present in source,
      // just not captured as an editable prop).
    }
  }

  return result
}

/**
 * When an element's only meaningful child is a single non-whitespace text
 * node — either raw JSX text or a `{"..."}` / `{'...'}` string-literal
 * expression container — returns that trimmed string. Elements with element
 * children, more than one meaningful child, or a non-literal/mixed
 * expression return `undefined` (their `children` are walked structurally by
 * `processChildren` instead, exactly as before this capture existed).
 *
 * Mirrors `assertTextOnlyChildren` in `../ast-codemods/setJsxText` — a
 * captured `text` is always a shape that codemod is willing to overwrite.
 */
function extractSingleText(children: Node[]): string | undefined {
  if (children.length !== 1) return undefined
  const only = children[0]!

  if (Node.isJsxText(only)) {
    const text = only.getText().trim()
    return text.length > 0 ? text : undefined
  }

  if (Node.isJsxExpression(only)) {
    const expression = only.getExpression()
    if (expression !== undefined && Node.isStringLiteral(expression)) {
      return expression.getLiteralValue()
    }
  }

  return undefined
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
