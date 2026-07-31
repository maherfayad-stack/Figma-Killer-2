/**
 * staticEvalCalls — Tier B (hook -> `useContext` -> provider's static
 * `value`) and Tier C (calling a resolvable pure arrow/function) call
 * evaluation, plus the whitelisted primitive method/coercion calls §7.5
 * names (`String`, `Number`, `Math.*`, `.toFixed`, `.padStart`,
 * `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`) and the WS-2.2
 * `cn`/`clsx`/`classnames` class-name-join built-in. See `./staticEval`'s doc
 * comment for the full tier-boundary explanation — this is the single
 * highest-risk file per the plan's §10 risk register, so keep every
 * capability inside its named tier's explicit envelope; never blur into
 * Tier D (loop expansion, conditional-branch selection, hook state, effects,
 * async — banned).
 *
 * Imports everything it needs FROM `./staticEvalCore` (one direction only —
 * see that module's doc comment for why `evaluateNode` never imports this
 * file back). `evaluateCall` is the sole export, wired into `Budget` by the
 * public composer, `./staticEval`.
 */
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type JsxAttribute,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type Project,
  type PropertyAccessExpression,
} from 'ts-morph'
import type { FunctionLike } from './types'
import { enclosingFunctionLike } from './defaultLiteralBindings'
import {
  createEvalScope,
  evaluateCondition,
  evaluateNode,
  findDefaultExportedVariable,
  findImportBinding,
  trackTruncation,
  type ArrowFunctionOrDecl,
  type Budget,
  type EvalScope,
  type LocalBinding,
  type StaticValue,
} from './staticEvalCore'
import { unresolved, unwrapParens, withNote } from './staticEvalValues'

const WHITELISTED_COERCIONS: ReadonlySet<string> = new Set(['String', 'Number'])
const WHITELISTED_METHODS: ReadonlySet<string> = new Set([
  'toFixed', 'padStart', 'toUpperCase', 'toLowerCase', 'trim', 'join',
])

/**
 * `Math` functions that are pure and deterministic. `random` is deliberately
 * absent — a value that differs per call is not a static value.
 */
const MATH_FUNCTIONS: ReadonlyMap<string, (...args: number[]) => number> = new Map([
  ['abs', Math.abs], ['ceil', Math.ceil], ['floor', Math.floor], ['round', Math.round],
  ['trunc', Math.trunc], ['sign', Math.sign], ['sqrt', Math.sqrt], ['cbrt', Math.cbrt],
  ['min', Math.min], ['max', Math.max], ['pow', Math.pow], ['hypot', Math.hypot],
  ['log', Math.log], ['log2', Math.log2], ['log10', Math.log10], ['exp', Math.exp],
  ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['atan2', Math.atan2],
])

/** The pure `Math` function a `Math.f` callee names, or `undefined`. */
function mathFunction(callee: PropertyAccessExpression): ((...args: number[]) => number) | undefined {
  const obj = callee.getExpression()
  if (!Node.isIdentifier(obj) || obj.getText() !== 'Math') return undefined
  return MATH_FUNCTIONS.get(callee.getName())
}

/** The `Budget.callEvaluator` implementation — dispatches a `CallExpression` to the whitelist, Tier B, or Tier C, in that order. */
export function evaluateCall(expr: CallExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const callee = expr.getExpression()

  const memoized = tryUseMemoUnwrap(expr, callee, scope, budget, depth)
  if (memoized) return memoized

  const classJoin = tryClassNameJoinBuiltin(expr, callee, scope, budget, depth)
  if (classJoin) return classJoin

  const whitelisted = tryWhitelistedPrimitiveCall(expr, callee, scope, budget, depth)
  if (whitelisted) return whitelisted

  const calleeValue = evaluateNode(callee, scope, budget, depth + 1)
  if (calleeValue.kind !== 'fn') return unresolved('callee is not a statically resolvable function')

  const provided = tryProviderTraceCached(calleeValue.node, budget, depth)
  if (provided) return provided

  if (!qualifiesForTierC(calleeValue.node)) return unresolved('function body is outside the Tier C call envelope')

  const args = expr.getArguments().map((a) => evaluateNode(a, scope, budget, depth + 1))
  if (args.some((a) => a.kind !== 'literal')) return unresolved('one or more call arguments are not statically resolvable')

  return callPureArrow(calleeValue.node, args, budget, depth)
}

