/**
 * Replaces the STRING LITERAL at an exact (line, col) with a new value, then
 * writes the change back to disk.
 *
 * The other codemods in this folder target JSX — they take the location of an
 * element and rewrite an attribute or its text children. This one targets a
 * plain literal anywhere in a source file, because that is where a lot of an
 * imported app's copy actually lives:
 *
 *     // src/i18n/translations.js
 *     hotelsTag: 'Exclusive rates on hotels',
 *
 * rendered by `<span>{c.hotelsTag}</span>` two files away. The JSX is NOT the
 * writeback target — replacing `{c.hotelsTag}` with a string would delete the
 * i18n binding — but this literal is, and rewriting it in place is exactly what
 * a person editing that copy means. See `ParsedNode.textOrigin`, which is where
 * the (line, col) comes from.
 *
 * FAILS CLOSED. The token at the location must actually be a string literal (or
 * a no-substitution template literal). Anything else — a number, an identifier, a
 * template with `${}` in it, or nothing at that position at all — throws rather
 * than guessing, because a mis-aimed write here corrupts a file the editor never
 * showed the user.
 */
import { Node, Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'

export interface SetStringLiteralParams {
  file: string
  /** 1-based line of the literal's opening quote. */
  line: number
  /** 1-based column of the literal's opening quote. */
  col: number
  value: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Thrown when the token at the target location is not a rewritable string
 * literal. `path` is `<file>:<line>:<col>`.
 */
export class StringLiteralTargetError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setStringLiteral] ${path}: ${message}`)
    this.name = 'StringLiteralTargetError'
    this.path = path
  }
}

export function setStringLiteral(params: SetStringLiteralParams): void {
  const { file, line, col, value } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const path = `${file}:${line}:${col}`

  let pos: number
  try {
    pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1)
  } catch {
    throw new StringLiteralTargetError('line/column is outside the file', path)
  }

  const token = sourceFile.getDescendantAtPos(pos)
  if (!token) throw new StringLiteralTargetError('no node at this position', path)

  // The position addresses the literal's own start. Accept the token itself or
  // its immediate parent (`getDescendantAtPos` can land on the token inside a
  // literal node depending on trivia), but never search wider than that — a
  // broader walk is how a write lands on the wrong string.
  const literal = [token, token.getParent()].find(
    (candidate): candidate is Node =>
      candidate !== undefined &&
      candidate.getStart() === pos &&
      (Node.isStringLiteral(candidate) || Node.isNoSubstitutionTemplateLiteral(candidate)),
  )
  if (!literal) {
    throw new StringLiteralTargetError(
      `expected a string literal at this position, found ${token.getKindName()}`,
      path,
    )
  }

  // `JSON.stringify` for the escaping, then normalise to the quote style already
  // in the file so a copy edit does not show up as a quote-style diff on every
  // line it touches.
  const usesSingleQuotes = literal.getText().startsWith("'")
  const doubleQuoted = JSON.stringify(value)
  const replacement = usesSingleQuotes
    ? `'${doubleQuoted.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
    : doubleQuoted

  literal.replaceWithText(replacement)
  sourceFile.saveSync()
}
