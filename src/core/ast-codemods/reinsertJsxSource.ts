/**
 * reinsertJsxSource — `store-15`, ⌘Z's own half of a source delete:
 * splices `deleteJsxElement`'s discarded bytes back into a parent's children
 * at a given position, and re-adds any import declaration the delete's
 * `pruneOrphanedImports` pass took with it.
 *
 * WHY THIS IS NOT "INSERT, BUT WITH A KNOWN STRING"
 * --------------------------------------------------
 * `insertJsxElement` renders a NEW subtree from a validated wire description
 * and writes it with the file's OWN indentation rules. This codemod is
 * handed a string the CLIENT ALREADY WROTE — `deleteJsxElement`'s own
 * `removed.text`, which for a whole-line child already carries its own
 * leading indentation and trailing newline — and simply puts it back where it
 * came from. Rendering it again through `jsxChildPlacement.ts`'s indentation
 * machinery would double the indent an already-indented whole-line block
 * carries. So placement here is a plain byte splice at a computed OFFSET, the
 * same discipline `moveJsxElement`'s `reorder` uses, not a `render` callback.
 *
 * WHY AN INDEX, NOT AN ANCHOR
 * ---------------------------
 * Every other structural codemod names a sibling to write beside, because an
 * index computed on the CANVAS does not name a position in the source (one
 * `{items.map(…)}` child contributes N canvas nodes, a `{cond && <X/>}`
 * contributes one of two). An undo has no such ambiguity: the client captured
 * `index` by counting the PARENT's own plain JSX-element children at delete
 * time (`captureDeleteOrigin`, mirroring this module's own `elementChildren`
 * count), which is exactly the list this codemod re-derives from the AST. The
 * two agree by construction, not by convention.
 *
 * PLACEMENT, restated as three cases:
 *
 *  - `index` names a child STILL THERE — splice at the START of that child's
 *    own owned range (`resolveJsxChildRange`, whole-line-aware). Because
 *    deleting a wholeLine child never moves anything BEFORE it, that position
 *    is exactly where the removed bytes used to start.
 *  - `index` is PAST THE END — splice after the owned range of the last
 *    remaining child (the deleted child was the last one).
 *  - the parent has NO plain element children left — splice right after the
 *    parent's own opening tag; for a wholeLine restore, one line further in
 *    (there is already an inner newline surviving the delete, from the JSX
 *    text node the deleted child's OWN wholeLine range never claimed).
 *
 * WHAT `text` AND `imports` ARE ALLOWED TO BE — two guards, in order
 * ------------------------------------------------------------------
 * `text`/`imports` are strings the client sends. This is the first codemod
 * in the tree that splices CLIENT-SUPPLIED SOURCE BYTES into a file, so
 * "does the result parse?" is not the question — a result that parses is
 * easy to arrange while still saying something completely different from
 * "the element that used to be here" (`sec-22`: close the parent, close the
 * component, add a module-level statement, reopen both — zero syntax errors,
 * and code that runs the moment Vite next imports the file). So each string
 * is SHAPE-checked on its own, before any placement arithmetic:
 *
 *  - every `imports` entry must parse, standalone, as exactly one
 *    `ImportDeclaration` (`parsesAsOneImportDeclaration`);
 *  - `text` must parse, wrapped in a fragment, as JSX CONTENT and nothing
 *    else — elements, fragments, text, `{…}` expression children — with the
 *    wrapper fragment the only statement in the file (`isJsxContentOnly`).
 *    An unmatched closing tag, a bare statement, or a declaration is a parse
 *    error in that isolated parse regardless of what the real file says.
 *
 * Only then is the CANDIDATE file parsed in a throwaway in-memory project
 * (never the shared, disk-backed one this codemod's own project is) and its
 * syntactic diagnostics compared against the ORIGINAL file's
 * (`introducesSyntaxErrors`) — defense in depth for a splice that is
 * well-formed on its own but lands somewhere it cannot (a self-closing
 * parent the placement reopened wrongly, say). Syntactic only: a JSX file
 * legitimately carries semantic diagnostics (unresolved imports,
 * `noUnusedLocals`) this codemod has no business judging. Every refusal
 * leaves the file untouched.
 */
