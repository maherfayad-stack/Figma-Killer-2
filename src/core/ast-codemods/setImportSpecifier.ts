/**
 * Replaces an IMPORT DECLARATION's module-specifier string literal at an
 * exact (line, col), preserving quote style, then writes the change back to
 * disk. `setStringLiteral`'s narrower sibling, scoped to one literal SHAPE:
 * the module specifier of an `import x from '<specifier>'`.
 *
 * This is the one honest writeback target for `<img src={heroImg}/>` where
 * `heroImg` is a default import (WS-8.3, `docs/features/studio-import.md`):
 * the JSX itself cannot be the target — replacing `src={heroImg}` with a
 * baked path would delete the binding — but the import statement one hop
 * away is an ordinary string literal at a known position, and rewriting it
 * IS what "pick a different image" honestly means. `ParsedNode.assetOrigin`
 * (`src/core/page-parser/types.ts`) names exactly this literal's (line, col).
 *
 * FAILS CLOSED, same policy as `setStringLiteral`: the token at the position
 * must be a string literal, AND it must be the direct module specifier of an
 * `ImportDeclaration` — never re-purposed to rewrite an arbitrary literal
 * that merely happens to sit at that position. `assetOrigin` should only ever
 * point at one, but this is the belt-and-braces check that keeps a bug
 * elsewhere in the pipeline from turning into a write to the wrong string.
 */
import { Node, Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'

export interface SetImportSpecifierParams {
  file: string
  /** 1-based line of the specifier literal's opening quote. */
  line: number
  /** 1-based column of the specifier literal's opening quote. */
  col: number
  /** The new module specifier, e.g. `./assets/hero-2.png`. */
  specifier: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Thrown when the token at the target location is not a rewritable import
 * module specifier. `path` is `<file>:<line>:<col>`.
 */
export class ImportSpecifierTargetError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setImportSpecifier] ${path}: ${message}`)
    this.name = 'ImportSpecifierTargetError'
    this.path = path
  }
}

export function setImportSpecifier(params: SetImportSpecifierParams): void {
  const { file, line, col, specifier } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const path = `${file}:${line}:${col}`

  let pos: number
  try {
    pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1)
  } catch {
    throw new ImportSpecifierTargetError('line/column is outside the file', path)
  }

  const token = sourceFile.getDescendantAtPos(pos)
  if (!token) throw new ImportSpecifierTargetError('no node at this position', path)

  // The position addresses the literal's own start. Accept the token itself or
  // its immediate parent (`getDescendantAtPos` can land on the token inside a
  // literal node depending on trivia), but never search wider than that — a
  // broader walk is how a write lands on the wrong string. Unlike
  // `setStringLiteral`, a no-substitution template literal is NOT accepted
  // here: `import x from \`./x.png\`` is not a shape any real import uses, and
  // narrowing to the actual JS grammar for a module specifier keeps the check
  // honest rather than permissive-by-accident.
  const literal = [token, token.getParent()].find(
    (candidate): candidate is Node =>
      candidate !== undefined && candidate.getStart() === pos && Node.isStringLiteral(candidate),
  )
  if (!literal) {
    throw new ImportSpecifierTargetError(
      `expected a string literal at this position, found ${token.getKindName()}`,
      path,
    )
  }

  const parent = literal.getParent()
  if (!parent || !Node.isImportDeclaration(parent) || parent.getModuleSpecifier() !== literal) {
    throw new ImportSpecifierTargetError(
      "the string literal at this position is not an import declaration's module specifier",
      path,
    )
  }

  // `JSON.stringify` for the escaping, then normalise to the quote style
  // already in the file — same technique as `setStringLiteral`, so a picker
  // edit does not show up as a quote-style diff on every import it touches.
  const usesSingleQuotes = literal.getText().startsWith("'")
  const doubleQuoted = JSON.stringify(specifier)
  const replacement = usesSingleQuotes
    ? `'${doubleQuoted.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
    : doubleQuoted

  literal.replaceWithText(replacement)
  sourceFile.saveSync()
}
