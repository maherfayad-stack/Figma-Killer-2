/**
 * staticEvalCore — the shared foundation for §7's static evaluator: the
 * recursive expression walker (`evaluateNode`), the binding-resolution chain
 * (component-body locals -> module scope -> imports), and the shared guards.
 * See `./staticEval`'s doc comment for the full tier-boundary explanation —
 * that module is the public composer; THIS module owns Tier A (literals,
 * templates, member access, object/array literals) plus the identifier/
 * module/import resolution every tier depends on.
 *
 * Split out of `staticEval.ts` to stay under the module-size-budget ceiling,
 * along a genuinely acyclic seam: `evaluateNode` never imports the Tier B/C
 * call-handling logic (`./staticEvalCalls`) directly — instead it invokes
 * `budget.callEvaluator(...)`, a function reference the PUBLIC composer
 * (`./staticEval`) injects once when it builds the `Budget` for a top-level
 * `evaluateExpression` call. `./staticEvalCalls` imports everything it needs
 * FROM this module (one direction only); this module imports nothing back.
 */
import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type CallExpression,
  type ConditionalExpression,
  type ElementAccessExpression,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration,
} from 'ts-morph'
import * as path from 'node:path'
import { resolveCssModuleImport, resolveImageAssetImport, resolveRawTextImport } from './assetImports'
import { findDefaultLiteralNode } from './defaultLiteralBindings'
import { evaluateBinaryOperator, evaluateUnaryOperator } from './staticEvalOperators'
import type { FunctionLike } from './types'

// ---------------------------------------------------------------------------
// Public shapes (§7.2)
// ---------------------------------------------------------------------------

export type {
  ArrowFunctionOrDecl,
  EvalScope,
  ValueOrigin,
  LocalBinding,
  PageEvalBudget,
  StaticEvalOptions,
  StaticValue,
} from './staticEvalTypes'
import type {
  EvalScope,
  ValueOrigin,
  LocalBinding,
  PageEvalBudget,
  StaticEvalOptions,
  StaticValue,
} from './staticEvalTypes'

/**
 * Binding hops only (see `StaticEvalOptions.maxDepth`). A single Tier B read
 * like `t.homepage.greeting` already spends ~9 of these getting from the page's
 * `t` through the hook, the provider, its `useMemo`, and into the imported
 * dictionary — and a page-local alias (`const c = t.bookingConfirmation`) adds
 * more. 24 leaves real headroom above the corpus's worst chain while still
 * bounding runaway binding recursion; `maxSteps` and `cycle` are the guards
 * that actually stop divergence.
 */
const DEFAULT_MAX_DEPTH = 24
const DEFAULT_MAX_STEPS = 2000
const DEFAULT_PAGE_STEP_BUDGET = 20_000
export const EMPTY_LOCALS: ReadonlyMap<string, LocalBinding> = new Map()

/** A `CallExpression` evaluator, injected into `Budget` — see this module's doc comment for why `evaluateNode` never imports `./staticEvalCalls` directly. */
export type CallEvaluator = (expr: CallExpression, scope: EvalScope, budget: Budget, depth: number) => StaticValue

