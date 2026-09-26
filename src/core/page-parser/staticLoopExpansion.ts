/**
 * staticLoopExpansion — materialises `items.map(item => <Row/>)` into one node
 * per item, when `items` is an array §7 has already fully resolved.
 *
 * Why this is not the banned Tier D
 * ─────────────────────────────────
 * §7's ban is on EXECUTING code: control flow whose outcome the parser cannot
 * know, hook state, effects, async. A `.map` over a resolved array literal is
 * none of that. The length is known from the source, every item is a value the
 * evaluator already produced by reading declarations, and the operation is
 * total — there is no branch to guess and no user statement to run. What gets
 * expanded is a bounded, deterministic function of the AST, exactly like every
 * other §7 resolution.
 *
 * The distinction that keeps this honest: if the array does not resolve, or any
 * item does not, nothing is expanded and the call site keeps today's single
 * locked placeholder. An unresolvable loop is still opaque.
 *
 * Why it matters: a real screen is mostly lists. Before this, a package picker
 * showed one empty row instead of four, a device list showed none, and 96 nodes
 * across the eSIM corpus were a single `dynamic — rendered in code` placeholder
 * standing in for a whole section. Reading the board told you almost nothing
 * about the screen.
 *
 * EXPANDED NODES ARE LOCKED, for the same reason every resolved value is: they
 * are derived. One piece of source JSX backs all N rows, so an edit to row 3 has
 * no isolated place to land — it would rewrite the template for every row. The
 * data is the thing to edit, in the source array.
 */
import {
  Node,
  VariableDeclarationKind,
  type ArrayLiteralExpression,
  type ArrowFunction,
  type FunctionExpression,
  type VariableDeclaration,
} from 'ts-morph'
import { buildSourceNodeId, type ListRowKey, type ListRowRefusalCode, type ListRowSource } from '@core/page-tree'
import { findImportBinding, type StaticValue } from './staticEvalCore'
import type { PageEvalContext } from './nodeResolution'
import { evaluateExpression } from './staticEval'
import type { ParsedNode } from './types'

/**
 * Hard cap on nodes one loop may contribute, mirroring `inlineLocalComponents`'
 * `maxNodes`. A resolved array is bounded by definition, but "bounded" and
 * "reasonable to render on a canvas" are different claims — a 5000-entry
 * fixture would expand into a board nobody can use.
 */
export const MAX_LOOP_ITERATIONS = 100

/** The callback shapes this reads. A concise arrow body is the corpus's norm; a block body works too, via `getReturnedJsxRoot` at the call site. */
type LoopCallback = ArrowFunction | FunctionExpression

export interface StaticLoop {
  /** The callback whose body produces one item's JSX. */
  callback: LoopCallback
  /** Every resolved item, in source order, already capped at `MAX_LOOP_ITERATIONS`. */
  items: StaticValue[]
  /** Source text of the array expression, for the lock reason. */
  sourceText: string
  /** The expression `.map` is called on — what OD-8 traces back to an array literal (`listRowSourceFor`). */
  receiver: Node
}

/**
 * Reads `expr` as an expandable `.map` loop, or returns `undefined` to leave it
 * opaque.
 *
 * Deliberately narrow. `.map` with one callback argument and a statically
 * resolved array receiver is the whole contract; `.forEach`, a chained
 * `.filter(...).map(...)` whose intermediate does not resolve, a callback stored
 * in a variable, or an array with even one unresolved item all decline.
 */
export function readStaticLoop(expr: Node, evalCtx: PageEvalContext | undefined): StaticLoop | undefined {
  if (!evalCtx) return undefined
  if (!Node.isCallExpression(expr)) return undefined

  const callee = expr.getExpression()
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') return undefined

  const args = expr.getArguments()
  const callback = args[0]
  if (args.length !== 1 || !callback) return undefined
  if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return undefined

  const receiver = callee.getExpression()
  const resolved = evaluateExpression(receiver, evalCtx.scope, evalCtx.options)
  if (resolved.kind !== 'array') return undefined
  // One unresolved item means the array is not really known, and rendering the
  // rest would silently drop a row rather than showing it empty.
  if (resolved.items.some((item) => item.kind === 'unresolved')) return undefined

  return {
    callback,
    items: resolved.items.slice(0, MAX_LOOP_ITERATIONS),
    sourceText: receiver.getText(),
    receiver,
  }
}

