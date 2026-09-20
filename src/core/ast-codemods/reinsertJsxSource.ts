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
 * BYTE-EXACTNESS AND THE SYNTAX-DIAGNOSTIC GUARD
 * -----------------------------------------------
 * `text`/`imports` are strings the client sends; nothing stops a stale or
 * hand-crafted request from naming a splice that does not parse. Rather than
 * refuse on a narrower, hand-rolled check, the CANDIDATE file is parsed in a
 * throwaway in-memory project (never the shared, disk-backed one this
 * codemod's own project is) and its syntactic diagnostics are compared
 * against the ORIGINAL file's — new ones mean the splice broke something, and
 * the whole write refuses rather than landing a half-broken file. Syntactic
 * only: a JSX file legitimately carries semantic diagnostics (unresolved
 * imports, `noUnusedLocals`) this codemod has no business judging.
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

export type ReinsertJsxRefusalReason = JsxChildRangeReason | 'not-a-container' | 'invalid-import' | 'invalid-source'

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
 * the one check that stands between a client-supplied `text`/`imports` and a
 * file Studio would otherwise write with a syntax error in it.
 *
 * A throwaway in-memory `Project`, never the shared one this codemod's own
 * `sourceFile` lives in: parsing a bad candidate must not leave that project
 * holding a broken tree for whatever edit runs after this one in the same
 * batch.
 */
function introducesSyntaxErrors(file: string, original: string, candidate: string): boolean {
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
