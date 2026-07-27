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
import { Node, type ArrowFunction, type FunctionExpression } from 'ts-morph'
import type { StaticValue } from './staticEvalCore'
import type { PageEvalContext } from './resolutionLock'
import { evaluateExpression } from './staticEval'

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
