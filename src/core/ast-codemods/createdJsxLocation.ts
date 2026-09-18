/**
 * createdJsxLocation — where the element a structural codemod just wrote ended
 * up, expressed in the one coordinate the rest of Studio speaks: the 1-based
 * `line:col` of its tag-name identifier.
 *
 * ## Why a codemod has to answer this at all
 *
 * `insert`, `duplicate`, `wrap` and `group` all create markup that did not
 * exist a moment ago, so the element has no node id until the board re-parses
 * the file. Everything downstream of that — selecting the copy after ⌘D,
 * putting the inspector on the box the library just added, selecting the
 * container ⌘G wrote — needs to name the new element BEFORE the re-parse has
 * happened, and the only party that can name it is the codemod that spliced
 * it in. `keys-01`'s K7 shipped the selection on the in-memory path and left
 * this half open; this module is that half.
 *
 * ## How it is derived, and why not from the AST alone
 *
 * Every structural codemod here writes by SPLICING bytes (`jsxChildRange.ts`),
 * never by re-emitting through a printer, so after the write the only thing
 * that is known for certain is *which byte range the new text occupies*. Two
 * pure steps turn that into a location:
 *
 *   1. `offsetAfterEdits` — a codemod's offsets are all measured against the
 *      text BEFORE the write, and a second edit (the `import` an insert or a
 *      wrap writes above the JSX) moves the splice point. This replays only
 *      the other edits' length deltas, which is exactly the arithmetic
 *      `applyTextEdits` performs by sorting descending.
 *   2. `createdJsxLocation` — the first `<` inside a rendered block is the new
 *      element's own opening tag in every placement shape
 *      (`jsxChildPlacement.ts`'s four, plus `wrap`/`group`'s container): the
 *      only bytes a block can carry ahead of it are indentation, a newline, or
 *      the `>` that reopens a self-closing parent.
 *
 * The answer is then VERIFIED against the re-parsed file rather than trusted:
 * `findJsxElementAtLocation` must resolve an element at it, or this returns
 * `null`. A wrong id is worse than no id — it would select, and then let the
 * user edit, something they never created.
 */
import type { SourceFile } from 'ts-morph'
import { findJsxElementAtLocation } from './locateJsxElement'
import type { TextEdit } from './jsxChildRange'

/** 1-based line/col of a JSX element's tag-name start — `locateJsxElement.ts`'s convention. */
export interface CreatedJsxLocation {
  line: number
  col: number
}

/**
 * Where an offset measured against the ORIGINAL text lands once `edits` have
 * been applied. Only edits that end at or before the offset move it; ranges
 * never overlap (every producer derives them from distinct AST nodes), so
 * there is no partial case to reason about.
 *
 * Pass the OTHER edits of the write, not the one whose text you are locating:
 * its own start is the thing being shifted.
 */
export function offsetAfterEdits(edits: readonly TextEdit[], offset: number): number {
  let shifted = offset
  for (const edit of edits) {
    if (edit.end <= offset) shifted += edit.text.length - (edit.end - edit.start)
  }
  return shifted
}

/**
 * The tag-name location of the element `block` opens, given that `block` was
 * spliced into the (already re-parsed) `sourceFile` at `blockStart`.
 *
 * `null` when the block opens no element, or when the re-parsed file does not
 * agree that one starts there — see this module's own doc for why that is a
 * refusal to answer rather than a best guess.
 */
export function createdJsxLocation(
  sourceFile: SourceFile,
  blockStart: number,
  block: string,
): CreatedJsxLocation | null {
  const openingAngle = block.indexOf('<')
  if (openingAngle === -1) return null
  const { line, column } = sourceFile.getLineAndColumnAtPos(blockStart + openingAngle + 1)
  return findJsxElementAtLocation(sourceFile, line, column) ? { line, col: column } : null
}