export interface Budget {
  maxDepth: number
  maxSteps: number
  steps: number
  cycle: Set<string>
  preferredKey: string | undefined
  pageBudget: PageEvalBudget | undefined
  workspaceRoot: string | undefined
  /** WS-2.2 — see `StaticEvalOptions.cssModuleClassMaps`. */
  cssModuleClassMaps: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined
  callEvaluator: CallEvaluator
  /**
   * Set whenever a guard (depth, per-call steps, page budget, cycle) cut an
   * evaluation short. A truncated result describes the budget that happened to
   * be left at that moment, not the code — so it MUST NOT be memoized, or the
   * order pages happen to be parsed in silently decides what resolves. See
   * `evaluateModuleConst`.
   */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPageEvalBudget(limit = DEFAULT_PAGE_STEP_BUDGET): PageEvalBudget {
  return { remaining: limit }
}

/** Fresh `Budget` for one top-level `evaluateExpression` call — the composer (`./staticEval`) is the only caller, supplying the concrete `callEvaluator`. */
export function createBudget(opts: StaticEvalOptions, callEvaluator: CallEvaluator): Budget {
  return {
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    steps: 0,
    cycle: new Set(),
    preferredKey: opts.preferredKey,
    pageBudget: opts.pageBudget,
    workspaceRoot: opts.workspaceRoot,
    cssModuleClassMaps: opts.cssModuleClassMaps,
    callEvaluator,
    truncated: false,
  }
}

/**
 * Runs `evaluate` and reports whether ANY guard tripped inside it, restoring
 * the caller's own truncation state (an inner truncation still propagates
 * outward — a partial value contaminates whatever is built from it). Every
 * memoizing call site wraps its work in this and caches only complete results.
 */
export function trackTruncation(budget: Budget, evaluate: () => StaticValue): { result: StaticValue; truncated: boolean } {
  const outer = budget.truncated
  budget.truncated = false
  const result = evaluate()
  const truncated = budget.truncated
  budget.truncated = outer || truncated
  return { result, truncated }
}

/**
 * Builds the scope §7.6's wiring passes to `evaluateExpression`: component-body
 * `const` bindings (from `componentFn`'s own top-level statements — flat, not
 * block-scoped, matching the parser's existing simplifications elsewhere,
 * e.g. `imageImports`) plus everything reachable from `sourceFile`'s own
 * module scope / imports. `componentFn` is omitted when evaluating
 * module-scope code itself (no component body to see).
 */
export function createEvalScope(sourceFile: SourceFile, componentFn?: FunctionLike): EvalScope {
  return { sourceFile, locals: buildComponentLocals(componentFn) }
}

function buildComponentLocals(fn: FunctionLike | undefined): ReadonlyMap<string, LocalBinding> {
  if (!fn) return EMPTY_LOCALS
  const body = fn.getBody()
  if (!body || !Node.isBlock(body)) return EMPTY_LOCALS // concise-body components have no top-level statements

  const locals = new Map<string, LocalBinding>()
  for (const statement of body.getStatements()) {
    if (!Node.isVariableStatement(statement)) continue
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer()
      if (!init) continue
      const nameNode = decl.getNameNode()
      if (Node.isIdentifier(nameNode)) {
        locals.set(nameNode.getText(), { kind: 'expr', node: init })
        continue
      }
      if (!Node.isObjectBindingPattern(nameNode)) continue // array destructuring — not in the corpus, left unsupported
      for (const element of nameNode.getElements()) {
        if (element.getDotDotDotToken()) continue
        const elName = element.getNameNode()
        if (!Node.isIdentifier(elName)) continue // nested pattern — unsupported
        const propName = element.getPropertyNameNode()?.getText() ?? elName.getText()
        locals.set(elName.getText(), { kind: 'destructure', source: init, key: propName })
      }
    }
  }
  return locals
}

// ---------------------------------------------------------------------------
// Guards — exported for `./staticEvalCalls` to share
// ---------------------------------------------------------------------------

function bumpSteps(budget: Budget): boolean {
  budget.steps += 1
  if (budget.steps > budget.maxSteps) {
    budget.truncated = true
    return false
  }
  if (budget.pageBudget) {
    budget.pageBudget.remaining -= 1
    if (budget.pageBudget.remaining <= 0) {
      budget.truncated = true
      return false
    }
  }
  return true
}

export function unresolved(reason: string, partial?: string): StaticValue {
  return partial !== undefined ? { kind: 'unresolved', reason, partial } : { kind: 'unresolved', reason }
}

export function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

/** Propagates a Tier B.4 branch-pick note through a member-access chain, without ever overwriting a MORE specific (deeper) note already attached. */
/**
 * `{ origin }` for a literal token, or `{}` when it cannot be addressed — no
 * configured workspace root, or a file outside it (a `node_modules` dictionary
 * is not the user's to rewrite).
 */
