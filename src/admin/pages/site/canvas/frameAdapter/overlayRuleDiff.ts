/**
 * overlayRuleDiff — applies a stylesheet text to a live `CSSStyleSheet` as a
 * rule-level diff instead of rewriting the `<style>` element's text (SB-7).
 *
 * ## Why
 *
 * Setting a `<style>` element's `textContent` makes the browser discard the
 * sheet and parse a new one. Style invalidation then compares two WHOLE rule
 * sets, so one edited class restyles every element either sheet could match —
 * in every mounted frame. `insertRule` / `deleteRule` change one rule: the
 * browser invalidates only the elements THAT rule matches, and a frame whose
 * page does not use the class pays for the string compare and nothing else.
 *
 * ## What it does
 *
 * The text is cut into top-level chunks (one rule or at-rule statement each,
 * by {@link splitCssChunks}). The previous and the new chunk lists are aligned
 * (common prefix and suffix, then a longest-common-subsequence on the middle),
 * and the difference is applied left to right with one running rule index:
 * identical chunks are skipped, a changed chunk is a `deleteRule` plus an
 * `insertRule`, and a grouping block (`@layer`, `@media`, `@supports`,
 * `@container`) whose header is unchanged is diffed INSIDE — so the single
 * `@layer user-authored { … }` wrapper the class injector emits does not turn
 * every edit into a whole-sheet replacement.
 *
 * ## Contract
 *
 * - The patcher owns the sheet: it assumes nothing else inserts or deletes
 *   rules in it. If the sheet and its bookkeeping ever disagree it throws
 *   {@link OverlayPatchError} and the caller rebuilds from text.
 * - A chunk the parser rejects (`SyntaxError`) is dropped, exactly as a
 *   `<style>` parse would drop it; it keeps its place in the bookkeeping so a
 *   later identical chunk is still skipped.
 * - There is no `<style>` text. The sheet's rules are the only copy.
 *
 * Pure of DOM types beyond the `insertRule`/`deleteRule`/`cssRules` surface of
 * {@link RuleContainer}, so it is unit-testable without a style engine.
 */

/** The slice of `CSSStyleSheet` / `CSSGroupingRule` the patcher drives. */
export interface RuleContainer {
  readonly cssRules: ArrayLike<unknown>
  insertRule(rule: string, index?: number): number
  deleteRule(index: number): void
}

/** The sheet and the patcher's bookkeeping disagree, or the browser refused a rule for a reason other than syntax. */
export class OverlayPatchError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'OverlayPatchError'
  }
}

/** Block at-rules whose rules are themselves diffed. Style rules are replaced whole. */
const GROUPING_AT_RULE = /^@(?:layer|media|supports|container)\b/i

/** Cuts stylesheet text into top-level rules and at-rule statements, comments and whitespace between them dropped. */
export function splitCssChunks(css: string): string[] {
  const chunks: string[] = []
  const length = css.length
  let i = 0
  while (i < length) {
    i = skipTrivia(css, i)
    if (i >= length) break
    const start = i
    let depth = 0
    let parens = 0
    while (i < length) {
      const ch = css[i]
      if (ch === '/' && css[i + 1] === '*') {
        i = skipComment(css, i)
        continue
      }
      if (ch === '"' || ch === "'") {
        i = skipString(css, i)
        continue
      }
      if (ch === '\\') {
        i += 2
        continue
      }
      i += 1
      if (ch === '(') parens += 1
      else if (ch === ')') parens = Math.max(0, parens - 1)
      else if (parens === 0) {
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth = Math.max(0, depth - 1)
          if (depth === 0) break
        } else if (ch === ';' && depth === 0) break
      }
    }
    const chunk = css.slice(start, i).trim()
    if (chunk) chunks.push(chunk)
  }
  return chunks
}

function skipComment(css: string, at: number): number {
  const end = css.indexOf('*/', at + 2)
  return end === -1 ? css.length : end + 2
}