// -- Tier B: hook -> useContext -> provider's static `value` -----------------

/**
 * Provider tracing is the expensive half of Tier B — it scans every source
 * file in the workspace for `<Ctx.Provider>` — so its result is memoized per
 * hook function node. The inner key is `Budget.preferredKey`, because §7.4's
 * dictionary branch pick is what makes the traced value locale-dependent:
 * caching `{ t: <the "en" branch> }` and then handing it back to a page loaded
 * with `previewLocale: "ar"` would silently serve the wrong copy.
 */
const providerTraceCache = new WeakMap<Node, Map<string, StaticValue>>()

/** `undefined` = not hook-shaped (let Tier C try instead); otherwise the (possibly unresolved) traced result. */
function tryProviderTraceCached(fn: ArrowFunctionOrDecl, budget: Budget, depth: number): StaticValue | undefined {
  const ctxExpr = findUseContextArgument(fn)
  if (!ctxExpr) return undefined

  const cacheKey = budget.preferredKey ?? ''
  let byKey = providerTraceCache.get(fn)
  const cached = byKey?.get(cacheKey)
  if (cached) return cached

  // A provider whose own `value` reads the same hook would recurse forever;
  // `budget.cycle` is the same guard `evaluateModuleConst` uses for consts.
  const cycleKey = `provider:${fn.getSourceFile().getFilePath()}#${fn.getPos()}`
  if (budget.cycle.has(cycleKey)) {
    budget.truncated = true
    return unresolved('cyclic provider trace')
  }
  budget.cycle.add(cycleKey)
  const { result, truncated } = trackTruncation(budget, () => traceProvider(ctxExpr, fn.getProject(), budget, depth))
  budget.cycle.delete(cycleKey)

  // Same rule as `evaluateModuleConst`: a guard-truncated trace is a fact
  // about the budget, not the code — memoizing it would poison every later page.
  if (!truncated) {
    if (!byKey) {
      byKey = new Map()
      providerTraceCache.set(fn, byKey)
    }
    byKey.set(cacheKey, result)
  }
  return result
}

function traceProvider(ctxExpr: Node, project: Project, budget: Budget, depth: number): StaticValue {
  const ctxDecl = resolveContextDeclaration(ctxExpr)
  if (!ctxDecl) return unresolved('context declaration could not be resolved')

  const providers = findProviders(project, ctxDecl)
  if (providers.length === 0) return unresolved('no <Context.Provider> found for this context')
  if (providers.length > 1) return unresolved('multiple providers found for this context — ambiguous, not guessed at')

  const valueExpr = providerValueExpression(providers[0]!)
  if (!valueExpr) return unresolved('provider has no `value` attribute')

  // The value is almost never a literal sitting in the attribute — the corpus
  // shape is `value={value}` referring to a `const` in the provider
  // COMPONENT's body. So the scope must carry that component's own locals,
  // exactly as §7.6's wiring does for a page's component body.
  const providerScope = createEvalScope(valueExpr.getSourceFile(), enclosingFunctionLike(valueExpr))
  return evaluateNode(valueExpr, providerScope, budget, depth + 1)
}

function findUseContextArgument(fn: FunctionLike): Node | undefined {
  const body = fn.getBody()
  if (!body) return undefined
  if (!Node.isBlock(body)) return extractUseContextArg(body)

  for (const statement of body.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      for (const decl of statement.getDeclarations()) {
        const init = decl.getInitializer()
        const arg = init && extractUseContextArg(init)
        if (arg) return arg
      }
    } else if (Node.isReturnStatement(statement)) {
      const returnExpr = statement.getExpression()
      const arg = returnExpr && extractUseContextArg(returnExpr)
      if (arg) return arg
    }
    // Any other statement (the throw-guard, etc.) is tolerated by simply not matching here.
  }
  return undefined
}

