/**
 * staticEvalCalls — Tier B (hook -> `useContext` -> provider's static
 * `value`) and Tier C (calling a resolvable pure arrow/function) call
 * evaluation, plus the whitelisted primitive method/coercion calls §7.5
 * names (`String`, `Number`, `Math.*`, `.toFixed`, `.padStart`,
 * `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`). See `./staticEval`'s doc
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
} from 'ts-morph'
import type { FunctionLike } from './types'
import {
  createEvalScope,
  evaluateNode,
  findDefaultExportedVariable,
  findImportBinding,
  trackTruncation,
  unresolved,
  unwrapParens,
  withNote,
  type ArrowFunctionOrDecl,
  type Budget,
  type EvalScope,
  type LocalBinding,
  type StaticValue,
} from './staticEvalCore'

const WHITELISTED_COERCIONS: ReadonlySet<string> = new Set(['String', 'Number'])
const WHITELISTED_METHODS: ReadonlySet<string> = new Set([
  'toFixed', 'padStart', 'toUpperCase', 'toLowerCase', 'trim', 'join',
])

/** The `Budget.callEvaluator` implementation — dispatches a `CallExpression` to the whitelist, Tier B, or Tier C, in that order. */
export function evaluateCall(expr: CallExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const callee = expr.getExpression()

  const memoized = tryUseMemoUnwrap(expr, callee, scope, budget, depth)
  if (memoized) return memoized

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

/** The nearest enclosing component/hook function body, or `undefined` for a module-scope expression. */
function enclosingFunctionLike(node: Node): FunctionLike | undefined {
  return node.getFirstAncestor(
    (a): a is FunctionLike =>
      Node.isArrowFunction(a) || Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a),
  )
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

/** Narrow, condition-only sub-evaluator for Tier C's if-chain walk — NEVER reused for JSX ternary/branch selection (§7.7 bans that). */
function evaluateCondition(expr: Node, scope: EvalScope, budget: Budget, depth: number): boolean | undefined {
  const n = unwrapParens(expr)
  if (Node.isBinaryExpression(n)) {
    const opKind = n.getOperatorToken().getKind()
    if (opKind === SyntaxKind.AmpersandAmpersandToken) {
      const left = evaluateCondition(n.getLeft(), scope, budget, depth)
      if (left === false) return false
      const right = evaluateCondition(n.getRight(), scope, budget, depth)
      if (right === false) return false
      return left === true && right === true ? true : undefined
    }
    if (opKind === SyntaxKind.BarBarToken) {
      const left = evaluateCondition(n.getLeft(), scope, budget, depth)
      if (left === true) return true
      const right = evaluateCondition(n.getRight(), scope, budget, depth)
      if (right === true) return true
      return left === false && right === false ? false : undefined
    }
    const comparators: Partial<Record<SyntaxKind, (a: unknown, b: unknown) => boolean>> = {
      [SyntaxKind.EqualsEqualsEqualsToken]: (a, b) => a === b,
      [SyntaxKind.EqualsEqualsToken]: (a, b) => a === b,
      [SyntaxKind.ExclamationEqualsEqualsToken]: (a, b) => a !== b,
      [SyntaxKind.ExclamationEqualsToken]: (a, b) => a !== b,
      [SyntaxKind.LessThanToken]: (a, b) => (a as number) < (b as number),
      [SyntaxKind.LessThanEqualsToken]: (a, b) => (a as number) <= (b as number),
      [SyntaxKind.GreaterThanToken]: (a, b) => (a as number) > (b as number),
      [SyntaxKind.GreaterThanEqualsToken]: (a, b) => (a as number) >= (b as number),
    }
    const compare = comparators[opKind]
    if (!compare) return undefined
    const left = evaluateNode(n.getLeft(), scope, budget, depth + 1)
    const right = evaluateNode(n.getRight(), scope, budget, depth + 1)
    if (left.kind !== 'literal' || right.kind !== 'literal') return undefined
    return compare(left.value, right.value)
  }
  if (Node.isPrefixUnaryExpression(n) && n.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const inner = evaluateCondition(n.getOperand(), scope, budget, depth)
    return inner === undefined ? undefined : !inner
  }
  const value = evaluateNode(n, scope, budget, depth + 1)
  return value.kind === 'literal' && typeof value.value === 'boolean' ? value.value : undefined
}

// -- Whitelisted primitive method / coercion calls (§7.5) --------------------

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