function skipString(css: string, at: number): number {
  const quote = css[at]
  let i = at + 1
  while (i < css.length) {
    const ch = css[i]
    if (ch === '\\') i += 2
    else if (ch === quote) return i + 1
    else if (ch === '\n') return i
    else i += 1
  }
  return css.length
}

function skipTrivia(css: string, from: number): number {
  let i = from
  while (i < css.length) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') i = skipComment(css, i)
    else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f') i += 1
    else break
  }
  return i
}

interface BlockParts {
  header: string
  body: string
}

/** A grouping at-rule block split into its header and the text between its braces; `null` for anything else. */
function groupingBlock(chunk: string): BlockParts | null {
  if (!GROUPING_AT_RULE.test(chunk) || !chunk.endsWith('}')) return null
  let parens = 0
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i]
    if (ch === '/' && chunk[i + 1] === '*') {
      i = skipComment(chunk, i) - 1
    } else if (ch === '"' || ch === "'") {
      i = skipString(chunk, i) - 1
    } else if (ch === '\\') {
      i += 1
    } else if (ch === '(') {
      parens += 1
    } else if (ch === ')') {
      parens = Math.max(0, parens - 1)
    } else if (ch === '{' && parens === 0) {
      return { header: chunk.slice(0, i).trim(), body: chunk.slice(i + 1, chunk.length - 1) }
    }
  }
  return null
}

/** One top-level chunk of the sheet as the patcher last left it. */
interface Entry {
  text: string
  /** The rule the browser made of it; `null` when it rejected the chunk. */
  rule: object | null
  header: string | null
  /** Entries of a grouping block's own rules; `null` for every other chunk. */
  children: Entry[] | null
}

/** What one {@link OverlayRulePatcher.apply} did, for tests and the frame-write counters. */
export interface PatchStats {
  inserted: number
  deleted: number
  /** Chunks left alone because their text was identical. */
  skipped: number
}

/**
 * Longest common subsequence of two chunk lists, as index pairs. Quadratic, so a
 * pathological middle (both lists large and unrelated) is not aligned at all and
 * the whole middle is replaced — correct, only less surgical.
 */
const MAX_ALIGN_CELLS = 250_000