function extractUseContextArg(expr: Node): Node | undefined {
  const n = unwrapParens(expr)
  if (!Node.isCallExpression(n)) return undefined
  const callee = n.getExpression()
  if (!Node.isIdentifier(callee) || callee.getText() !== 'useContext') return undefined
  return n.getArguments()[0]
}

function resolveContextDeclaration(ctxExpr: Node): Node | undefined {
  if (!Node.isIdentifier(ctxExpr)) return undefined
  const name = ctxExpr.getText()
  const sourceFile = ctxExpr.getSourceFile()

  const sameFileDecl = sourceFile.getVariableDeclaration(name)
  if (sameFileDecl) return sameFileDecl

  const imported = findImportBinding(sourceFile, name)
  if (!imported?.targetFile) return undefined
  if (imported.exportedName === 'default') return findDefaultExportedVariable(imported.targetFile)
  return imported.targetFile.getVariableDeclaration(imported.exportedName)
}

function findProviders(project: Project, ctxDecl: Node): (JsxOpeningElement | JsxSelfClosingElement)[] {
  const found: (JsxOpeningElement | JsxSelfClosingElement)[] = []
  for (const file of project.getSourceFiles()) {
    file.forEachDescendant((node) => {
      if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return
      const tagName = node.getTagNameNode()
      if (!Node.isPropertyAccessExpression(tagName) || tagName.getName() !== 'Provider') return
      const objectExpr = tagName.getExpression()
      if (Node.isIdentifier(objectExpr) && resolveContextDeclaration(objectExpr) === ctxDecl) found.push(node)
    })
  }
  return found
}

