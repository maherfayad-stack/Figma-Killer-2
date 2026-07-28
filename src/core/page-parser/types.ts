/**
 * Neutral, flat element/instance tree produced by `parsePageFile`.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * a location is 1-based line, 1-based column of the JSX element's tag-name
 * identifier start — the character immediately after `<`.
 */
import type { ValueOrigin } from './staticEvalTypes'
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

/**
 * A value a prop can hold. Scalars are the whole story for an HTML element —
 * an attribute is a string — but a COMPONENT prop is routinely an array of
 * objects (`<ActionSheet actions={[{ label }, { label }]}/>`), and dropping
 * those left real design-system components rendering their title and nothing
 * else. See `extractProps` for why only component props are captured
 * structurally.
 *
 * JSON-shaped on purpose: this crosses HTTP to the editor as `PageNode.props`.
 * A function-valued entry (`onClick`) has no JSON form and is dropped, not
 * stubbed — see `staticValueToPropValue`.
 */
export type ParsedPropValue =
  | string
  | number
  | boolean
  | readonly ParsedPropValue[]
  | { readonly [key: string]: ParsedPropValue }

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
  /**
   * Literal attributes, plus whatever §7's evaluator resolved. Scalars for
   * every element; a COMPONENT may also carry an array/object value — see
   * `ParsedPropValue`. An expression that does not resolve is skipped.
   */
  props: Record<string, ParsedPropValue>
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
   * `locked`/`lockReason` above. `textOrigin` below is the one exception, and
   * it works by writing somewhere else entirely.
   */
  resolution?: { source: string; note?: string }
  /**
   * Where this node's TEXT literally lives, when its text was resolved from an
   * expression and that expression bottomed out in a single string literal
   * inside the workspace: `{c.hotelsTag}` -> `hotelsTag: 'Exclusive rates on
   * hotels'` in `src/i18n/translations.js`.
   *
   * This is what makes resolved copy editable. The JSX is NOT a writeback
   * target — replacing `{c.hotelsTag}` with a string would destroy the i18n
   * binding — but the literal it reads is an ordinary string in a source file,
   * and rewriting it in place is exactly what a person editing that copy means.
   *
   * Deliberately scoped to TEXT rather than hung off `resolution`. A node can
   * resolve several values (text, `className`, an aria label) and `resolution`
   * keeps only the first, so an origin there could point at the literal behind a
   * DIFFERENT prop than the one being edited — and a writeback aimed at the
   * wrong string is worse than no writeback at all.
   *
   * Absent when the text is computed rather than passed through (a template
   * literal, a concatenation, a function's return value): there is no single
   * literal to rewrite. See `ValueOrigin`.
   */
  textOrigin?: ValueOrigin
  /**
   * Set on every node produced by inlining a local component (§2), naming the
   * component it came from (`'SheetHeader'`). Provenance, NOT a lock: the node
   * is editable, and its writeback target is that component's own source
   * location — the tail of the composite id (see `studioEditLocation`).
   *
   * It exists because that file backs EVERY instance of the component, so one
   * edit changes all of them. The editor shows a warning carrying this name
   * and the instance count before the user commits. Nested inlining keeps the
   * INNERMOST component's name — that is the file an edit actually writes to.
   */
  fromComponent?: string
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