function align(oldTexts: readonly string[], newTexts: readonly string[]): Array<[number, number]> {
  const rows = oldTexts.length
  const cols = newTexts.length
  if (rows === 0 || cols === 0 || rows * cols > MAX_ALIGN_CELLS) return []
  const width = cols + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let r = rows - 1; r >= 0; r -= 1) {
    for (let c = cols - 1; c >= 0; c -= 1) {
      table[r * width + c] =
        oldTexts[r] === newTexts[c]
          ? table[(r + 1) * width + c + 1]! + 1
          : Math.max(table[(r + 1) * width + c]!, table[r * width + c + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let r = 0
  let c = 0
  while (r < rows && c < cols) {
    if (oldTexts[r] === newTexts[c]) {
      pairs.push([r, c])
      r += 1
      c += 1
    } else if (table[(r + 1) * width + c]! >= table[r * width + c + 1]!) r += 1
    else c += 1
  }
  return pairs
}

/** Applies successive stylesheet texts to one live sheet as rule-level edits. */
export class OverlayRulePatcher {
  private entries: Entry[] = []
  private stats: PatchStats = { inserted: 0, deleted: 0, skipped: 0 }

  constructor(private readonly sheet: RuleContainer) {}

  /** Brings the sheet to `css`. Throws {@link OverlayPatchError} when it cannot, leaving the sheet in an unknown state. */
  apply(css: string): PatchStats {
    this.stats = { inserted: 0, deleted: 0, skipped: 0 }
    this.entries = this.patchLevel(this.sheet, this.entries, splitCssChunks(css))
    return this.stats
  }

  private patchLevel(container: RuleContainer, old: Entry[], next: readonly string[]): Entry[] {
    const result: Entry[] = []
    let cursor = 0
    const keep = (entry: Entry): void => {
      result.push(entry)
      if (entry.rule) cursor += 1
      this.stats.skipped += 1
    }

    let head = 0
    while (head < old.length && head < next.length && old[head]!.text === next[head]) {
      keep(old[head]!)
      head += 1
    }
    let oldEnd = old.length
    let nextEnd = next.length
    while (oldEnd > head && nextEnd > head && old[oldEnd - 1]!.text === next[nextEnd - 1]) {
      oldEnd -= 1
      nextEnd -= 1
    }
    const tail = old.slice(oldEnd)

    const oldMiddle = old.slice(head, oldEnd)
    const nextMiddle = next.slice(head, nextEnd)
    const pairs = align(oldMiddle.map((entry) => entry.text), nextMiddle)
    let oldAt = 0
    let nextAt = 0
    const settleGap = (oldTo: number, nextTo: number): void => {
      while (oldAt < oldTo || nextAt < nextTo) {
        const was = oldAt < oldTo ? oldMiddle[oldAt]! : null
        const text = nextAt < nextTo ? nextMiddle[nextAt]! : null
        if (was && text !== null) {
          const nested = this.patchBlock(was, text)
          if (nested) {
            result.push(nested)
            cursor += 1
          } else {
            this.remove(container, was, cursor)
            const inserted = this.insert(container, text, cursor)
            result.push(inserted)
            if (inserted.rule) cursor += 1
          }
          oldAt += 1
          nextAt += 1
        } else if (was) {
          this.remove(container, was, cursor)
          oldAt += 1
        } else if (text !== null) {
          const inserted = this.insert(container, text, cursor)
          result.push(inserted)
          if (inserted.rule) cursor += 1
          nextAt += 1
        }
      }
    }
    for (const [oldIndex, nextIndex] of pairs) {
      settleGap(oldIndex, nextIndex)
      keep(oldMiddle[oldIndex]!)
      oldAt += 1
      nextAt += 1
    }
    settleGap(oldMiddle.length, nextMiddle.length)

    for (const entry of tail) keep(entry)
    if (container.cssRules.length !== cursor) {
      throw new OverlayPatchError(`the sheet holds ${container.cssRules.length} rules; the patcher accounted for ${cursor}`)
    }
    return result
  }

  /** A grouping block whose header is unchanged is diffed inside; `null` when `was`/`text` are not such a pair. */
  private patchBlock(was: Entry, text: string): Entry | null {
    if (!was.rule || !was.children || was.header === null) return null
    const parts = groupingBlock(text)
    if (!parts || parts.header !== was.header) return null
    const children = this.patchLevel(was.rule as RuleContainer, was.children, splitCssChunks(parts.body))
    return { text, rule: was.rule, header: was.header, children }
  }

  private remove(container: RuleContainer, entry: Entry, cursor: number): void {
    if (!entry.rule) return
    if (container.cssRules[cursor] !== entry.rule) throw new OverlayPatchError(`rule ${cursor} is not the rule this patcher inserted`)
    container.deleteRule(cursor)
    this.stats.deleted += 1
  }

  private insert(container: RuleContainer, text: string, cursor: number): Entry {
    const parts = groupingBlock(text)
    try {
      // A grouping block goes in as an empty shell and is filled rule by rule,
      // so its children are tracked one-to-one with the browser's own rules.
      container.insertRule(parts ? `${parts.header} {}` : text, cursor)
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'SyntaxError') return { text, rule: null, header: null, children: null }
      throw new OverlayPatchError(`the browser refused a rule: ${text.slice(0, 80)}`, { cause: err })
    }
    this.stats.inserted += 1
    const rule = container.cssRules[cursor] as Entry['rule']
    if (!parts) return { text, rule, header: null, children: null }
    const children = this.patchLevel(rule as RuleContainer, [], splitCssChunks(parts.body))
    return { text, rule, header: parts.header, children }
  }
}
