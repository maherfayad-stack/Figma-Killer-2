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

/**
 * Where a resolved literal PHYSICALLY lives — the string in the source file the
 * value was read out of, workspace-relative POSIX path plus 1-based line/column
 * of the literal token.
 *
 * This is what makes a resolved value editable. `{c.hotelsTag}` cannot be
 * written back at the JSX (that would replace the i18n binding with a baked
 * string), but the value it resolves to IS a plain string literal one hop away
 * in `src/i18n/translations.js`, and THAT can be rewritten in place.
 *
 * Present only when the value passed through unchanged — an identifier, a const,
 * a member chain, an array index. A COMPUTED value (a template literal, a
 * concatenation, arithmetic, a function call) has no single literal behind it and
 * carries no origin, so nothing tries to write one.
 */
export interface ValueOrigin {
  /** Workspace-relative POSIX path of the file holding the literal. */
  rel: string
  /** 1-based line of the literal token. */
  line: number
  /** 1-based column of the literal token. */
  col: number
}

export type StaticValue =
  | { kind: 'literal'; value: string | number | boolean | null; note?: string; origin?: ValueOrigin }
  /**
   * Statically known to BE `undefined` — a real answer, not a failure.
   *
   * `unresolved` means "the parser could not read this"; this means "the parser
   * read it and the source says there is nothing here". Keeping them apart is
   * what lets a branch resolve: inside an expanded `.map` row over
   * `[{ image: chip }, { icon: a }]`, `addOn.image` is a resolved image on row
   * 0 and *absent* on row 1 — and absent is exactly as decidable as present.
   * Reported as `unresolved`, the second row threw a Tier A answer away and
   * fell back to the positional heuristic, which rendered the `<img>` branch of
   * a ternary on a row that has no image.
   *
   * Only ever produced where the source genuinely determines it: a key missing
   * from a `complete` object, an index past the end of a `complete` array, and
   * the `undefined` keyword itself.
   */
  | { kind: 'undefined' }
  /**
   * `complete` — every key the source states is in `entries`, so a key that is
   * NOT in `entries` is statically `undefined`. False when a spread
   * (`{ ...base, x: 1 }`) or a computed key (`{ [k]: v }`) could contribute a
   * key this evaluator cannot name; then a missing key is merely unknown.
   * A key whose VALUE could not be read (a method, an accessor) is present in
   * `entries` as `unresolved` and does not make the object incomplete.
   */
  | { kind: 'object'; entries: Map<string, StaticValue>; complete: boolean; note?: string }
  /** `complete` — the LENGTH is what the source states (no spread element), so `.length` and an out-of-range index are decidable. */
  | { kind: 'array'; items: StaticValue[]; complete: boolean; note?: string }
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
  /**
   * WS-2.2 — `{ localClassName -> generatedGlobalClassName }`, one entry per
   * `*.module.css` file, keyed by workspace-relative POSIX path (the same
   * `rel` `resolveImportedFile` computes for `?raw`/image imports). Produced
   * by `server/handlers/studio/styleCompile.ts` and threaded straight through
   * from `StudioLoadResult` — this evaluator never compiles CSS itself, it
   * only resolves `import styles from './Card.module.css'` to the object the
   * compile step already built. Omit and a CSS Modules import stays
   * unresolved, exactly like an unconfigured `workspaceRoot`.
   */
  cssModuleClassMaps?: Readonly<Record<string, Readonly<Record<string, string>>>>
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

