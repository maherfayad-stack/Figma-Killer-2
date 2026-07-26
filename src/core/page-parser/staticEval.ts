/**
 * staticEval — §7's bounded static evaluator: resolves a JSX expression
 * (`{t.homepage.greeting}`, `{PRODUCT_CARDS}`, `` {`${pct}%`} ``, …) to a
 * concrete value by reading the AST, never by running the source as React.
 * No hook is ever executed; no component is ever rendered. This is a partial
 * evaluator for a small, explicit set of patterns — NOT a JavaScript
 * interpreter. See the plan's §7.1 tier table and §10 risk register: this
 * module is the single highest-risk place for scope creep, so every
 * capability below is deliberately bounded to what a named tier asks for.
 *
 * Tier boundaries (do not blur these when extending):
 *   A — module-scope/cross-file `const` object/array + member chain, a
 *       component-body local alias, a computed member with a resolvable key,
 *       a template literal with resolvable parts, an array index.
 *   B — a destructured hook return, traced to its context provider's static
 *       `value` (AST tracing, not React semantics); a dictionary indexed by a
 *       non-static key, resolved by picking a preferred/first key + a note.
 *   C — calling a resolvable pure arrow/function, inside the explicit
 *       envelope in `qualifiesForTierC`.
 *   D (loop expansion, conditional-branch selection, hook state, effects,
 *      async) is BANNED — never implement it here.
 *
 * Guards are non-negotiable and apply to every code path: a cycle set keyed
 * `${file}#${bindingName}`, a per-call `maxDepth`/`maxSteps`, and an optional
 * page-wide step budget shared across every expression on one page (and every
 * inlined subtree — see `PageEvalBudget`). Every guard trip — and any
 * unexpected internal error — resolves to `{kind:'unresolved'}`, never an
 * exception, never a hang, matching `parsePageFile`'s never-throw contract.
 *
 * Performance: resolving a module-scope `const` (e.g. a whole `translations`
 * object) is memoized per `SourceFile` in a process-wide `WeakMap` — reading
 * `t.homepage.greeting` on every element of a page re-walks the ALREADY
 * RESOLVED in-memory value, not the source file, and a heavily-referenced
 * file like `translations.js` is only ever evaluated once per (Project,
 * binding) pair. A context's provider-tracing result (the expensive part —
 * scanning every file in the workspace for `<X.Provider>`) is memoized the
 * same way, keyed by the hook's own function declaration node.
 */
import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type ArrowFunction,
  type CallExpression,
  type ElementAccessExpression,
  type FunctionDeclaration,
  type JsxAttribute,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type ObjectLiteralExpression,
  type Project,
  type PropertyAccessExpression,
  type SourceFile,
  type TemplateExpression,
  type VariableDeclaration,
} from 'ts-morph'
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

/** The plan's §7.2 `{kind:'fn'}` shape — deliberately narrower than `FunctionLike` (excludes `FunctionExpression`, which the corpus never uses for a callable const). */
type ArrowFunctionOrDecl = ArrowFunction | FunctionDeclaration

export interface StaticEvalOptions {
  /** Max resolution depth through bindings/members. Default 12. */
  maxDepth?: number
  /** Max nodes visited per top-level `evaluateExpression` call. Default 2000. */
  maxSteps?: number
  /**
   * Preferred key when indexing a dictionary with a non-static key
   * (`translations[lang]`). Falls back to the object's FIRST key (source
   * order). Sourced from `.studio/meta.json`'s `previewLocale`.
   */
  preferredKey?: string
  /**
   * Global per-page guard (§7.2), on top of each call's own `maxSteps` —
   * shared across EVERY `evaluateExpression` call for one page load,
   * including every locally-inlined subtree, so many cheap-looking
   * expressions can't collectively add up to unbounded work. Create one with
   * `createPageEvalBudget()` per page and pass the SAME object to every call
   * for that page; omit only for isolated single-expression tests.
   */
  pageBudget?: PageEvalBudget
}

/** A component-body/module-scope binding chain — see `createEvalScope`. */
export interface EvalScope {
  sourceFile: SourceFile
  locals: ReadonlyMap<string, LocalBinding>
}

/** Mutable mutable mutable — see `StaticEvalOptions.pageBudget`'s doc comment. */
export interface PageEvalBudget {
  remaining: number
}

