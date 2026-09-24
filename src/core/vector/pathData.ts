/**
 * pathData — a token-preserving parse and serialise of an SVG path's `d`.
 *
 * The `d` string is the user's SOURCE. Rewriting a hand-written `M4 4h16v16H4z`
 * as `M4.000,4.000 L20.000,4.000 …` would be a destructive reformat of a line
 * the user never touched, so this parser does what Penpot's deliberately does
 * not (`parser.js` normalises everything to absolute M/L/C/Z): every segment
 * keeps its command letter, its relative/absolute case, whether the letter was
 * written at all (an implicit repeat), and the exact source text it came from.
 * `serializePathData(parsePathData(d))` is byte-identical to `d`, and an editor
 * re-emits only the segments it changed (`pathModel.ts`).
 *
 * Grammar: SVG 1.1 path data (8.3.9) — commands `MmLlHhVvCcSsQqTtAaZz`, numbers
 * `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`, comma-or-space
 * separators, arc flags that may be written without a separator
 * (`a1 1 0 01 2 2`). A path that breaks the grammar does not throw: it returns
 * `{ ok: false }` with the offset, and editing refuses rather than guessing
 * what a browser would have drawn up to the error.
 */

export type PathCommand =
  | 'M' | 'm' | 'L' | 'l' | 'H' | 'h' | 'V' | 'v' | 'C' | 'c'
  | 'S' | 's' | 'Q' | 'q' | 'T' | 't' | 'A' | 'a' | 'Z' | 'z'

export interface PathSegment {
  /**
   * The command this segment executes, in the source's case. For an implicit
   * repeat this is the command it repeats AS: a repeated `M` draws lines, so
   * `M0 0 10 10` is a `M` segment followed by an implicit `L` segment.
   */
  readonly command: PathCommand
  readonly values: readonly number[]
  /** `true` when the source wrote no letter for this segment. */
  readonly implicit: boolean
  /** Whitespace and at most one comma the source wrote before this segment. */
  readonly lead: string
  /** The segment's exact source text: `lead`, the letter (unless implicit), then its arguments. */
  readonly text: string
  /** The most decimal places any argument of this segment was written with. */
  readonly decimals: number
}

export interface PathData {
  readonly segments: readonly PathSegment[]
  /** Whatever the source wrote after the last segment (trailing whitespace). */
  readonly trailing: string
}

export type PathParseResult =
  | { readonly ok: true; readonly path: PathData }
  | { readonly ok: false; readonly error: string; readonly offset: number }

/** Arguments per command, by uppercase letter. */
export const PATH_ARGUMENT_COUNT: Readonly<Record<string, number>> = {
  M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0,
}

const COMMAND_LETTERS = new Set('MmLlHhVvCcSsQqTtAaZz')
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

/** The decimal places a number token was written with (`1.250` → 3, `1e-3` → 3). */
function tokenDecimals(token: string): number {
  let dot = -1
  let exponentAt = token.length
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i)
    if (code === 46) dot = i
    else if (code === 101 || code === 69) {
      exponentAt = i
      break
    }
  }
  const fraction = dot === -1 ? 0 : exponentAt - dot - 1
  const exponent = exponentAt === token.length ? 0 : Number(token.slice(exponentAt + 1))
  return Math.max(0, fraction - exponent)
}

/** The command an implicit argument group after `previous` repeats as. */
export function impliedRepeatCommand(previous: PathCommand): PathCommand | undefined {
  if (previous === 'M') return 'L'
  if (previous === 'm') return 'l'
  if (previous === 'Z' || previous === 'z') return undefined
  return previous
}

class Scanner {
  pos = 0
  constructor(readonly d: string) {}

  skipWhitespace(): void {
    while (isWhitespace(this.d[this.pos])) this.pos += 1
  }

  /** Whitespace, then at most one comma, then whitespace. Returns whether a comma was consumed. */
  skipSeparator(): boolean {
    this.skipWhitespace()
    if (this.d[this.pos] !== ',') return false
    this.pos += 1
    this.skipWhitespace()
    return true
  }

  number(): string | undefined {
    NUMBER.lastIndex = this.pos
    const match = NUMBER.exec(this.d)
    if (!match) return undefined
    this.pos += match[0].length
    return match[0]
  }

  flag(): string | undefined {
    const char = this.d[this.pos]
    if (char !== '0' && char !== '1') return undefined
    this.pos += 1
    return char
  }
}

function startsNumber(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 48 && code <= 57) || code === 46 || code === 43 || code === 45
}

/** Arguments per command letter, both cases. */
const ARGUMENTS_BY_LETTER: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(PATH_ARGUMENT_COUNT).flatMap(([letter, count]) => [[letter, count], [letter.toLowerCase(), count]]),
)

/** Parse `d` into segments, keeping every byte of source text. Never throws. */
export function parsePathData(d: string): PathParseResult {
  const scan = new Scanner(d)
  const segments: PathSegment[] = []
  let previous: PathCommand | undefined

  for (;;) {
    const segmentStart = scan.pos
    const hadComma = scan.skipSeparator()
    if (scan.pos >= d.length) {
      if (hadComma) return { ok: false, error: 'A path cannot end with a comma.', offset: scan.pos }
      return { ok: true, path: { segments, trailing: d.slice(segmentStart) } }
    }
    const char = d[scan.pos]!

    let command: PathCommand
    let implicit: boolean
    if (COMMAND_LETTERS.has(char)) {
      if (hadComma) return { ok: false, error: 'A comma cannot come before a command letter.', offset: scan.pos }
      command = char as PathCommand
      implicit = false
      scan.pos += 1
    } else if (startsNumber(char) && previous !== undefined) {
      const repeated = impliedRepeatCommand(previous)
      if (repeated === undefined) return { ok: false, error: 'Numbers cannot follow a close-path command.', offset: scan.pos }
      command = repeated
      implicit = true
    } else {
      return { ok: false, error: `Unexpected "${char}" in path data.`, offset: scan.pos }
    }
    if (previous === undefined && command !== 'M' && command !== 'm') {
      return { ok: false, error: 'Path data must start with a move-to (M or m).', offset: scan.pos - 1 }
    }
    const lead = d.slice(segmentStart, implicit ? scan.pos : scan.pos - 1)

    const count = ARGUMENTS_BY_LETTER[command]!
    const isArc = command === 'A' || command === 'a'
    const values: number[] = []
    let decimals = 0
    for (let index = 0; index < count; index += 1) {
      if (index === 0) {
        if (!implicit) scan.skipWhitespace()
      } else {
        scan.skipSeparator()
      }
      const isFlag = isArc && (index === 3 || index === 4)
      const token = isFlag ? scan.flag() : scan.number()
      if (token === undefined) {
        return { ok: false, error: `The ${command} command is missing an argument.`, offset: scan.pos }
      }
      values.push(Number(token))
      if (!isFlag) decimals = Math.max(decimals, tokenDecimals(token))
    }
    segments.push({ command, values, implicit, lead, text: d.slice(segmentStart, scan.pos), decimals })
    previous = command
  }
}

/** The exact source `d` a parse came from, with any re-emitted segment texts in place. */
export function serializePathData(path: PathData): string {
  let out = ''
  for (const segment of path.segments) out += segment.text
  return out + path.trailing
}
