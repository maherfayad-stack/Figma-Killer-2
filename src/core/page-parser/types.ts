/**
 * Neutral, flat element/instance tree produced by `parsePageFile`.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * a location is 1-based line, 1-based column of the JSX element's tag-name
 * identifier start — the character immediately after `<`.
 */

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
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