type LocalBinding =
  /** `const x = <node>` — re-evaluated in the SAME scope each lookup. */
  | { kind: 'expr'; node: Node }
  /** `const { key: x } = <node>` (or `{ x }` shorthand, key === name). */
  | { kind: 'destructure'; source: Node; key: string }
  /** An already-evaluated value — how Tier C binds a call's arguments to the callee's own parameter names. */
  | { kind: 'resolved'; value: StaticValue }

const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_STEPS = 2000
const DEFAULT_PAGE_STEP_BUDGET = 20_000
const EMPTY_LOCALS: ReadonlyMap<string, LocalBinding> = new Map()

const WHITELISTED_COERCIONS: ReadonlySet<string> = new Set(['String', 'Number'])
const WHITELISTED_METHODS: ReadonlySet<string> = new Set([
  'toFixed', 'padStart', 'toUpperCase', 'toLowerCase', 'trim', 'join',
])

interface Budget {
  maxDepth: number
  maxSteps: number
  steps: number
  cycle: Set<string>
  preferredKey: string | undefined
  pageBudget: PageEvalBudget | undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPageEvalBudget(limit = DEFAULT_PAGE_STEP_BUDGET): PageEvalBudget {
  return { remaining: limit }
}

/**
 * Builds the scope §7.6's wiring passes to `evaluateExpression`:
 * component-body `const` bindings (from `componentFn`'s own top-level
 * statements — flat, not block-scoped, matching the parser's existing
 * simplifications elsewhere, e.g. `imageImports`) plus everything reachable
 * from `sourceFile`'s own module scope / imports. `componentFn` is omitted
 * when evaluating module-scope code itself (no component body to see).
 */
export function createEvalScope(sourceFile: SourceFile, componentFn?: FunctionLike): EvalScope {
  return { sourceFile, locals: buildComponentLocals(componentFn) }
}

/**
 * Resolves `expr` to a static value, or reports why it can't. Pure (does not
 * mutate `expr`/`scope`); memoized internally per `(SourceFile, binding name)`
 * for module-scope consts and per hook-declaration for provider tracing — see
 * this module's doc comment. NEVER throws.
 */
export function evaluateExpression(expr: Node, scope: EvalScope, opts: StaticEvalOptions = {}): StaticValue {
  const budget: Budget = {
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    steps: 0,
    cycle: new Set(),
    preferredKey: opts.preferredKey,
    pageBudget: opts.pageBudget,
  }
  try {
    return evaluateNode(expr, scope, budget, 0)
  } catch (err) {
    console.error('[staticEval]', err)
    return { kind: 'unresolved', reason: 'internal evaluator error' }
  }
}

// ---------------------------------------------------------------------------
// Component-body locals (Tier A local alias / Tier B hook destructuring)
// ---------------------------------------------------------------------------

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
// Guards
// ---------------------------------------------------------------------------

function bumpSteps(budget: Budget): boolean {
  budget.steps += 1
  if (budget.steps > budget.maxSteps) return false
  if (budget.pageBudget) {
    budget.pageBudget.remaining -= 1
    if (budget.pageBudget.remaining <= 0) return false
  }
  return true
}

function unresolved(reason: string, partial?: string): StaticValue {
  return partial !== undefined ? { kind: 'unresolved', reason, partial } : { kind: 'unresolved', reason }
}

function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

/** Propagates a Tier B.4 branch-pick note through a member-access chain, without ever overwriting a MORE specific (deeper) note already attached. */
function withNote(value: StaticValue, note: string | undefined): StaticValue {
  if (!note || value.kind === 'unresolved' || value.kind === 'fn' || value.note) return value
  return { ...value, note }
}

// ---------------------------------------------------------------------------
// Core recursive evaluator
// ---------------------------------------------------------------------------

function evaluateNode(exprIn: Node, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  if (depth > budget.maxDepth) return unresolved('max resolution depth exceeded')
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
  if (Node.isCallExpression(expr)) return evaluateCall(expr, scope, budget, depth)
  if (Node.isArrowFunction(expr) || Node.isFunctionDeclaration(expr)) return { kind: 'fn', node: expr }

  return unresolved(`unsupported expression kind (${expr.getKindName()})`)
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

function pluck(value: StaticValue, key: string): StaticValue {
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
      entries.set(key, evaluateNode(init, scope, budget, depth + 1))
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

function evaluateArrayLiteral(expr: ArrayLiteralExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const items: StaticValue[] = []
  for (const el of expr.getElements()) {
    items.push(Node.isSpreadElement(el) ? unresolved('spread element') : evaluateNode(el, scope, budget, depth + 1))
  }
  return { kind: 'array', items }
}

// ---------------------------------------------------------------------------
// Identifier resolution: component-body locals -> module scope -> imports
// ---------------------------------------------------------------------------

function resolveIdentifier(name: string, scope: EvalScope, budget: Budget, depth: number): StaticValue {
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
    if (!imported.targetFile) return unresolved(`cannot resolve the import target for "${name}"`)
    return evaluateImportedName(imported.targetFile, imported.exportedName, budget, depth)
  }

  return unresolved(`"${name}" is not a statically resolvable binding`)
}

/** Process-wide memo: a module-scope `const`'s resolved value, keyed by its own `SourceFile` (auto-GC'd with the Project) then by binding name. See this module's doc comment. */
const moduleConstCache = new WeakMap<SourceFile, Map<string, StaticValue>>()

function evaluateModuleConst(
  file: SourceFile,
  name: string,
  decl: VariableDeclaration,
  budget: Budget,
  depth: number,
): StaticValue {
  const cached = moduleConstCache.get(file)?.get(name)
  if (cached) return cached

  const cycleKey = `${file.getFilePath()}#${name}`
  if (budget.cycle.has(cycleKey)) return unresolved(`cyclic reference resolving "${name}"`)
  budget.cycle.add(cycleKey)

  const init = decl.getInitializer()
  const result = init
    ? evaluateNode(init, { sourceFile: file, locals: EMPTY_LOCALS }, budget, depth + 1)
    : unresolved(`"${name}" has no initializer`)

  budget.cycle.delete(cycleKey)

  let byName = moduleConstCache.get(file)
  if (!byName) {
    byName = new Map()
    moduleConstCache.set(file, byName)
  }
  byName.set(name, result)
  return result
}

interface ImportBindingTarget {
  targetFile: SourceFile | undefined
  /** `'default'`, or the target file's own exported name (honouring a rename via `import { Foo as Bar }`). */
  exportedName: string
}

function findImportBinding(sourceFile: SourceFile, localName: string): ImportBindingTarget | undefined {
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

function findDefaultExportedVariable(file: SourceFile): VariableDeclaration | undefined {
  const exportAssignment = file.getExportAssignments().find((ea) => !ea.isExportEquals())
  const expr = exportAssignment?.getExpression()
  return expr && Node.isIdentifier(expr) ? file.getVariableDeclaration(expr.getText()) : undefined
}

// ---------------------------------------------------------------------------
// Calls: Tier B provider tracing, Tier C pure-arrow calls, whitelisted
// primitive methods (§7.5's `.toFixed`/`.padStart`/… whitelist)
// ---------------------------------------------------------------------------

function evaluateCall(expr: CallExpression, scope: EvalScope, budget: Budget, depth: number): StaticValue {
  const callee = expr.getExpression()

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

/** `undefined` = not hook-shaped (let Tier C try instead); otherwise the (possibly unresolved) traced result. */
const providerTraceCache = new WeakMap<Node, StaticValue>()

function tryProviderTraceCached(fn: ArrowFunctionOrDecl, budget: Budget, depth: number): StaticValue | undefined {
  const ctxExpr = findUseContextArgument(fn)
  if (!ctxExpr) return undefined

  const cached = providerTraceCache.get(fn)
  if (cached) return cached

  const result = traceProvider(ctxExpr, fn.getProject(), budget, depth)
  providerTraceCache.set(fn, result)
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

  const providerScope: EvalScope = { sourceFile: valueExpr.getSourceFile(), locals: EMPTY_LOCALS }
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
  return valueExpr ? unwrapUseMemo(valueExpr) : undefined
}

/** `useMemo(() => ({...}), deps)` -> the returned object-literal expression. */
function unwrapUseMemo(expr: Node): Node {
  const n = unwrapParens(expr)
  if (!Node.isCallExpression(n)) return n
  const callee = n.getExpression()
  if (!Node.isIdentifier(callee) || callee.getText() !== 'useMemo') return n
  const factory = n.getArguments()[0]
  if (!factory || !(Node.isArrowFunction(factory) || Node.isFunctionExpression(factory))) return n
  const body = factory.getBody()
  return unwrapParens(body)
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

// -- Whitelisted primitive method / coercion calls (shared by Tier C bodies AND ordinary props) --

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
