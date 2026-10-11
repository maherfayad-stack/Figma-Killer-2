/**
 * textSplice — the byte-exact primitive the variant codemods are built on: an
 * edit expressed as "replace `deleteLength` characters at `offset` with
 * `insert`", computed against the ORIGINAL text.
 *
 * Several edits to one file (a union member in the component, an entry in a
 * lookup object beside it) are planned independently against the same original
 * text and applied together, highest offset first, so no edit can shift
 * another's position. Two splices that overlap are a bug in the planner, never
 * something to guess a merge for — `applyTextSplices` throws.
 *
 * Pure strings: no ts-morph, no postcss, no filesystem. Text is LF-normalised
 * by the caller (`@core/utils/lineEndings`), which restores the file's own
 * ending on write.
 */

export interface TextSplice {
  /** Start of the replaced range in the original text. */
  offset: number
  /** How many original characters go (0 for a pure insertion). */
  deleteLength: number
  /** What goes in their place. */
  insert: string
}

/** Applies every splice to `text`; throws if two overlap or one lies outside the text. */
export function applyTextSplices(text: string, splices: readonly TextSplice[]): string {
  const ordered = [...splices].sort((a, b) => b.offset - a.offset || b.deleteLength - a.deleteLength)
  let next = text
  let previousStart = Number.POSITIVE_INFINITY
  for (const splice of ordered) {
    const end = splice.offset + splice.deleteLength
    if (splice.offset < 0 || end > text.length) throw new Error('[textSplice] a splice lies outside the text it was planned against')
    if (end > previousStart) throw new Error('[textSplice] two splices overlap')
    next = next.slice(0, splice.offset) + splice.insert + next.slice(end)
    previousStart = splice.offset
  }
  return next
}

/** 0-based character offset of a 1-based line and column, or `null` when the position is outside the text. Lines end at `\n`. */
export function offsetOfLineColumn(text: string, line: number, column: number): number | null {
  if (line < 1 || column < 1) return null
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return null
    offset = next + 1
  }
  const target = offset + column - 1
  return target <= text.length ? target : null
}

/** The whitespace at the start of the line `offset` sits on. */
export function indentOfLineAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart))
  return match ? match[0] : ''
}
