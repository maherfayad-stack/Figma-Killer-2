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
import { Node, NewLineKind, Project, SyntaxKind, type JsxOpeningElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import { EolPreservingFileSystem } from '@core/page-parser'

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

/**
 * Creates a fresh, disk-backed ts-morph project (no in-memory fs).
 *
 * It reads and writes through `EolPreservingFileSystem`, so a codemod run
 * against a CRLF checkout of the user's repo sees LF-only text — every
 * insertion string in this module family is authored with `'\n'` — and the
 * file goes back to disk with its own `\r\n`. `newLineKind` is pinned to LF
 * for the same reason: ts-morph's own structure printer must agree with the
 * hand-built text, and the file system is the single place the ending is
 * decided. See `@core/page-parser`'s `eolFileSystem.ts`.
 */
export function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    fileSystem: new EolPreservingFileSystem(),
    manipulationSettings: { newLineKind: NewLineKind.LineFeed },
  })
}

/**
 * WB-25 — make a project that is shared across several codemods (one batch of
 * edits) agree with the disk again before the next one runs.
 *
 * Every codemod reaches its file through {@link loadSourceFile}, which already
 * refreshes a file it has seen; this covers what that does not. A codemod that
 * declined AFTER it had started changing its tree (a refusal found halfway
 * through) leaves that tree dirty and unsaved — refreshing puts back what the
 * disk says. A file another writer changed (a postcss or plain-text codemod,
 * an import plan) is re-read, and one that disappeared is dropped. And every
 * node the previous codemod wrapped is forgotten: ts-morph re-maps each
 * wrapped node on every manipulation, so wrappers left over from edit N would
 * make edit N+1's writes slower for no reason.
 *
 * Cheap when nothing changed: one read and a string compare per file.
 */
export function syncProjectWithDisk(project: Project): void {
  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.refreshFromFileSystemSync()
    if (!sourceFile.wasForgotten()) sourceFile.forgetDescendants()
  }
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
  // codemod that throws there would reach the user as an unnamed failure instead
  // of the `element-moved` refusal the board recovers from by itself.
  // Bounds-checked here so all of them get the honest answer.
  const lineStarts = sourceFile.compilerNode.getLineStarts()
  if (line < 1 || line > lineStarts.length || col < 1) return undefined
  const lineStart = lineStarts[line - 1]!
  const lineEnd = line < lineStarts.length ? lineStarts[line]! : sourceFile.getFullText().length
  const pos = lineStart + col - 1
  if (pos > lineEnd) return undefined

  // WB-25 — position-indexed: the token AT `pos` is the tag name's first
  // token (`Foo`, `motion` of `motion.div`, `this`), and the element that
  // owns it is its nearest opening-like ancestor. This used to walk every
  // descendant of the file, which wraps every node ts-morph has — ~95 ms per
  // lookup on a 1,500-element page, paid again by every edit in a batch.
  if (pos >= sourceFile.getEnd()) return undefined
  for (let node: Node | undefined = sourceFile.getDescendantAtPos(pos); node; node = node.getParent()) {
    if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
      return node.getTagNameNode().getStart() === pos ? node : undefined
    }
    // Past the tag name: an ancestor that starts before `<` cannot be the
    // element whose name starts at `pos`, and no JSX element sits between.
    if (node.getStart() < pos - 1) return undefined
  }
  return undefined
}

/**
 * Thrown when no JSX element starts at the requested `line:col` — the file
 * changed since whoever named that position read it. A TYPED miss, so the
 * writeback batch can report it as the `element-moved` refusal it is (and the
 * board can re-read and retry) instead of an unexplained codemod failure.
 */
export class JsxElementNotFoundError extends Error {
  readonly reason = 'element-moved'
  readonly path: string

  constructor(message: string, path: string) {
    super(message)
    this.name = 'JsxElementNotFoundError'
    this.path = path
  }
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
    throw new JsxElementNotFoundError(
      `No JSX element found at ${file}:${line}:${col} (expected the column to point at the ` +
        'character immediately after "<" in a JSX opening/self-closing tag).',
      `${file}:${line}:${col}`,
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