function originOf(literal: Node, budget: Budget): { origin?: ValueOrigin } {
  const root = budget.workspaceRoot
  if (!root) return {}
  const sourceFile = literal.getSourceFile()
  const rel = path.relative(path.resolve(root), path.resolve(sourceFile.getFilePath()))
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return {}
  const { line, column } = sourceFile.getLineAndColumnAtPos(literal.getStart())
  return { origin: { rel: rel.split(path.sep).join('/'), line, col: column } }
}

export function withNote(value: StaticValue, note: string | undefined): StaticValue {
  if (!note || value.kind === 'unresolved' || value.kind === 'fn' || value.note) return value
  return { ...value, note }
}

// ---------------------------------------------------------------------------
// Core recursive evaluator (Tier A)
// ---------------------------------------------------------------------------

export function evaluateNode(exprIn: Node, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  if (depth > budget.maxDepth) {
    budget.truncated = true
    return unresolved('max resolution depth exceeded')
  }
  if (!bumpSteps(budget)) return unresolved('evaluator step budget exceeded')

  const expr = unwrapParens(exprIn)

  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    // The origin is attached HERE, at the only place a literal is read out of a
    // source file, so every path that merely passes the value along — an
    // identifier, a const, `pluck` off an object, an array index — carries it for
    // free, and every path that COMPUTES a new value cannot.
    return { kind: 'literal', value: expr.getLiteralText(), ...originOf(expr, budget) }
  }
  if (Node.isNumericLiteral(expr)) {
    return { kind: 'literal', value: expr.getLiteralValue(), ...originOf(expr, budget) }
  }
  const kind = expr.getKind()
  if (kind === SyntaxKind.TrueKeyword) return { kind: 'literal', value: true }
  if (kind === SyntaxKind.FalseKeyword) return { kind: 'literal', value: false }
  if (kind === SyntaxKind.NullKeyword) return { kind: 'literal', value: null }

  if (Node.isTemplateExpression(expr)) return evaluateTemplate(expr, scope, budget, depth)
  if (Node.isIdentifier(expr)) return resolveIdentifier(expr.getText(), scope, budget, depth)
  if (Node.isPropertyAccessExpression(expr)) return evaluatePropertyAccess(expr, scope, budget, depth)
  if (Node.isElementAccessExpression(expr)) return evaluateElementAccess(expr, scope, budget, depth)
  if (Node.isObjectLiteralExpression(expr)) return evaluateObjectLiteral(expr, scope, budget, depth)
  if (Node.isArrayLiteralExpression(expr)) return evaluateArrayLiteral(expr, scope, budget, depth)
  if (Node.isConditionalExpression(expr)) return evaluateConditionalExpression(expr, scope, budget, depth)
  // Tier A operators. Both decline (`undefined`) for an operator they do not own
  // — a comparison in value position falls through to `evaluateCondition` below,
  // which yields a real boolean.
  if (Node.isBinaryExpression(expr)) {
    const evaluated = evaluateBinaryOperator(expr, (operand) => evaluateNode(operand, scope, budget, depth + 1))
    if (evaluated) return evaluated
    const asBoolean = evaluateCondition(expr, scope, budget, depth)
    return asBoolean === undefined
      ? unresolved(`unsupported binary operator (${expr.getOperatorToken().getKindName()})`)
      : { kind: 'literal', value: asBoolean }
  }
  if (Node.isPrefixUnaryExpression(expr)) {
    const evaluated = evaluateUnaryOperator(expr, (operand) => evaluateNode(operand, scope, budget, depth + 1))
    if (evaluated) return evaluated
  }
  // CallExpression is NOT handled inline — see this module's doc comment.
  if (Node.isCallExpression(expr)) return budget.callEvaluator(expr, scope, budget, depth)
  if (Node.isArrowFunction(expr) || Node.isFunctionDeclaration(expr)) return { kind: 'fn', node: expr }

  return unresolved(`unsupported expression kind (${expr.getKindName()})`)
}

