/**
 * Neutral, flat element/instance tree produced by `parsePageFile`.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * a location is 1-based line, 1-based column of the JSX element's tag-name
 * identifier start — the character immediately after `<`.
 */
import type { ArrowFunction, FunctionDeclaration, FunctionExpression } from 'ts-morph'

/**
 * A component's own function node — a `function Foo() {}` declaration, an
 * arrow (`const Foo = () => {}`), or a function expression assigned to a
 * `const`. Lives here (not in `parsePageFile.ts`) so `staticEval.ts` can
 * depend on the type without importing the parser module itself — the parser
 * imports the evaluator's runtime exports, so a reverse type-only edge back
 * from parsePageFile would be a needless cycle risk. `parsePageFile.ts`
 * re-exports this for its existing consumers (`inlineLocalComponents.ts`, the
 * barrel).
 */
export type FunctionLike = ArrowFunction | FunctionDeclaration | FunctionExpression

export interface NodeLoc {
  /** appDir-relative POSIX path. */
  file: string
  line: number
  col: number
}

export interface ParsedNode {
  /** `${relFilePosix}:${line}:${col}` — deterministic. */
  id: string
  /** lowercase tag name = 'element'; Capitalized = 'component'. */
  kind: 'element' | 'component'
  /** Tag name / component identifier, e.g. "div" or "Button". */
  name: string
  /** Literal attributes only — non-literal expression props are skipped. */
  props: Record<string, string | number | boolean>
  /**
   * The element's `style={{ … }}` object-literal attribute, flattened to its
   * literal (string/number) entries so the canvas can render the real
   * inline styles authored in source. Non-literal values (identifiers, calls,
   * spreads) inside the object are skipped. Absent when the element has no
   * `style` attribute or none of its entries are literals.
   */
  inlineStyles?: Record<string, string | number>
  /** Child node ids, in source order. */
  children: string[]
  loc: NodeLoc
  /** true = rendered but not structurally/prop editable (dynamic surface). */
  locked: boolean
  lockReason?: string
  /**
   * The element's text content, captured ONLY when its meaningful children
   * are exactly one non-whitespace `JsxText` node or one string-literal
   * expression container (`{"..."}` / `{'...'}`) — the same "text-only leaf"
   * shape `../ast-codemods/setJsxText` is willing to overwrite. Elements with
   * element children, more than one meaningful child, or a non-literal
   * expression child get no `text` (their `children` are still walked
   * structurally as before). Absent for locked/dynamic-surface nodes.
   * Trimmed of leading/trailing whitespace only (approximates JSX's own
   * insignificant-whitespace collapsing).
   */
  text?: string
  /**
   * Present only when a value in `props`/`inlineStyles`/`text` came from §7's
   * static evaluator resolving a non-literal expression (`{t.homepage.greeting}`,
   * a cross-file `const`, a hook's traced provider value, a dictionary index
   * with a dynamic key, a resolvable pure-arrow call, …) rather than a literal
   * already sitting in the source. `source` is the short original expression
   * text (e.g. `"t.homepage.greeting"`); `note` records a resolution choice
   * worth surfacing in the editor (e.g. picking a locale/branch for a
   * dynamically-indexed dictionary — see `staticEval.ts`'s Tier B.4).
   *
   * A node carrying `resolution` is always `locked` with a
   * `lockReason: 'value from <source>'` — writing an edited literal back over
   * `{t.homepage.greeting}` would silently destroy the original binding in
   * the user's real source file, so the value is read-only, same principle as
   * `locked`/`lockReason` above.
   */
  resolution?: { source: string; note?: string }
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