/**
 * The eval context for one iteration: the enclosing scope plus the callback's
 * parameters bound to this item and its index.
 *
 * `'resolved'` is the binding the evaluator already uses to hand a Tier C call
 * its arguments, so an item's fields reach the JSX through the ordinary lookup
 * path — `{pkg.gb}` and even `t.topupPackage.gbLabel(pkg.gb)` resolve with no
 * special casing here.
 *
 * A destructured parameter (`({ gb, price }) => …`) declines, because binding it
 * would mean re-implementing destructuring against a `StaticValue`; the loop
 * still expands, those props just stay unresolved.
 */
export function iterationEvalContext(
  loop: StaticLoop,
  item: StaticValue,
  index: number,
  evalCtx: PageEvalContext,
): PageEvalContext {
  const locals = new Map(evalCtx.scope.locals)
  const params = loop.callback.getParameters()

  const itemParam = params[0]?.getNameNode()
  if (itemParam && Node.isIdentifier(itemParam)) {
    locals.set(itemParam.getText(), { kind: 'resolved', value: item })
  }
  const indexParam = params[1]?.getNameNode()
  if (indexParam && Node.isIdentifier(indexParam)) {
    locals.set(indexParam.getText(), { kind: 'resolved', value: { kind: 'literal', value: index } })
  }

  return { options: evalCtx.options, scope: { sourceFile: evalCtx.scope.sourceFile, locals } }
}

/**
 * The JSX a callback returns — its concise body, or the argument of the `return`
 * in a block body.
 */
