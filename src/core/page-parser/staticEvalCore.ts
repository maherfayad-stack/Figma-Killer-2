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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'
import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type ArrowFunction,
  type CallExpression,
  type ElementAccessExpression,
  type FunctionDeclaration,
  type ObjectLiteralExpression,
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
  // CallExpression is NOT handled inline — see this module's doc comment.
  if (Node.isCallExpression(expr)) return budget.callEvaluator(expr, scope, budget, depth)
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
      const rawText = resolveRawTextImport(scope.sourceFile, name, budget)
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

/** Vite's `?raw` text-inlining suffix, e.g. `'./check-line.svg?raw'`. */
const RAW_TEXT_SPECIFIER_RE = /\.(svg|txt|html?|md|csv)\?raw$/i

/** Guards against inlining a huge file into every expression that references it. */
const MAX_RAW_TEXT_BYTES = 512 * 1024

/**
 * A specifier that names a file inside an installed package
 * (`@alm-design/design-system/src/icons/line-icons/headset.svg?raw`) rather than
 * a path relative to the importing file. Absolute specifiers are excluded here
 * and rejected outright — nothing legitimate imports `/etc/passwd?raw`.
 */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\\')
}

/**
 * Node's own algorithm, narrowed to one file: walk up from the importing file
 * looking for `<dir>/node_modules/<specifier>`, stopping at the workspace root.
 *
 * A design system ships its icons as files inside its package, so an app that
 * imports 23 of them (`.../icons/line-icons/headset.svg?raw`) had every one
 * resolve to nothing before this. Hardcoding a path to this repo's own copy was
 * the alternative and would have been a workspace-specific hack; walking
 * `node_modules` is the general, correct rule — it just needs the package to
 * actually be installed.
 */
function resolveInNodeModules(fromDir: string, specifier: string, resolvedRoot: string): string | undefined {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', specifier)
    if (existsSync(candidate)) return candidate
    if (dir === resolvedRoot) return undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * `import icon from './x.svg?raw'` -> the file's contents.
 *
 * Vite's `?raw` suffix inlines a file's text as the default export, and it is
 * how real repos ship inline icons: a `?raw` SVG handed to
 * `dangerouslySetInnerHTML`, often via a `<Icon svg={...} />` prop. Resolving
 * it here rather than in the parser means one mechanism covers every path the
 * value can travel — read directly, passed as a prop and substituted into a
 * component, or aliased through a local const.
 *
 * Relative specifiers and installed-package specifiers, only inside
 * `budget.workspaceRoot`, only regular files under `MAX_RAW_TEXT_BYTES`. Without
 * a configured root this returns `undefined` rather than reading anything: a
 * specifier can climb out of the workspace, and the evaluator must never
 * manufacture an escaping path.
 *
 * CONTAINMENT IS CHECKED ON THE REAL PATH, after following symlinks. A workspace
 * can arrive from `/import-github`, and git stores symlinks — so a
 * `node_modules` entry is untrusted input, and a textual containment check would
 * happily read `~/.ssh/id_rsa` through a link that merely *looks* like it sits
 * under the workspace. The cost is that a linked `file:../pkg` dependency does
 * not resolve; installing the package (a real directory) does.
 */
function resolveRawTextImport(sourceFile: SourceFile, localName: string, budget: Budget): string | undefined {
  const root = budget.workspaceRoot
  if (!root) return undefined
  const resolvedRoot = path.resolve(root)
  // The root itself is routinely reached through a symlink (`/var` -> `/private/var`
  // on macOS, a linked checkout), so containment has to compare real path to real
  // path or every read under it looks like an escape.
  let realRoot: string
  try {
    realRoot = realpathSync(resolvedRoot)
  } catch {
    return undefined
  }

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() !== localName) continue
    const specifier = decl.getModuleSpecifierValue()
    if (!RAW_TEXT_SPECIFIER_RE.test(specifier)) return undefined
    const filePath = specifier.split('?')[0]!

    const fromDir = path.dirname(sourceFile.getFilePath())
    const absolute = isBareSpecifier(specifier)
      ? resolveInNodeModules(fromDir, filePath, resolvedRoot)
      : specifier.startsWith('.')
        ? path.resolve(fromDir, filePath)
        : undefined // absolute specifier — never read
    if (absolute === undefined) return undefined

    try {
      const real = realpathSync(absolute)
      const relFromRoot = path.relative(realRoot, real)
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return undefined
      const stats = statSync(real)
      if (!stats.isFile() || stats.size > MAX_RAW_TEXT_BYTES) return undefined
      return readFileSync(real, 'utf8').trim()
    } catch {
      return undefined // Missing/unreadable asset — unresolved, never a throw.
    }
  }
  return undefined
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
