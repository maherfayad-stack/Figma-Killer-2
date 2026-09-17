/**
 * The line-ending contract every text-in/text-out CSS codemod in this folder
 * honours.
 *
 * Studio edits other people's stylesheets, and a repository cloned on Windows
 * with Git's default `core.autocrlf=true` has a CRLF working tree. postcss
 * keeps the `\r\n` in the `raws` of nodes it did not touch, but every string
 * this folder builds — `raws.before = '\n\n'`, the literal fragments in
 * `buildRule`/`buildStep`/`buildRuleWithDeclarations` — is authored with
 * `'\n'`. Left alone, a single declaration edit turns a clean CRLF file into a
 * mixed one, and `git diff` shows the user lines they never touched.
 *
 * So: parse LF-only, and put the file's own ending back on the result. A
 * uniformly-CRLF stylesheet round-trips byte-for-byte; a uniformly-LF one is
 * untouched; a MIXED one is normalised to its dominant ending, which is a
 * documented repair rather than a promise we cannot keep (see
 * `@core/utils/lineEndings`).
 *
 * The no-op case is special and deliberate: when a codemod decides nothing
 * changed, the caller gets its OWN bytes back, not a re-serialised copy. A
 * re-sent edit on a later autosave tick must not rewrite a file at all — not
 * even its line endings.
 */
import { applyLineEnding, detectLineEnding, toLf } from '@core/utils/lineEndings'

/** The shape every write-side codemod in this folder returns. */
export interface CssRewrite {
  /** The rewritten stylesheet text — identical to the input when `changed` is `false`. */
  css: string
  /** `false` when the edit was a pure no-op. */
  changed: boolean
}

/** Run `rewrite` against LF-normalised text and restore `cssText`'s own line ending. */
export function preservingLineEndings(cssText: string, rewrite: (source: string) => CssRewrite): CssRewrite {
  const eol = detectLineEnding(cssText)
  const result = rewrite(toLf(cssText))
  return result.changed ? { css: applyLineEnding(result.css, eol), changed: true } : { css: cssText, changed: false }
}
