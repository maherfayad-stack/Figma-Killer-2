/**
 * staticEval — §7's bounded static evaluator: resolves a JSX expression
 * (`{t.homepage.greeting}`, `{PRODUCT_CARDS}`, `` {`${pct}%`} ``, …) to a
 * concrete value by reading the AST, never by running the source as React.
 * No hook is ever executed; no component is ever rendered. This is a partial
 * evaluator for a small, explicit set of patterns — NOT a JavaScript
 * interpreter. See the plan's §7.1 tier table and §10 risk register: this is
 * the single highest-risk area for scope creep, so every capability is
 * deliberately bounded to what a named tier asks for.
 *
 * Tier boundaries (do not blur these when extending):
 *   A — module-scope/cross-file `const` object/array + member chain, a
 *       component-body local alias, a computed member with a resolvable key,
 *       a template literal with resolvable parts, an array index.
 *       Lives in `./staticEvalCore`.
 *   B — a destructured hook return, traced to its context provider's static
 *       `value` (AST tracing, not React semantics); a dictionary indexed by a
 *       non-static key, resolved by picking a preferred/first key + a note.
 *   C — calling a resolvable pure arrow/function, inside the explicit
 *       envelope `staticEvalCalls.ts`'s `qualifiesForTierC` enforces.
 *       B and C live in `./staticEvalCalls`.
 *   D (loop expansion, conditional-branch selection, hook state, effects,
 *      async) is BANNED — never implement it anywhere in this module.
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
 * RESOLVED in-memory value, not the source file. A context's provider-tracing
 * result (the expensive part — scanning every file in the workspace for
 * `<X.Provider>`) is memoized the same way, keyed by the hook's own function
 * declaration node.
 *
 * This file is a THIN composer split for the module-size-budget ceiling and
 * an acyclic import graph: `./staticEvalCore` owns Tier A + the recursive
 * dispatcher (`evaluateNode`) and never imports Tier B/C; `./staticEvalCalls`
 * owns Tier B/C and imports FROM Core only. This file is the only one that
 * imports both, wiring Core's `Budget.callEvaluator` seam to Calls'
 * `evaluateCall` — see `staticEvalCore.ts`'s doc comment for why that
 * indirection exists instead of a direct import cycle.
 */
import type { Node, SourceFile } from 'ts-morph'
import { findDefaultLiteralNode } from './defaultLiteralBindings'
import { evaluateCall } from './staticEvalCalls'
import {
  createBudget,
  createEvalScope as createEvalScopeCore,
  createPageEvalBudget,
  evaluateCondition,
  evaluateNode,
} from './staticEvalCore'
import type { EvalScope, StaticEvalOptions, StaticValue } from './staticEvalCore'
import type { FunctionLike } from './types'

export type { ArrowFunctionOrDecl, EvalScope, LocalBinding, PageEvalBudget, StaticEvalOptions, StaticValue, ValueOrigin } from './staticEvalCore'
export { createPageEvalBudget }

/** See `staticEvalCore.ts`'s `createEvalScope` — re-exported so every consumer imports one thing from `./staticEval`. */
export function createEvalScope(sourceFile: SourceFile, componentFn?: FunctionLike): EvalScope {
  return createEvalScopeCore(sourceFile, componentFn)
}

/**
 * Resolves `expr` to a static value, or reports why it can't. Pure (does not
 * mutate `expr`/`scope`); memoized internally for module-scope consts and
 * provider tracing — see this module's doc comment. NEVER throws.
 */
export function evaluateExpression(expr: Node, scope: EvalScope, opts: StaticEvalOptions = {}): StaticValue {
  const budget = createBudget(opts, evaluateCall)
  try {
    return evaluateNode(expr, scope, budget, 0)
  } catch (err) {
    console.error('[staticEval]', err)
    return { kind: 'unresolved', reason: 'internal evaluator error' }
  }
}