/**
 * Narrow, condition-only sub-evaluator: `&&`/`||`/`!`, the six comparison
 * operators, and a bare boolean value. Returns `undefined` — never a guess —
 * when the condition is not statically decidable.
 *
 * Three callers: Tier C's `if`-chain walk in `./staticEvalCalls` and
 * `evaluateConditionalExpression` below, both selecting a VALUE, plus (via
 * the public composer's `evaluateStaticTruthiness`, `./staticEval.ts`)
 * `parsePageFile.ts`'s `selectJsxBranch` — the ONE place a JSX branch may be
 * picked using this. That is a narrow, deliberate exception, not a reopening
 * of the ban: §7.7 is about GUESSING (hook state, a runtime prop) — rendering
 * one state of a stateful screen as if it were the only one. A condition this
 * function actually resolves is not a guess; it is fully determined by source
 * text (a literal, a module-scope const, or — parser-07, via
 * `evaluateConditionOperand` below — a `useState(<literal>)` binding's own
 * initial value), same as `days === 1` deciding a plural label. When it
 * returns `undefined` (the overwhelmingly common case for a real
 * conditional), `selectJsxBranch` falls back to a stated heuristic (prefer
 * the consequent) and records the untaken side as an alternative — it never
 * renders every branch as if all were equally real, and it never guesses at
 * the condition's runtime value.
 */
export function evaluateCondition(expr: Node, scope: EvalScope, budget: Budget, depth: number): boolean | undefined {
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
    const left = evaluateConditionOperand(n.getLeft(), scope, budget, depth)
    const right = evaluateConditionOperand(n.getRight(), scope, budget, depth)
    if (left.kind !== 'literal' || right.kind !== 'literal') return undefined
    return compare(left.value, right.value)
  }
  if (Node.isPrefixUnaryExpression(n) && n.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const inner = evaluateCondition(n.getOperand(), scope, budget, depth)
    return inner === undefined ? undefined : !inner
  }
  const value = evaluateConditionOperand(n, scope, budget, depth)
  return value.kind === 'literal' && typeof value.value === 'boolean' ? value.value : undefined
}

/**
 * `evaluateNode`, plus (parser-07) a fallback to a binding's own DEFAULT
 * literal value when the ordinary binding chain can't resolve the identifier
 * — see `./defaultLiteralBindings`, which owns that read and explains why it
 * is Tier A rather than the banned Tier D.
 *
 * Used ONLY by `evaluateCondition`'s two identifier-reading spots (a
 * comparator's operand, and a bare-boolean condition) — deliberately NOT
 * wired into `resolveIdentifier`/`buildComponentLocals`, the chain every
 * OTHER Tier A/B resolution shares. That would also feed Tier B.4's
 * dynamic-dictionary-key pick (`translations[lang]` where `lang` is
 * `useState('en')`), silently overriding the `previewLocale` option the
 * language-switcher pattern depends on.
 */
function evaluateConditionOperand(node: Node, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const value = evaluateNode(node, scope, budget, depth + 1)
  if (value.kind !== 'unresolved') return value
  const literal = findDefaultLiteralNode(node)
  return literal ? evaluateNode(literal, scope, budget, depth + 1) : value
}

/**
 * `cond ? a : b`, when `cond` is statically decidable.
 *
 * This is the same act Tier C already performs for `if (cond) return x` in a
 * callee's body, so declining it here was an inconsistency: the corpus's
 * pluralisation helper is `` (days) => `+${days} Day${days === 1 ? '' : 's'}` ``,
 * and refusing the ternary left every "Days" package row blank while the "GB"
 * rows — identical but for the plural suffix — resolved fine. Pluralising inside
 * a template is one of the most common shapes in an i18n dictionary.
 *
 * A ternary whose branches contain JSX declines regardless of the condition. That
 * is §7.7's ban, and it is enforced here rather than assumed: the parser's
 * structural walk renders both JSX branches and locks them, and it must stay the
 * only thing that decides what markup exists.
 */