import { Node, Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
  type TextEdit,
} from './jsxChildRange'
import { elementChildren, tagLocation, trimTrailingBlankBack } from './jsxChildPlacement'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'

export interface ReinsertJsxSourceParams {
  file: string
  /** 1-based line/col of the PARENT element the child is restored into (its tag-name start). */
  line: number
  col: number
  /**
   * The child position to restore at, counting only the parent's plain JSX
   * element children — the same list `elementChildren` walks. Captured at
   * delete time from the page tree, before the node left it.
   */
  index: number
  /** The exact bytes `deleteJsxElement` removed — `DeletedJsxText.text`, unchanged. */
  text: string
  /** Standalone import declaration texts to re-add, one per binding the delete's own prune pass removed. */
  imports?: readonly string[]
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type ReinsertJsxRefusalReason =
  | JsxChildRangeReason
  | 'not-a-container'
  | 'invalid-import'
  | 'not-jsx-content'
  | 'invalid-source'

export interface ReinsertJsxRefusal {
  reason: ReinsertJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type ReinsertJsxSourceResult =
  | { ok: true; created: CreatedJsxLocation | null }
  | { ok: false; refusal: ReinsertJsxRefusal }

function refuse(reason: ReinsertJsxRefusalReason, message: string): { ok: false; refusal: ReinsertJsxRefusal } {
  return { ok: false, refusal: { reason, message } }
}

export function reinsertJsxSource(params: ReinsertJsxSourceParams): ReinsertJsxSourceResult {
  const { file, line, col, index, text, imports = [] } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const parentOpening = findJsxElementAtLocation(sourceFile, line, col)
  if (!parentOpening) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  for (const importText of imports) {
    if (!parsesAsOneImportDeclaration(importText)) {
      return refuse(
        'invalid-import',
        'One of the imports this undo would restore is no longer valid on its own, so nothing was changed. Reload the project and try again.',
      )
    }
  }

  if (!isJsxContentOnly(text)) {
    return refuse(
      'not-jsx-content',
      'What this undo would restore is not an element, so nothing was changed. Reload the project and try again.',
    )
  }

  const placement = resolveReinsertPlacement(sourceFile, verbatim, parentOpening, index, text)
  if (!placement.ok) return placement

  const importEdit = buildImportReinsertEdit(sourceFile, verbatim, imports)
  const edits: TextEdit[] = importEdit ? [placement.edit, importEdit] : [placement.edit]
  const candidate = applyTextEdits(verbatim, edits)

  if (introducesSyntaxErrors(file, verbatim, candidate)) {
    return refuse(
      'invalid-source',
      'Restoring this element would leave the file with a syntax error Studio cannot write, so nothing was changed.',
    )
  }

  writeVerbatimSource(sourceFile, file, candidate)
  // Only the IMPORT edit moves the splice point — it sits above the JSX, and
  // the placement edit's own start is the thing being located. Same
  // arithmetic `insertJsxElement` runs for its own import edit.
  return {
    ok: true,
    created: createdJsxLocation(sourceFile, offsetAfterEdits(importEdit ? [importEdit] : [], placement.edit.start), placement.edit.text),
  }
}

type PlacementResult = { ok: true; edit: TextEdit } | { ok: false; refusal: ReinsertJsxRefusal }

/** Where `text` lands inside `parentOpening`'s element — see this module's own doc for the three cases. */
function resolveReinsertPlacement(
  sourceFile: SourceFile,
  verbatim: string,
  parentOpening: JsxOpeningLikeElement,
  index: number,
  text: string,
): PlacementResult {
  if (Node.isJsxSelfClosingElement(parentOpening)) {
    // Reopen a self-closing parent into a paired tag — the same rewrite
    // `jsxChildPlacement.ts`'s own reopen branch makes for a NEW element,
    // done here for a RESTORED one: `text` is used as-is, never re-rendered.
    const tagName = parentOpening.getTagNameNode().getText()
    const end = parentOpening.getEnd()
    const selfCloseStart = verbatim.lastIndexOf('/>', end)
    if (selfCloseStart < parentOpening.getStart()) {
      return refuse('not-a-container', 'Studio could not read where this element closes, so it cannot restore a child into it.')
    }
    const beforeSlash = trimTrailingBlankBack(verbatim, selfCloseStart)
    return { ok: true, edit: { start: beforeSlash, end, text: `>${text}</${tagName}>` } }
  }

  const parentElement = parentOpening.getParent()
  if (!parentElement || !Node.isJsxElement(parentElement)) {
    return refuse('not-a-container', 'Studio could not resolve this element to something that can hold children.')
  }

  const children = elementChildren(parentElement)
  const target = children[index]
  if (target) {
    const range = resolveJsxChildRange(sourceFile, ...tagLocation(sourceFile, target))
    if (!range.ok) return refuse(range.reason, range.message)
    return { ok: true, edit: { start: range.range.start, end: range.range.start, text } }
  }

  const last = children[children.length - 1]
  if (last) {
    const range = resolveJsxChildRange(sourceFile, ...tagLocation(sourceFile, last))
    if (!range.ok) return refuse(range.reason, range.message)
    return { ok: true, edit: { start: range.range.end, end: range.range.end, text } }
  }

  // No plain element children survive.
  const innerStart = parentOpening.getEnd()
  const innerEnd = parentElement.getClosingElement().getStart()
  const inner = verbatim.slice(innerStart, innerEnd)
  if (inner.trim() !== '') {
    // Something is still there that isn't a plain element (an expression
    // child, a bare text node) — the same shape `jsxChildPlacement.ts` gives
    // a brand-new insert into such a parent: append after it rather than
    // splicing into the middle of content this codemod cannot parse the
    // position of.
    return { ok: true, edit: { start: innerEnd, end: innerEnd, text } }
  }
  // Truly empty. `parentOpening.getEnd()` is right after `>` — for a
  // whole-line restore that is one byte too early (the inner newline the
  // deleted child's OWN range never owned still separates the parent's
  // tags), so advance past the first newline before the closing tag when
  // there is one. An inline restore (no such newline — the parent's tags
  // were already directly adjacent) lands right after `>`.
  const newlineAfter = verbatim.indexOf('\n', innerStart)
  const at = newlineAfter !== -1 && newlineAfter < innerEnd ? newlineAfter + 1 : innerStart
  return { ok: true, edit: { start: at, end: at, text } }
}

/**
 * The single edit that re-adds every import in `imports`, all as standalone
 * lines after the file's last import declaration (or at the very top when it
 * has none) — the same landing spot `resolveImportEdits` gives a brand-new
 * import, and, when the file's imports end exactly where the pruned one used
 * to sit, the byte-for-byte original position.
 *
 * `null` for an empty list, so the caller can skip it entirely rather than
 * carry a zero-length edit through the splice arithmetic.
 */
function buildImportReinsertEdit(sourceFile: SourceFile, verbatim: string, imports: readonly string[]): TextEdit | null {
  if (imports.length === 0) return null
  const lines = imports.map((text) => `${text}\n`).join('')
  const declarations = sourceFile.getImportDeclarations()
  const last = declarations[declarations.length - 1]
  if (!last) return { start: 0, end: 0, text: lines }
  const newlineAfter = verbatim.indexOf('\n', last.getEnd())
  const at = newlineAfter === -1 ? verbatim.length : newlineAfter + 1
  return { start: at, end: at, text: lines }
}

/**
 * Whether `text` is JSX CONTENT and nothing else — what a delete could have
 * taken out of a parent's children: elements, fragments, text and `{…}`
 * expression children, in any number, and never a statement.
 *
 * `sec-22`: this is the check that makes `reinsert-source` an element write
 * rather than a source write. The whole-file diagnostic comparison below only
 * proves the RESULT parses, and a result that parses is easy to arrange — a
 * `text` that closes the parent, closes the component, adds a module-level
 * statement and reopens both leaves a file with zero syntax errors and code
 * that runs the moment Vite next imports it. Wrapping `text` in a fragment
 * and demanding that the fragment is the ONLY thing in the file makes every
 * shape that ESCAPES the child position a parse error — an unmatched
 * `</section>`, a bare `}`, a second top-level element after a closed
 * fragment — before any placement arithmetic runs.
 *
 * What this deliberately does NOT refuse: bytes that merely LOOK like code.
 * `const x = 1` between two children is JSX text, and it stays JSX text
 * once spliced among the parent's children — rendered as characters, never
 * evaluated. An expression child is JSX content too: it evaluates only when
 * the element renders, exactly like the `{t.title}` a delete legitimately
 * removes, and `insert`'s own children may carry the same.
 */
function isJsxContentOnly(text: string): boolean {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = scratch.createSourceFile('reinsert-text-check.tsx', `<>${text}</>`)
  if (scratch.getProgram().getSyntacticDiagnostics(sourceFile).length > 0) return false
  const statements = sourceFile.getStatements()
  const only = statements.length === 1 ? statements[0] : undefined
  if (!only || !Node.isExpressionStatement(only)) return false
  const fragment = only.getExpression()
  // The fragment must be OUR wrapper: its own text is the whole file, so a
  // `text` that closed our `<>` early and opened another cannot pass.
  return Node.isJsxFragment(fragment) && fragment.getStart() === 0 && fragment.getEnd() === sourceFile.getEnd()
}

/** Whether `text` parses, on its own, as exactly one `ImportDeclaration` — never trusted merely because the client sent it. */
function parsesAsOneImportDeclaration(text: string): boolean {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = scratch.createSourceFile('reinsert-import-check.tsx', text)
  const statements = sourceFile.getStatements()
  return (
    statements.length === 1 &&
    Node.isImportDeclaration(statements[0]) &&
    scratch.getProgram().getSyntacticDiagnostics(sourceFile).length === 0
  )
}

/**
 * True when `candidate` carries syntactic diagnostics `original` did not —
 * the SECOND guard, after `isJsxContentOnly`/`parsesAsOneImportDeclaration`
 * have already vouched for each string's shape. On its own this is a global
 * COUNT, and a diagnostic-clean file makes 0-vs-0 trivial to satisfy
 * (`sec-22`), so it never stands alone: it catches the splice that is fine
 * in isolation but wrong where it landed — the shape check parses `text` as
 * `.tsx`, so TypeScript-only syntax inside an otherwise well-formed element
 * is only seen here, against the real file's own `.jsx` extension.
 *
 * A throwaway in-memory `Project`, never the shared one this codemod's own
 * `sourceFile` lives in: parsing a bad candidate must not leave that project
 * holding a broken tree for whatever edit runs after this one in the same
 * batch.
 */
export function introducesSyntaxErrors(file: string, original: string, candidate: string): boolean {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  // Two distinct filenames in one throwaway project (never `file` itself,
  // which would collide with whatever the real, disk-backed project holds),
  // both keeping `file`'s own extension so a `.jsx` candidate is parsed with
  // JSX support rather than silently downgraded.
  const ext = /\.[cm]?[jt]sx?$/.exec(file)?.[0] ?? '.tsx'
  const beforeFile = scratch.createSourceFile(`before${ext}`, original)
  const afterFile = scratch.createSourceFile(`after${ext}`, candidate)
  const program = scratch.getProgram()
  return program.getSyntacticDiagnostics(afterFile).length > program.getSyntacticDiagnostics(beforeFile).length
}
