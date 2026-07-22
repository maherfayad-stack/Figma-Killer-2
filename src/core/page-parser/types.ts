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
  /** Child node ids, in source order. */
  children: string[]
  loc: NodeLoc
  /** true = rendered but not structurally/prop editable (dynamic surface). */
  locked: boolean
  lockReason?: string
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