function evaluateConditionalExpression(
  expr: ConditionalExpression,
  scope: EvalScope,
  budget: Budget,
  depth: number,
): StaticValue {
  const whenTrue = expr.getWhenTrue()
  const whenFalse = expr.getWhenFalse()
  if (containsJsxNode(whenTrue) || containsJsxNode(whenFalse)) {
    return unresolved('a JSX ternary is resolved structurally, never by picking a branch')
  }

  const cond = evaluateCondition(expr.getCondition(), scope, budget, depth + 1)
  if (cond === undefined) return unresolved('ternary condition is not statically known')
  return evaluateNode(cond ? whenTrue : whenFalse, scope, budget, depth + 1)
}

const JSX_VALUE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.JsxElement,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.JsxFragment,
])

/** Whether `node` is JSX or contains any — see `evaluateConditionalExpression`. */
function containsJsxNode(node: Node): boolean {
  if (JSX_VALUE_KINDS.has(node.getKind())) return true
  return node.getFirstDescendant((d) => JSX_VALUE_KINDS.has(d.getKind())) !== undefined
}

function evaluateTemplate(expr: TemplateExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  let text = expr.getHead().getLiteralText()
  for (const span of expr.getTemplateSpans()) {
    const value = evaluateNode(span.getExpression(), scope, budget, depth + 1)
    if (value.kind !== 'literal') {
      // Tier A — partial template: keep the static prefix accumulated so far.
      return unresolved('template literal has an unresolvable substitution', text)
    }
    text += String(value.value)
    text += span.getLiteral().getLiteralText()
  }
  return { kind: 'literal', value: text }
}

/**
 * `Math`'s numeric constants. Its FUNCTIONS were already callable (see
 * `isWhitelistedCall` in `./staticEvalCalls`), but a constant is a property
 * access, so `2 * Math.PI * RADIUS` — the circumference every progress ring in
 * every codebase is drawn from — resolved to nothing.
 */
const MATH_CONSTANTS: ReadonlyMap<string, number> = new Map(
  (['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2'] as const)
    .map((key) => [key, Math[key]]),
)

function evaluatePropertyAccess(expr: PropertyAccessExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const objectExpr = expr.getExpression()
  const name = expr.getName()
  if (Node.isIdentifier(objectExpr) && objectExpr.getText() === 'Math') {
    const constant = MATH_CONSTANTS.get(name)
    if (constant !== undefined) return { kind: 'literal', value: constant }
  }
  const object = evaluateNode(objectExpr, scope, budget, depth + 1)
  return pluck(object, name)
}

export function pluck(value: StaticValue, key: string): StaticValue {
  if (value.kind === 'object') {
    const found = value.entries.get(key)
    return found === undefined ? unresolved(`property "${key}" not found`) : withNote(found, value.note)
  }
  if (value.kind === 'array') {
    const idx = Number(key)
    if (Number.isInteger(idx) && idx >= 0 && idx < value.items.length) return withNote(value.items[idx]!, value.note)
    return unresolved(`index "${key}" not found on array`)
  }
  if (value.kind === 'unresolved') return value
  return unresolved(`cannot read property "${key}" of a ${value.kind} value`)
}

/** Tier A computed member + array index, and Tier B.4's dynamic-key dictionary branch pick. */
function evaluateElementAccess(expr: ElementAccessExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const object = evaluateNode(expr.getExpression(), scope, budget, depth + 1)
  const argExpr = expr.getArgumentExpression()
  if (!argExpr) return unresolved('missing element-access argument')

  const key = evaluateNode(argExpr, scope, budget, depth + 1)
  if (key.kind === 'literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return pluck(object, String(key.value))
  }

  // §7.4 — non-static key: preferredKey, else the first key in source order.
  if (object.kind === 'object' && object.entries.size > 0) {
    const preferred = budget.preferredKey
    const pickedKey = preferred !== undefined && object.entries.has(preferred)
      ? preferred
      : (object.entries.keys().next().value as string)
    const picked = object.entries.get(pickedKey)!
    return withNote(picked, `dynamic key not statically known — showing the "${pickedKey}" branch`)
  }

  return unresolved('computed member key is not statically known')
}

