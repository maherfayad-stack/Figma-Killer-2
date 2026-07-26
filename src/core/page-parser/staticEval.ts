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
import { evaluateCall } from './staticEvalCalls'
import { createBudget, createEvalScope as createEvalScopeCore, createPageEvalBudget, evaluateNode } from './staticEvalCore'
import type { EvalScope, StaticEvalOptions, StaticValue } from './staticEvalCore'
import type { FunctionLike } from './types'

export type { ArrowFunctionOrDecl, EvalScope, LocalBinding, PageEvalBudget, StaticEvalOptions, StaticValue } from './staticEvalCore'
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
