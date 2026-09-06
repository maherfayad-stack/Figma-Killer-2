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
 *   1. Convert the 1-based (line, col) to an absolute position against the
 *      source file's own line starts, BOUNDS-CHECKED (a location past the end
 *      of the file is an ordinary "no element there any more", not a crash —
 *      see `findJsxElementAtLocation`).
 *   2. Walk every `JsxOpeningElement` and `JsxSelfClosingElement` descendant
 *      of the source file and compare `element.getTagNameNode().getStart()`
 *      against that position. `getStart()` skips leading trivia by default,
 *      so for a tag-name identifier it lands exactly on the first character
 *      of the name — i.e. the character right after `<`.
 *   3. The first element whose tag-name start matches the position is the
 *      target. If none match, the location does not point at a JSX element.
 */
import { Node, Project, SyntaxKind, type JsxOpeningElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'

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
  // A location past the end of the file (or of its line) is an ORDINARY
  // outcome, not a bug: node ids carry a `line:col` the board read earlier, and
  // an edit made after the file shrank names a position that no longer exists.
  // `ts.getPositionOfLineAndCharacter` asserts rather than returning, and a
  // codemod that throws there reaches the user as an unexplained skip instead
  // of the "no element is written there any more — reload" refusal every caller
  // already has. Bounds-checked here so all of them get the honest answer.
  const lineStarts = sourceFile.compilerNode.getLineStarts()
  if (line < 1 || line > lineStarts.length || col < 1) return undefined
  const lineStart = lineStarts[line - 1]!
  const lineEnd = line < lineStarts.length ? lineStarts[line]! : sourceFile.getFullText().length
  const pos = lineStart + col - 1
  if (pos > lineEnd) return undefined

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

/**
 * Resolves a located `JsxOpeningElement`/`JsxSelfClosingElement` to the node
 * that represents the WHOLE element — for a self-closing tag that's the tag
 * itself; for an opening tag, it's the tag's PARENT `JsxElement` (the
 * open+close pair together), never the opening tag alone. Shared by every
 * codemod that needs to treat a located element as one movable/replaceable
 * unit (`extractSubtreeToComponent.ts`, `subtreeSlotChildren.ts`,
 * `addSlotPropToComponent.ts`) — previously duplicated inline in each.
 *
 * `jsxElementWrapper ?? opening` in the open/close case is defensive, not
 * reachable in practice: a `JsxOpeningElement`'s `.getParent()` is a
 * `JsxElement` by TypeScript's own grammar (an opening tag cannot exist
 * without its element), but ts-morph's type for `.getParent()` is `Node |
 * undefined`, so this keeps the return type exact without an `as` cast.
 */
export function resolveJsxWholeElement(opening: JsxOpeningLikeElement): { root: Node; isSelfClosing: boolean } {
  const isSelfClosing = Node.isJsxSelfClosingElement(opening)
  const jsxElementWrapper = !isSelfClosing ? opening.getParent() : undefined
  const root: Node = isSelfClosing ? opening : (jsxElementWrapper ?? opening)
  return { root, isSelfClosing }
}

// Re-exported so callers/tests don't need their own `SyntaxKind` import
// just to reference JSX node kinds.
export { SyntaxKind }
