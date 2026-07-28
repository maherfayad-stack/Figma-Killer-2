/**
 * staticEvalTypes — the evaluator's value + scope TYPES, and nothing else.
 *
 * A pure leaf with no imports beyond ts-morph's own node types. It exists so
 * that `staticEvalCore` (the walker) and the modules it dispatches to
 * (`staticEvalOperators`, and anything added later) can share one `StaticValue`
 * without importing each other — a type-only import still reads as a cycle to
 * `madge`, and the `no-circular-dependencies` gate is right to refuse it.
 *
 * Everything here is re-exported from `staticEvalCore` and from the package
 * barrel, so no consumer needs to know this file exists.
 */
import type {
  ArrowFunction,
  FunctionDeclaration,
  Node,
  SourceFile,
} from 'ts-morph'

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

