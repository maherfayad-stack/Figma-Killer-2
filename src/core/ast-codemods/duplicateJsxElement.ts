/**
 * duplicateJsxElement — W4-1, the write behind "duplicate this element" on a
 * studio-imported board. Copies the JSX child at a `line:col` and writes the
 * copy in as its own next sibling.
 *
 * WHY THIS CAN EXIST AT ALL
 * -------------------------
 * Duplicate used to be a blanket refusal, on the stated grounds that "the copy
 * would have no source location of its own, so it could never be written back".
 * That was true of a copy MINTED ON THE CANVAS — and false of this one.
 * `insertJsxElement` had already shown the way out: write the element into the
 * `.tsx`, then re-read the board, and what comes back is an ordinary parsed
 * node with a real `rel:line:col`. Duplicate is the same move with the source
 * text taken from the element already on screen instead of from a picker.
 *
 * NO IMPORT RECONCILIATION, BY CONSTRUCTION
 * -----------------------------------------
 * The copy lands in the same file, in the same scope, immediately beside the
 * original. Every binding its markup captures — an imported component, a
 * destructured prop, a `.map` callback's parameter — is in scope at the new
 * position precisely because it was in scope at the old one, one line up. That
 * is what makes duplicate the cheapest of the three W4-1 verbs: there is no
 * free-variable analysis to run (`moveJsxElement`'s reparent form needs one)
 * and no `import` to add (`insertJsxElement` and `wrapJsxElement` both do).
 *
 * BYTE-EXACTNESS, same standard as its siblings: the AST only LOCATES, and the
 * write is a splice of the original bytes (`jsxChildRange.ts`). The copy is the
 * original's own text, character for character — its comments, its attribute
 * wrapping and its blank lines included — so a duplicated element reads like
 * the thing it was duplicated from rather than like something a printer
 * re-emitted.
 */
import { type Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

export interface DuplicateJsxElementParams {
  file: string
  /** 1-based line/col of the element being duplicated (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/**
 * Every refusal here is `resolveJsxChildRange`'s own, and each stays a refusal
 * for a reason duplicate does not change:
 *
 *  - **`no-jsx-parent`** — the element is what the component RETURNS. A copy
 *    beside it would be a second root, which is not valid JSX; a component
 *    returns exactly one element.
 *  - **`expression-child`** — the element is produced by an expression
 *    (`{cond && <X/>}`, a `.map`). Copying the JSX would copy the branch, not
 *    the element the canvas is showing.
 *  - **`not-found` / `stale-source`** — the file no longer says what the board
 *    thinks it says.
 */
export type DuplicateJsxRefusalReason = JsxChildRangeReason

export interface DuplicateJsxRefusal {
  reason: DuplicateJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type DuplicateJsxElementResult = { ok: true } | { ok: false; refusal: DuplicateJsxRefusal }

export function duplicateJsxElement(params: DuplicateJsxElementParams): DuplicateJsxElementResult {
  const { file, line, col } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return { ok: false, refusal: { reason: target.reason, message: target.message } }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return {
      ok: false,
      refusal: {
        reason: 'stale-source',
        message: 'This file changed on disk since the canvas last read it. Reload the project and try again.',
      },
    }
  }

  const { start, end, wholeLine } = target.range
  const copy = verbatim.slice(start, end)
  // A whole-line range already carries its own indentation and trailing
  // newline, so re-inserting it verbatim at `end` produces a second, identically
  // indented line. An inline element owns only itself, so it joins the row the
  // way a hand-written sibling would: separated by one space.
  const inserted = wholeLine ? copy : ` ${copy}`

  writeVerbatimSource(sourceFile, file, verbatim.slice(0, end) + inserted + verbatim.slice(end))
  return { ok: true }
}
