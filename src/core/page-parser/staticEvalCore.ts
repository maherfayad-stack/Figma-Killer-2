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
  type ArrowFunction,
  type CallExpression,
  type ConditionalExpression,
  type ElementAccessExpression,
  type FunctionDeclaration,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration,
} from 'ts-morph'
import { resolveRawTextImport } from './rawTextImports'
import type { FunctionLike } from './types'

// ---------------------------------------------------------------------------
// Public shapes (§7.2)
// ---------------------------------------------------------------------------

export type StaticValue =
  | { kind: 'literal'; value: string | number | boolean | null; note?: string }
  | { kind: 'object'; entries: Map<string, StaticValue>; note?: string }
  | { kind: 'array'; items: StaticValue[]; note?: string }
  | { kind: 'fn'; node: ArrowFunctionOrDecl }
  | { kind: 'unresolved'; reason: string; partial?: string }

/** The plan's §7.2 `{kind:'fn'}` shape — narrower than `FunctionLike` (excludes `FunctionExpression`, unused by the corpus for a callable const). */
export type ArrowFunctionOrDecl = ArrowFunction | FunctionDeclaration

export interface StaticEvalOptions {
  /** Max BINDING-resolution depth (identifier -> const -> identifier -> …). Descending into an already-resolved object/array literal's own members does NOT count — see `evaluateObjectLiteral`. Default 24. */
  maxDepth?: number
  /** Max nodes visited per top-level `evaluateExpression` call. Default 2000. */
  maxSteps?: number
  /** Preferred key indexing a dictionary with a non-static key (`translations[lang]`) — falls back to the first key in source order. Sourced from `.studio/meta.json`'s `previewLocale`. */
  preferredKey?: string
  /** Global per-page guard, shared across every call for one page load (incl. inlined subtrees) — see `PageEvalBudget`. Create with `createPageEvalBudget()`. */
  pageBudget?: PageEvalBudget
  /**
   * Absolute workspace root. Enables resolving Vite `?raw` text imports
   * (`import icon from './x.svg?raw'`) to the file's contents — see
   * `resolveRawTextImport`. Required for that, because reading a file off a
   * relative specifier needs a boundary to contain it to. Omit and `?raw`
   * imports stay unresolved, exactly as before.
   */
  workspaceRoot?: string
}

/** A component-body/module-scope binding chain — see `createEvalScope`. */
export interface EvalScope {
  sourceFile: SourceFile
  locals: ReadonlyMap<string, LocalBinding>
}

/** A mutable page-wide step counter, shared across every `evaluateExpression` call for one page (and every locally-inlined subtree) — see `StaticEvalOptions.pageBudget`. */
export interface PageEvalBudget {
  remaining: number
}

export type LocalBinding =
  /** `const x = <node>` — re-evaluated in the SAME scope each lookup. */
  | { kind: 'expr'; node: Node }
  /** `const { key: x } = <node>` (or `{ x }` shorthand, key === name). */
  | { kind: 'destructure'; source: Node; key: string }
  /** An already-evaluated value — how Tier C binds a call's arguments to the callee's own parameter names. */
  | { kind: 'resolved'; value: StaticValue }

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
    return { kind: 'literal', value: expr.getLiteralText() }
  }
  if (Node.isNumericLiteral(expr)) return { kind: 'literal', value: expr.getLiteralValue() }
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
 * Two callers, both selecting a VALUE: Tier C's `if`-chain walk in
 * `./staticEvalCalls`, and `evaluateConditionalExpression` below.
 *
 * NEVER reach for this to pick a JSX branch. §7.7's ban is about markup: a
 * stateful screen has many states and rendering one as if it were the source
 * misrepresents it, so the parser renders every branch and locks them. Deciding
 * `days === 1` to build a plural label is a different act — the condition is
 * fully determined by source text, and the result is a string.
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

function evaluatePropertyAccess(expr: PropertyAccessExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const object = evaluateNode(expr.getExpression(), scope, budget, depth + 1)
  return pluck(object, expr.getName())
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
      // A `?raw` text asset has no SourceFile — ts-morph only tracks JS/TS —
      // but its CONTENTS are a perfectly static value.
      const rawText = resolveRawTextImport(scope.sourceFile, name, budget.workspaceRoot)
      if (rawText !== undefined) return { kind: 'literal', value: rawText }
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