/**
 * Whether `expr` is statically TRUTHY, or `undefined` when that is not
 * decidable from source alone. The question `selectJsxBranch`
 * (`./branchSelection`) asks for a ternary, `&&` and `||`.
 *
 * Two passes, because JS truthiness is two different problems:
 *   1. `evaluateCondition`'s narrow structural contract — `&&`/`||`/`!`, the
 *      six comparisons, a bare boolean. This is what answers
 *      `step === 'intro'` and `!items.length`.
 *   2. When that declines, the ordinary evaluator, COERCED. `evaluateCondition`
 *      deliberately refuses to coerce (`{name}` in text position must resolve
 *      to `"Ada"`, never to `true`), but the branch question genuinely is
 *      `Boolean(value)`: `{NAME || <Anon/>}` with `const NAME = ""` renders
 *      `<Anon/>`, and a guard like `{name && <Badge/>}` on a resolved,
 *      non-empty string really does always paint. Without this pass every
 *      `||` guard is undecidable, since a `||`'s left operand is by nature a
 *      VALUE rather than a comparison. A `fn` binding is truthy.
 *   3. Failing both, parser-07's default-literal read
 *      (`./defaultLiteralBindings`), so `useState(false)`/`useState('')`
 *      resolve on first paint.
 *
 * This is a DELIBERATE, narrow exception to `evaluateCondition`'s own warning
 * against ever using it to pick a JSX branch: that warning is about GUESSING
 * (hook state, a runtime prop) misrepresenting a stateful screen as one fixed
 * state. Nothing is guessed here — anything this resolves is fully determined
 * by source text, which is a real answer, and it OUTRANKS the positional
 * heuristic `selectJsxBranch` falls back to when this returns `undefined`.
 */
export function evaluateStaticTruthiness(expr: Node, scope: EvalScope, opts: StaticEvalOptions = {}): boolean | undefined {
  const budget = createBudget(opts, evaluateCall)
  let structural: boolean | undefined
  try {
    structural = evaluateCondition(expr, scope, budget, 0)
  } catch (err) {
    console.error('[staticEval]', err)
    return undefined
  }
  if (structural !== undefined) return structural
  return coerce(expr, scope, opts, (value) => Boolean(value))
}

/**
 * Whether `expr` is statically `null`/`undefined`, or `undefined` when that is
 * not decidable from source alone. The `??` counterpart to
 * `evaluateStaticTruthiness` — and it exists precisely BECAUSE it is not the
 * same question: `??` falls through to its right operand only on nullishness,
 * so `0`, `''` and `false` all keep the LEFT side, where `||` would discard
 * them. Answering `{x ?? <Fallback/>}` with a truthiness test would hide the
 * left value and render the fallback for every falsy-but-present value.
 *
 * There is no structural pass here: `evaluateCondition` answers a truthiness
 * question, and coercing its `false` to "nullish" is exactly the bug this
 * function exists to avoid.
 */
export function evaluateStaticNullish(expr: Node, scope: EvalScope, opts: StaticEvalOptions = {}): boolean | undefined {
  return coerce(expr, scope, opts, (value) => value === null || value === undefined)
}

/**
 * Resolves `expr` to a value and answers `test` about it, falling back to
 * parser-07's default-literal read when the ordinary binding chain bottoms out
 * on an unresolvable identifier — so `const [error] = useState(null)` guarding
 * `{error ?? <Placeholder/>}` still resolves to what first paint shows. A `fn`
 * value is a real, non-null, truthy binding. Anything still unresolved is
 * `undefined`, and `selectJsxBranch` falls back to its stated heuristic.
 */
function coerce(
  expr: Node,
  scope: EvalScope,
  opts: StaticEvalOptions,
  test: (value: unknown) => boolean,
): boolean | undefined {
  const direct = evaluateExpression(expr, scope, opts)
  if (direct.kind === 'literal') return test(direct.value)
  if (direct.kind === 'fn') return test({})
  const literal = findDefaultLiteralNode(expr)
  if (!literal) return undefined
  const viaDefault = evaluateExpression(literal, scope, opts)
  return viaDefault.kind === 'literal' ? test(viaDefault.value) : undefined
}