function providerValueExpression(node: JsxOpeningElement | JsxSelfClosingElement): Node | undefined {
  const attr = node.getAttributes().find(
    (a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'value',
  )
  const init = attr?.getInitializer()
  if (!init || !Node.isJsxExpression(init)) return undefined
  const valueExpr = init.getExpression()
  return valueExpr ? unwrapParens(valueExpr) : undefined
}

/**
 * `useMemo(() => X, deps)` evaluates as `X`. A memo wrapper is transparent to
 * a static reader — React's recompute-on-dep-change semantics are irrelevant
 * when nothing runs. This lives in the shared call dispatcher rather than only
 * where a provider's `value` attribute is read, because the corpus shape is
 * `value={value}` with `const value = useMemo(…)` one identifier hop away.
 * A `useMemo` call is never a Tier C candidate, so this always answers.
 */
function tryUseMemoUnwrap(
  expr: CallExpression,
  callee: Node,
  scope: EvalScope,
  budget: Budget,
  depth: number,
): StaticValue | undefined {
  if (!Node.isIdentifier(callee) || callee.getText() !== 'useMemo') return undefined
  const factory = expr.getArguments()[0]
  if (!factory || !(Node.isArrowFunction(factory) || Node.isFunctionExpression(factory))) {
    return unresolved('useMemo factory is not an inline function')
  }
  const body = factory.getBody()
  if (Node.isBlock(body)) return unresolved('useMemo factory has a block body — outside the evaluator envelope')
  return evaluateNode(unwrapParens(body), scope, budget, depth + 1)
}

// -- `cn`/`clsx`/`classnames` — WS-2.2's built-in class-name join -------------

/**
 * Identifier names treated as the `clsx`/`classnames` join, whichever package
 * (or local re-export, e.g. shadcn's `cn = (...a) => twMerge(clsx(a))`) they
 * actually came from. Matched by name only, the same way `mathFunction` above
 * matches a bare `Math` identifier without checking provenance — no user code
 * ever runs, so a same-named local function that means something else just
 * gets a wrong-but-bounded string instead of `unresolved`, and every real
 * corpus that defines `cn`/`clsx`/`classNames` uses exactly this semantics.
 */
const CLASS_NAME_JOIN_BUILTIN_NAMES: ReadonlySet<string> = new Set(['cn', 'clsx', 'classNames', 'classnames'])

/**
 * `cn(...)`/`clsx(...)`/`classnames(...)` — a pure string join, added to Tier
 * C's whitelist as a built-in per §WS-2.2 rather than attempted through the
 * general Tier C envelope (the real library's source is a tight loop over
 * `arguments`, well outside `qualifiesForTierC`'s shape). Documented, tiny
 * semantics matching the real libraries closely enough for a static reader:
 * truthy strings/numbers are kept, falsy scalars and booleans are dropped,
 * arrays are flattened recursively, and an object's keys are kept when their
 * value is truthy. An argument that doesn't statically resolve (a runtime
 * condition on unknown state, an unresolvable identifier) is simply DROPPED
 * from the join rather than failing the whole call — the same "best-effort,
 * never guess" degrade every other Tier A/B/C path uses for a partial result.
 */
function tryClassNameJoinBuiltin(
  expr: CallExpression,
  callee: Node,
  scope: EvalScope,
  budget: Budget,
  depth: number,
): StaticValue | undefined {
  if (!Node.isIdentifier(callee) || !CLASS_NAME_JOIN_BUILTIN_NAMES.has(callee.getText())) return undefined
  const parts: string[] = []
  for (const argExpr of expr.getArguments()) {
    appendClassNameValue(evaluateNode(argExpr, scope, budget, depth + 1), parts)
  }
  return { kind: 'literal', value: parts.join(' ') }
}

function appendClassNameValue(value: StaticValue, parts: string[]): void {
  if (value.kind === 'literal') {
    if (typeof value.value === 'string' && value.value.length > 0) parts.push(value.value)
    else if (typeof value.value === 'number' && value.value !== 0) parts.push(String(value.value))
    return // booleans, null, 0, and '' contribute nothing — same as the real libraries
  }
  if (value.kind === 'array') {
    for (const item of value.items) appendClassNameValue(item, parts)
    return
  }
  if (value.kind === 'object') {
    for (const [key, entryValue] of value.entries) {
      if (entryValue.kind === 'literal' && Boolean(entryValue.value)) parts.push(key)
    }
    return
  }
  // `unresolved`/`fn` — dropped, not failed. See this section's doc comment.
}

// -- Tier C: calling a resolvable pure arrow/function -------------------------

/**
 * Structural pre-check for §7.5's envelope: a concise-expression body, or a
 * block body made ONLY of `if (cond) return <expr>` / `return <expr>`
 * statements (eSIM's `daysLeftAr` if-chain shape), where nothing in any
 * reachable sub-expression is an assignment, a loop, `await`, `new`, or a
 * member call outside the whitelist. Returns `false` for anything else —
 * Tier C is only ever ATTEMPTED when this holds.
 */
function qualifiesForTierC(fn: ArrowFunctionOrDecl): boolean {
  const body = fn.getBody()
  if (!body) return false
  if (!Node.isBlock(body)) return isWhitelistedSubtree(body)

  for (const statement of body.getStatements()) {
    if (Node.isReturnStatement(statement)) {
      const rexpr = statement.getExpression()
      if (rexpr && !isWhitelistedSubtree(rexpr)) return false
      continue
    }
    if (Node.isIfStatement(statement)) {
      if (statement.getElseStatement()) return false // bare if-chains only, no `else`
      const then = statement.getThenStatement()
      if (!Node.isReturnStatement(then)) return false
      if (!isWhitelistedSubtree(statement.getExpression())) return false
      const rexpr = then.getExpression()
      if (rexpr && !isWhitelistedSubtree(rexpr)) return false
      continue
    }
    return false // any other statement kind disqualifies the whole function
  }
  return true
}

function isWhitelistedSubtree(node: Node): boolean {
  let ok = true
  node.forEachDescendant((n, traversal) => {
    if (Node.isBinaryExpression(n) && isAssignmentOperator(n.getOperatorToken().getKind())) {
      ok = false
      traversal.stop()
      return
    }
    if (
      Node.isForStatement(n) || Node.isForInStatement(n) || Node.isForOfStatement(n) ||
      Node.isWhileStatement(n) || Node.isDoStatement(n) ||
      Node.isAwaitExpression(n) || Node.isNewExpression(n)
    ) {
      ok = false
      traversal.stop()
      return
    }
    if (Node.isCallExpression(n) && !isWhitelistedCallShape(n)) {
      ok = false
      traversal.stop()
    }
  })
  return ok
}

function isWhitelistedCallShape(call: CallExpression): boolean {
  const callee = call.getExpression()
  if (Node.isIdentifier(callee)) return WHITELISTED_COERCIONS.has(callee.getText())
  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression()
    if (Node.isIdentifier(obj) && obj.getText() === 'Math') return true
    return WHITELISTED_METHODS.has(callee.getName())
  }
  return false
}

const ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken, SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandEqualsToken, SyntaxKind.BarEqualsToken, SyntaxKind.CaretEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.QuestionQuestionEqualsToken,
])

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return ASSIGNMENT_OPERATORS.has(kind)
}

/** Binds `fn`'s (simple, non-destructured) parameters to `args` and evaluates its qualifying body. */
function callPureArrow(fn: ArrowFunctionOrDecl, args: StaticValue[], budget: Budget, depth: number): StaticValue {
  const locals = new Map<string, LocalBinding>()
  const params = fn.getParameters()
  for (let i = 0; i < params.length; i++) {
    const nameNode = params[i]!.getNameNode()
    if (!Node.isIdentifier(nameNode)) return unresolved('destructured/rest parameter — outside the Tier C envelope')
    const arg = args[i]
    if (arg === undefined) return unresolved('fewer arguments than parameters')
    locals.set(nameNode.getText(), { kind: 'resolved', value: arg })
  }
  const callScope: EvalScope = { sourceFile: fn.getSourceFile(), locals }

  const body = fn.getBody()!
  if (!Node.isBlock(body)) return evaluateNode(body, callScope, budget, depth + 1)

  let hadAmbiguousBranch = false
  for (const statement of body.getStatements()) {
    if (Node.isIfStatement(statement)) {
      const cond = evaluateCondition(statement.getExpression(), callScope, budget, depth + 1)
      const then = statement.getThenStatement()
      const thenReturn = Node.isReturnStatement(then) ? then.getExpression() : undefined
      if (cond === true && thenReturn) return evaluateNode(thenReturn, callScope, budget, depth + 1)
      if (cond === undefined) hadAmbiguousBranch = true // an earlier branch couldn't be ruled in or out
      continue
    }
    if (Node.isReturnStatement(statement)) {
      const rexpr = statement.getExpression()
      if (!rexpr) continue
      const value = evaluateNode(rexpr, callScope, budget, depth + 1)
      return hadAmbiguousBranch
        ? withNote(value, 'an if-chain condition was not statically known — showing the general-case branch')
        : value
    }
  }
  return unresolved('no branch of the if-chain could be statically resolved')
}


// -- Whitelisted primitive method / coercion calls (§7.5) --------------------

/**
 * `[a, b].filter(Boolean)` — and ONLY that argument.
 *
 * This is half of the ubiquitous conditional-class idiom,
 * `['ds-raw-icon', className].filter(Boolean).join(' ')`, which is how the
 * corpus's components merge a base class with an optional one. Without it the
 * whole expression is unresolved and the element reaches the canvas with no
 * class at all — an inlined `<Icon className="bc-success__check-icon"/>` loses
 * the rule that sizes it, and the raw SVG paints across its container.
 *
 * `Boolean` as the predicate keeps this inside §7's envelope rather than
 * opening the door to Tier D: no user code runs, the receiver is an
 * already-resolved array literal of known length, and the operation is total.
 * An arrow predicate (`filter((x) => …)`) does NOT resolve — that is a loop over
 * a body this evaluator does not execute.
 */
function tryFilterBoolean(
  expr: CallExpression,
  callee: PropertyAccessExpression,
  scope: EvalScope,
  budget: Budget,
  depth: number,
): StaticValue {
  const args = expr.getArguments()
  const predicate = args[0]
  if (args.length !== 1 || !predicate || !Node.isIdentifier(predicate) || predicate.getText() !== 'Boolean') {
    return unresolved('filter(...) predicate is not `Boolean`')
  }

  const receiver = evaluateNode(callee.getExpression(), scope, budget, depth + 1)
  if (receiver.kind !== 'array') return unresolved('filter(...) receiver is not a statically resolvable array')
  if (receiver.items.some((i) => i.kind !== 'literal')) return unresolved('filter() on an array with unresolved items')

  const items = receiver.items.filter((i) => Boolean((i as Extract<StaticValue, { kind: 'literal' }>).value))
  // Every item was a literal and the filter ran to completion, so the result's
  // own length is exactly what the source determines.
  return { kind: 'array', items, complete: true }
}

