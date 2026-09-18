/**
 * Line endings — the one place Studio decides what `\r\n` means.
 *
 * WHY THIS EXISTS
 * ---------------
 * Studio edits OTHER PEOPLE'S repositories. A repository cloned on Windows
 * with Git's default `core.autocrlf=true` has a CRLF working tree, and every
 * codemod in `@core/ast-codemods` / `@core/css-codemods` used to emit `\n`
 * for the lines it rewrote or inserted. The result was a file the user never
 * asked to reformat: `git diff` showing every touched line as a change, a
 * mixed-ending file, and — on a repo with an `eol=crlf` attribute — a
 * checkout that re-dirties itself forever. "Formatting-preserving" has to
 * include line endings or it is not formatting-preserving.
 *
 * The same `\r` also silently breaks *reading*: in a JavaScript regex `.`
 * does not match `\r` (it is a line terminator) and a non-`m` `$` only
 * matches end-of-input, so `/^(#{1,6})\s+(.*)$/` matches nothing at all in a
 * CRLF document. That is not hypothetical — it emptied the vendored
 * design-system manifest once already (`STATE.md` `server-24`). Anything
 * splitting a file into lines uses {@link splitLines}, never a bare `'\n'`.
 *
 * THE MODEL
 * ---------
 * A file has ONE line ending: the dominant one. Reading normalises to `\n`
 * so that everything downstream — ts-morph node positions, postcss raws,
 * every hand-built insertion string, every `line:col` node id — sees exactly
 * one form and cannot disagree with itself. Writing re-applies the file's
 * own ending. A file that was uniformly CRLF round-trips byte-for-byte; a
 * MIXED file is normalised to whichever ending it had more of, which is a
 * deliberate, documented repair rather than a promise we cannot keep.
 *
 * This module is a pure-string leaf: no `node:fs`, no ts-morph, no postcss,
 * importable from the browser bundle and from either codemod family without
 * a cycle.
 */

/** The two line endings Studio recognises. A lone `\r` (classic Mac) is read, never written. */
export type LineEnding = '\n' | '\r\n'

export const LF: LineEnding = '\n'
export const CRLF: LineEnding = '\r\n'

/**
 * Split text into lines on any line ending — `\r\n`, `\n`, or a lone `\r`.
 *
 * Use this instead of `text.split('\n')` everywhere a file's content is read
 * line-wise. The bare split leaves a trailing `\r` on every line of a CRLF
 * file, which survives `startsWith`/`includes` checks but poisons every
 * regex anchored with `$` and every value that ends up rendered.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * The file's dominant line ending.
 *
 * Counted, not sampled: a file half-rewritten by an earlier, `\n`-only
 * codemod has both forms, and the ending to restore is the one the user's
 * own editor produced — i.e. the majority. Ties go to CRLF, because the only
 * way a tie arises in practice is a CRLF file that a tool has partly
 * converted, and restoring CRLF is the repairing direction. A file with no
 * line ending at all (empty, or a single unterminated line) reports `'\n'`:
 * there is nothing to preserve, so the neutral form wins.
 */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1
    else lf += 1
  }
  return crlf > 0 && crlf >= lf ? CRLF : LF
}

/** Normalise every line ending to `\n`. Idempotent; a lone `\r` becomes `\n` too. */
export function toLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n|\r/g, '\n') : text
}

/**
 * Re-apply `eol` to every line ending in `text`.
 *
 * Normalises first, so the result is uniform even when `text` was spliced
 * together from sources that disagreed (a subtree lifted out of a CRLF
 * component file and inserted into an LF page, say).
 */
export function applyLineEnding(text: string, eol: LineEnding): string {
  const lf = toLf(text)
  return eol === CRLF ? lf.replace(/\n/g, CRLF) : lf
}