/**
 * Members are evaluated at the SAME `depth` as the literal itself. Descending
 * into an object/array literal walks a finite piece of source text and cannot
 * diverge, so charging it against `maxDepth` — which exists to bound
 * binding-chain recursion — only means a realistically nested i18n dictionary
 * gets truncated partway down. `maxSteps`/`pageBudget` still bound the total
 * work. An identifier *inside* a member resumes spending depth normally.
 */
function evaluateObjectLiteral(expr: ObjectLiteralExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const entries = new Map<string, StaticValue>()
  for (const prop of expr.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode()
      const key = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : Node.isStringLiteral(nameNode) || Node.isNumericLiteral(nameNode)
          ? String(nameNode.getLiteralValue())
          : undefined
      if (key === undefined) continue // computed key — not in the corpus, skipped like extractInlineStyles' policy
      const init = prop.getInitializer()
      if (!init) continue
      entries.set(key, evaluateNode(init, scope, budget, depth))
      continue
    }
    if (Node.isShorthandPropertyAssignment(prop)) {
      const name = prop.getName()
      entries.set(name, resolveIdentifier(name, scope, budget, depth + 1))
    }
    // Spread / method / getter-setter properties: skipped — same "best-effort, never guess" policy.
  }
  return { kind: 'object', entries }
}

/** Same depth policy as `evaluateObjectLiteral` — see its doc comment. */
function evaluateArrayLiteral(expr: ArrayLiteralExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const items: StaticValue[] = []
  for (const el of expr.getElements()) {
    items.push(Node.isSpreadElement(el) ? unresolved('spread element') : evaluateNode(el, scope, budget, depth))
  }
  return { kind: 'array', items }
}

// ---------------------------------------------------------------------------
// Identifier resolution: component-body locals -> module scope -> imports
// ---------------------------------------------------------------------------

export function resolveIdentifier(name: string, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const local = scope.locals.get(name)
  if (local) {
    if (local.kind === 'resolved') return local.value
    if (local.kind === 'expr') return evaluateNode(local.node, scope, budget, depth + 1)
    const source = evaluateNode(local.source, scope, budget, depth + 1)
    return pluck(source, local.key)
  }

  const sameFileFn = scope.sourceFile.getFunction(name)
  if (sameFileFn) return { kind: 'fn', node: sameFileFn }

  const sameFileVar = scope.sourceFile.getVariableDeclaration(name)
  if (sameFileVar) return evaluateModuleConst(scope.sourceFile, name, sameFileVar, budget, depth)

  const imported = findImportBinding(scope.sourceFile, name)
  if (imported) {
    if (!imported.targetFile) {
      // An import that names a FILE rather than a module has no SourceFile —
      // ts-morph only tracks JS/TS — but it still has a static value: a `?raw`
      // asset's value is its CONTENTS, an image asset's is its PATH.
      const rawText = resolveRawTextImport(scope.sourceFile, name, budget.workspaceRoot)
      if (rawText !== undefined) return { kind: 'literal', value: rawText }
      const asset = resolveImageAssetImport(scope.sourceFile, name, budget.workspaceRoot)
      if (asset !== undefined) return { kind: 'literal', value: asset.path, origin: asset.origin }
      const cssModule = resolveCssModuleImport(scope.sourceFile, name, budget.workspaceRoot, budget.cssModuleClassMaps)
      if (cssModule !== undefined) {
        const entries = new Map<string, StaticValue>()
        for (const [localName, globalName] of Object.entries(cssModule)) {
          entries.set(localName, { kind: 'literal', value: globalName })
        }
        return { kind: 'object', entries }
      }
      return unresolved(`cannot resolve the import target for "${name}"`)
    }
    return evaluateImportedName(imported.targetFile, imported.exportedName, budget, depth)
  }

  return unresolved(`"${name}" is not a statically resolvable binding`)
}