function tryWhitelistedPrimitiveCall(
  expr: CallExpression,
  callee: Node,
  scope: EvalScope,
  budget: Budget,
  depth: number,
): StaticValue | undefined {
  if (Node.isIdentifier(callee) && WHITELISTED_COERCIONS.has(callee.getText())) {
    const argExpr = expr.getArguments()[0]
    if (!argExpr) return { kind: 'literal', value: callee.getText() === 'String' ? '' : 0 }
    const arg = evaluateNode(argExpr, scope, budget, depth + 1)
    if (arg.kind !== 'literal') return unresolved(`${callee.getText()}(...) argument is not statically resolvable`)
    return { kind: 'literal', value: callee.getText() === 'String' ? String(arg.value) : Number(arg.value) }
  }

  if (!Node.isPropertyAccessExpression(callee)) return undefined
  const methodName = callee.getName()
  if (methodName === 'filter') return tryFilterBoolean(expr, callee, scope, budget, depth)

  // `Math.f(…)`. `isWhitelistedCallShape` has always ADMITTED these, but nothing
  // ever computed one: `Math` is not a resolvable binding, so the receiver check
  // below rejected every call. `Math.round(pct)` and
  // `Math.max(0, Math.min(100, pct))` are how a clamped percentage is written,
  // and both silently produced nothing.
  const mathFn = mathFunction(callee)
  if (mathFn) {
    const args = expr.getArguments().map((a) => evaluateNode(a, scope, budget, depth + 1))
    if (args.some((a) => a.kind !== 'literal')) return unresolved(`Math.${methodName}(...) argument is not statically resolvable`)
    const numbers = args.map((a) => Number((a as Extract<StaticValue, { kind: 'literal' }>).value))
    if (numbers.some((n) => Number.isNaN(n))) return unresolved(`Math.${methodName}(...) argument is not a number`)
    const result = mathFn(...numbers)
    return Number.isFinite(result)
      ? { kind: 'literal', value: result }
      : unresolved(`Math.${methodName}(...) produced a non-finite number`)
  }

  if (!WHITELISTED_METHODS.has(methodName)) return undefined

  const receiver = evaluateNode(callee.getExpression(), scope, budget, depth + 1)
  const args = expr.getArguments().map((a) => evaluateNode(a, scope, budget, depth + 1))
  if (args.some((a) => a.kind !== 'literal')) return unresolved(`${methodName}(...) argument is not statically resolvable`)
  const argValues = args.map((a) => (a as Extract<StaticValue, { kind: 'literal' }>).value)

  if (receiver.kind === 'literal') return callStringMethod(receiver.value, methodName, argValues)
  if (receiver.kind === 'array' && methodName === 'join') {
    if (receiver.items.some((i) => i.kind !== 'literal')) return unresolved('join() on an array with unresolved items')
    const sep = argValues[0] !== undefined ? String(argValues[0]) : ','
    const joined = receiver.items.map((i) => String((i as Extract<StaticValue, { kind: 'literal' }>).value)).join(sep)
    return { kind: 'literal', value: joined }
  }
  return unresolved(`${methodName}(...) receiver is not statically resolvable`)
}

function callStringMethod(value: string | number | boolean | null, method: string, args: unknown[]): StaticValue {
  const s = String(value)
  switch (method) {
    case 'toUpperCase': return { kind: 'literal', value: s.toUpperCase() }
    case 'toLowerCase': return { kind: 'literal', value: s.toLowerCase() }
    case 'trim': return { kind: 'literal', value: s.trim() }
    case 'toFixed': return { kind: 'literal', value: typeof value === 'number' ? value.toFixed(Number(args[0] ?? 0)) : s }
    case 'padStart': return { kind: 'literal', value: s.padStart(Number(args[0] ?? 0), args[1] !== undefined ? String(args[1]) : ' ') }
    default: return unresolved(`unsupported whitelisted method "${method}"`)
  }
}
