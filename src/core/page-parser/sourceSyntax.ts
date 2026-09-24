/**
 * sourceSyntax — "does this file parse?", asked the one way (WB-24).
 *
 * TypeScript's parser never gives up: an unclosed `<p>` still yields a tree,
 * recovered by guesswork, and `parsePageFile` walks it happily — the canvas
 * then shows `"unclosed"` as text with no hint that the file is broken, and
 * every codemod locates, splices and writes against a tree the file does not
 * actually spell. A write into a file that does not parse is a write whose
 * target was guessed.
 *
 * So both halves ask here:
 *
 * - **Load** — `sourceFileSyntaxError(sourceFile)` on the page's own file,
 *   already parsed by the kept `Project`. The load flags the page; it never
 *   throws.
 * - **Write** — `fileSyntaxError(absPath)` on the file as it sits on disk,
 *   because the write path holds a path, not a `SourceFile`, and must see the
 *   bytes the codemod is about to touch.
 *
 * Both ask a ONE-FILE compiler program with no lib and no module resolution
 * ({@link firstSyntacticDiagnostic}). The load used to ask the project's own
 * program, assuming the parse had already built it — until the persistent
 * parse cache (P6-B) made a load that parses nothing the common case, and this
 * question alone then built the whole program: 1.3 s of a 2.0 s load on a
 * 40-page board, measured, for an answer that depends on one file's text.
 *
 * Syntactic only, never semantic: an unresolved import or a type error is the
 * user's business and does not make a location ambiguous. A parse error does.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { ts, type SourceFile } from 'ts-morph'

/** The first parse error in a file: 1-based line/column and TypeScript's own sentence. */
export interface SourceSyntaxError {
  line: number
  col: number
  message: string
}

/** The first syntactic diagnostic of `sourceFile`, or `undefined` when it parses cleanly. Never throws. */
export function sourceFileSyntaxError(sourceFile: SourceFile): SourceSyntaxError | undefined {
  try {
    return firstSyntacticDiagnostic(sourceFile.compilerNode)
  } catch (err) {
    console.error('[sourceSyntax]', err)
    return undefined
  }
}

/**
 * The first syntactic diagnostic of the file at `absPath` as it is on disk, or
 * `undefined` when it parses cleanly, does not exist, or cannot be read — a
 * missing file is every codemod's own refusal to make, not this one's.
 *
 * The bare compiler API, not a ts-morph `Project`: this runs once per file on
 * every save, and a throwaway `Project` measured 3-5x the parse itself on a
 * 1,500-row page (~150 ms against ~30 ms). A one-file program with no lib and
 * no module resolution adds well under a millisecond on top of the parse.
 */
export function fileSyntaxError(absPath: string): SourceSyntaxError | undefined {
  let text: string
  try {
    text = readFileSync(absPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    // The file's own extension decides the grammar: `.tsx` allows JSX and
    // types, `.ts` types but not JSX, `.jsx`/`.js` JSX but not types.
    const fileName = `syntax-check${path.extname(absPath) || '.tsx'}`
    return firstSyntacticDiagnostic(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKindOf(fileName)))
  } catch (err) {
    console.error('[sourceSyntax]', err)
    return undefined
  }
}

/**
 * The first syntactic diagnostic of an already-parsed `sourceFile`, through a
 * program that holds only that file: no lib, no module resolution, so nothing
 * but the file itself is read or bound. Syntactic diagnostics are the parse's
 * own (plus the JS-only grammar checks a program adds for `.js`/`.jsx`), so
 * the answer is the same one a whole-project program gives.
 */
function firstSyntacticDiagnostic(sourceFile: ts.SourceFile): SourceSyntaxError | undefined {
  const fileName = sourceFile.fileName
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
    writeFile: () => undefined,
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => ts.sys.newLine,
  }
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  })
  const [first] = program.getSyntacticDiagnostics(sourceFile)
  return first ? toSyntaxError(first, sourceFile) : undefined
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TSX
  }
}

function toSyntaxError(diagnostic: ts.Diagnostic, sourceFile: ts.SourceFile): SourceSyntaxError {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  return { line: line + 1, col: character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') }
}