/** Process-wide memo: a module-scope `const`'s resolved value, keyed by its own `SourceFile` (auto-GC'd with the Project) then by binding name. See `./staticEval`'s doc comment. */
const moduleConstCache = new WeakMap<SourceFile, Map<string, StaticValue>>()

export function evaluateModuleConst(
  file: SourceFile,
  name: string,
  decl: VariableDeclaration,
  budget: Budget,
  depth: number,
): StaticValue {
  const cached = moduleConstCache.get(file)?.get(name)
  if (cached) return cached

  const cycleKey = `${file.getFilePath()}#${name}`
  if (budget.cycle.has(cycleKey)) {
    budget.truncated = true
    return unresolved(`cyclic reference resolving "${name}"`)
  }
  budget.cycle.add(cycleKey)

  const init = decl.getInitializer()
  const { result, truncated } = trackTruncation(budget, () =>
    init
      ? evaluateNode(init, { sourceFile: file, locals: EMPTY_LOCALS }, budget, depth + 1)
      : unresolved(`"${name}" has no initializer`),
  )

  budget.cycle.delete(cycleKey)

  // Only COMPLETE results are memoized. Caching a depth/step-truncated
  // dictionary would hand every later page a copy whose leaves are all
  // `unresolved`, making what resolves depend on which page happened to be
  // parsed first.
  if (!truncated) {
    let byName = moduleConstCache.get(file)
    if (!byName) {
      byName = new Map()
      moduleConstCache.set(file, byName)
    }
    byName.set(name, result)
  }
  return result
}

export interface ImportBindingTarget {
  targetFile: SourceFile | undefined
  /** `'default'`, or the target file's own exported name (honouring a rename via `import { Foo as Bar }`). */
  exportedName: string
}

export function findImportBinding(sourceFile: SourceFile, localName: string): ImportBindingTarget | undefined {
  for (const decl of sourceFile.getImportDeclarations()) {
    const defaultImport = decl.getDefaultImport()
    if (defaultImport?.getText() === localName) {
      return { targetFile: decl.getModuleSpecifierSourceFile(), exportedName: 'default' }
    }
    for (const named of decl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getNameNode().getText()
      if (local === localName) {
        return { targetFile: decl.getModuleSpecifierSourceFile(), exportedName: named.getNameNode().getText() }
      }
    }
  }
  return undefined
}

function evaluateImportedName(targetFile: SourceFile, exportedName: string, budget: Budget, depth: number): StaticValue {
  if (exportedName === 'default') {
    const decl = findDefaultExportedVariable(targetFile)
    if (!decl) return unresolved('no default-exported const found in imported module')
    return evaluateModuleConst(targetFile, '<default>', decl, budget, depth)
  }

  const fn = targetFile.getFunction(exportedName)
  if (fn && fn.isExported()) return { kind: 'fn', node: fn }

  const decl = targetFile.getVariableDeclaration(exportedName)
  if (!decl || !(decl.getVariableStatement()?.isExported() ?? false)) {
    return unresolved(`"${exportedName}" is not an exported const in the imported module`)
  }
  return evaluateModuleConst(targetFile, exportedName, decl, budget, depth)
}

export function findDefaultExportedVariable(file: SourceFile): VariableDeclaration | undefined {
  const exportAssignment = file.getExportAssignments().find((ea) => !ea.isExportEquals())
  const expr = exportAssignment?.getExpression()
  return expr && Node.isIdentifier(expr) ? file.getVariableDeclaration(expr.getText()) : undefined
}
