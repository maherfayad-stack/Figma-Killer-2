/**
 * Shared location-resolution logic for `setJsxProp` / `readJsxProps`.
 *
 * LOCATION CONVENTION
 * --------------------
 * A location is a 1-based (line, col) pointing at the JSX element's tag-name
 * identifier start — i.e. the character immediately after the opening `<`.
 * This matches the coordinates produced by the peer module that maps
 * rendered canvas elements back to their JSX source.
 *
 * Resolution algorithm:
 *   1. Convert the 1-based (line, col) to a 0-based TypeScript position with
 *      `ts.getPositionOfLineAndCharacter(sourceFile.compilerNode, line - 1, col - 1)`
 *      (the TypeScript compiler API is 0-based for both line and character).
 *   2. Walk every `JsxOpeningElement` and `JsxSelfClosingElement` descendant
 *      of the source file and compare `element.getTagNameNode().getStart()`
 *      against that position. `getStart()` skips leading trivia by default,
 *      so for a tag-name identifier it lands exactly on the first character
 *      of the name — i.e. the character right after `<`.
 *   3. The first element whose tag-name start matches the position is the
 *      target. If none match, the location does not point at a JSX element.
 */
import { Node, Project, SyntaxKind, type JsxOpeningElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import * as ts from 'typescript'

export type JsxOpeningLikeElement = JsxOpeningElement | JsxSelfClosingElement

export interface JsxLocation {
  file: string
  line: number
  col: number
}

/** Opens (or reuses) a ts-morph project and loads the given file. */
export function loadSourceFile(project: Project, file: string): SourceFile {
  const existing = project.getSourceFile(file)
  if (existing) {
    // Pick up any external edits since the file was first loaded.
    existing.refreshFromFileSystemSync()
    return existing
  }
  return project.addSourceFileAtPath(file)
}

/** Creates a fresh, disk-backed ts-morph project (no in-memory fs). */
export function createProject(): Project {
  return new Project({ useInMemoryFileSystem: false })
}

/**
 * Finds the `JsxOpeningElement` / `JsxSelfClosingElement` whose tag-name
 * identifier starts at the given 1-based (line, col). Returns `undefined`
 * if no such element exists.
 */
export function findJsxElementAtLocation(
  sourceFile: SourceFile,
  line: number,
  col: number,
): JsxOpeningLikeElement | undefined {
  const pos = ts.getPositionOfLineAndCharacter(sourceFile.compilerNode, line - 1, col - 1)

  let found: JsxOpeningLikeElement | undefined
  for (const descendant of sourceFile.getDescendants()) {
    if (
      Node.isJsxOpeningElement(descendant) ||
      Node.isJsxSelfClosingElement(descendant)
    ) {
      if (descendant.getTagNameNode().getStart() === pos) {
        found = descendant
        break
      }
    }
  }
  return found
}

/** Finds the target element or throws a clear, location-specific error. */
export function findJsxElementAtLocationOrThrow(
  sourceFile: SourceFile,
  file: string,
  line: number,
  col: number,
): JsxOpeningLikeElement {
  const element = findJsxElementAtLocation(sourceFile, line, col)
  if (!element) {
    throw new Error(
      `No JSX element found at ${file}:${line}:${col} (expected the column to point at the ` +
        'character immediately after "<" in a JSX opening/self-closing tag).',
    )
  }
  return element
}

// Re-exported so callers/tests don't need their own `SyntaxKind` import
// just to reference JSX node kinds.
export { SyntaxKind }