export function loopCallbackBody(callback: LoopCallback): Node | undefined {
  const body = callback.getBody()
  if (!Node.isBlock(body)) return body

  for (const statement of body.getStatements()) {
    if (Node.isReturnStatement(statement)) return statement.getExpression()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// OD-8 — which array element each row IS
// ---------------------------------------------------------------------------

/**
 * What every row of `loop` is in the source, as a function of its index and
 * how many root nodes that iteration rendered: element `index` of an array
 * literal written in THIS file, or why there is no such array to edit.
 *
 * Read off the SAME binding the evaluator resolved the receiver through
 * (`resolveIdentifier`'s order: component-body locals, then a same-file
 * module const, then an import), so the array a write edits is the array the
 * board shows. Nothing is evaluated here — this only locates a declaration.
 *
 * Refuses, by code: an array imported from another file (`imported`), a
 * value handed in as a prop (`prop`), anything computed (`computed` — a call,
 * a `.filter()`, a `let`), a literal that spreads another list or skips a slot
 * (`spread`), a list drawn inside another list's row (`nested` — its array is
 * shared by every outer row), and an item that renders several root elements
 * (`multi-root` — one of them cannot go without the others).
 */
export function listRowSourceFor(
  loop: StaticLoop,
  evalCtx: PageEvalContext,
  relFile: string,
  nested: boolean,
): (index: number, rootCount: number) => ListRowSource {
  const source = loop.sourceText
  const array = nested ? 'nested' : resolveLoopArray(loop.receiver, evalCtx)
  const key = readRowKey(loop.callback)
  return (index, rootCount) => {
    if (typeof array === 'string') return { kind: 'refused', reason: array, source }
    if (rootCount !== 1) return { kind: 'refused', reason: 'multi-root', source }
    const { line, column } = array.getSourceFile().getLineAndColumnAtPos(array.getStart())
    return {
      kind: 'array',
      array: buildSourceNodeId(relFile, line, column),
      index,
      length: array.getElements().length,
      key,
      source,
    }
  }
}

/**
 * Stamps each root node one iteration rendered with its row's source.
 *
 * A row root whose array is editable is UNLOCKED when the loop was its only
 * lock (`loopReason`): its place in the list is written through the array,
 * so the structural lock — "the source does not place this" — is no longer
 * true of it. Everything inside the row stays locked (one piece of JSX
 * renders it in every row), and so does a root locked for its own reason (a
 * spread). The gestures the array cannot express still refuse by the id
 * (`list-row`), which never depended on this flag.
 */
export function stampListRows(
  nodes: Record<string, ParsedNode>,
  rootIds: readonly string[],
  listRow: ListRowSource,
  loopReason: string,
): void {
  for (const id of rootIds) {
    const node = nodes[id]
    if (!node) continue
    node.listRow = listRow
    if (listRow.kind === 'array' && node.lockReason === loopReason) {
      node.locked = false
      delete node.lockReason
    }
  }
}

/** `expr` without the wrappers that do not change which value it is (`(…)`, `as`, `satisfies`, `!`). */
function unwrapValue(expr: Node): Node {
  let current = expr
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression()
  }
  return current
}

function resolveLoopArray(receiver: Node, evalCtx: PageEvalContext): ArrayLiteralExpression | ListRowRefusalCode {
  const expr = unwrapValue(receiver)
  if (Node.isArrayLiteralExpression(expr)) return plainArray(expr)
  if (!Node.isIdentifier(expr)) return 'computed'
  const name = expr.getText()
  const local = evalCtx.scope.locals.get(name)
  if (local) {
    if (local.kind === 'resolved') return 'prop'
    if (local.kind !== 'expr') return 'computed'
    const declaration = local.node.getParent()
    return Node.isVariableDeclaration(declaration) ? constArray(declaration) : 'computed'
  }
  const sourceFile = evalCtx.scope.sourceFile
  if (sourceFile.getFunction(name)) return 'computed'
  const moduleVar = sourceFile.getVariableDeclaration(name)
  if (moduleVar) return constArray(moduleVar)
  return findImportBinding(sourceFile, name) ? 'imported' : 'computed'
}

/** A `const`'s array-literal initializer — a `let`/`var` can be reassigned, so what it holds is computed. */
function constArray(declaration: VariableDeclaration): ArrayLiteralExpression | ListRowRefusalCode {
  const list = declaration.getParent()
  if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return 'computed'
  const init = declaration.getInitializer()
  const value = init ? unwrapValue(init) : undefined
  return value && Node.isArrayLiteralExpression(value) ? plainArray(value) : 'computed'
}

/** An array literal whose element `k` is row `k`: no spread, no skipped slot, at least one element. */
function plainArray(array: ArrayLiteralExpression): ArrayLiteralExpression | ListRowRefusalCode {
  const elements = array.getElements()
  if (elements.length === 0) return 'computed'
  return elements.some((element) => Node.isSpreadElement(element) || Node.isOmittedExpression(element)) ? 'spread' : array
}

/** The attributes of the element a callback returns, when it returns one element. */
function rootAttributes(callback: LoopCallback): Node[] | undefined {
  const body = loopCallbackBody(callback)
  const element = body ? unwrapValue(body) : undefined
  if (element && Node.isJsxElement(element)) return element.getOpeningElement().getAttributes()
  if (element && Node.isJsxSelfClosingElement(element)) return element.getAttributes()
  return undefined
}

/** How the row's `key` reads its item — what a copy of the item must change to keep keys unique. */
function readRowKey(callback: LoopCallback): ListRowKey {
  const attributes = rootAttributes(callback)
  if (!attributes) return { kind: 'computed' }
  const keyAttribute = attributes.find((attribute) => Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === 'key')
  if (!keyAttribute || !Node.isJsxAttribute(keyAttribute)) return { kind: 'none' }
  const initializer = keyAttribute.getInitializer()
  const expr = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  if (!expr) return { kind: 'computed' }
  const [itemParam, indexParam] = callback.getParameters()
  const itemName = itemParam?.getNameNode()
  const key = unwrapValue(expr)
  if (Node.isIdentifier(key)) {
    const name = key.getText()
    if (indexParam && indexParam.getNameNode().getText() === name) return { kind: 'none' }
    if (itemName && Node.isIdentifier(itemName) && itemName.getText() === name) return { kind: 'item' }
    if (itemName && Node.isObjectBindingPattern(itemName)) {
      const binding = itemName.getElements().find((el) => !el.getDotDotDotToken() && el.getNameNode().getText() === name)
      if (binding) return { kind: 'field', field: binding.getPropertyNameNode()?.getText() ?? name }
    }
    return { kind: 'computed' }
  }
  if (!itemName || !Node.isIdentifier(itemName)) return { kind: 'computed' }
  if (Node.isPropertyAccessExpression(key) && key.getExpression().getText() === itemName.getText()) {
    return { kind: 'field', field: key.getName() }
  }
  if (Node.isElementAccessExpression(key) && key.getExpression().getText() === itemName.getText()) {
    const argument = key.getArgumentExpression()
    if (argument && Node.isStringLiteral(argument)) return { kind: 'field', field: argument.getLiteralValue() }
  }
  return { kind: 'computed' }
}
