/**
 * deleteJsxElement — `struct-01`, the write behind "delete this element" on
 * the board. Removes the JSX child element at a `line:col`, along with the
 * indentation and newline it owned, and writes the file back.
 *
 * ## It no longer refuses over imports
 *
 * This used to REFUSE when every remaining reference to an imported binding
 * lived inside the deleted subtree — `<TabBar/>` was the only `TabBar` — on
 * the grounds that removing the import too would make the edit touch a second,
 * unrelated place in the file. That was the wrong reading of "one honest
 * target". The import's only reason to exist WAS the element; the two are one
 * fact written in two places, and the second is derived mechanically, not
 * guessed. `insertJsxElement` had the symmetric half right all along —
 * inserting `<Button/>` writes the `Button` import — so the asymmetry meant
 * Studio could add an element it was then unable to remove, and told the user
 * to go finish the job by hand.
 *
 * The import is retired by `pruneOrphanedImports`, which the save batch runs
 * ONCE PER FILE after every edit has landed. That module's doc explains why it
 * cannot live here: an import sits at the top of the file, so deleting its
 * line mid-batch shifts the pending `line:col` of every edit still queued
 * below it — the exact hazard `orderStudioEditsForApply` exists to prevent —
 * and a binding shared by two elements being deleted together is orphaned by
 * neither one alone, so asked per edit the answer is wrong anyway.
 *
 * ## One refusal remains, and it is not about imports
 *
 *  - **`no-jsx-parent`** (from `resolveJsxChildRange`) — the element is the
 *    outermost thing the component returns. Deleting it leaves `return ;`, a
 *    file that no longer parses.
 *
 * ## Deliberately does NOT tidy up after itself
 *
 * A codemod that collapses a now-empty parent or reformats the gap it left is
 * a codemod that changes bytes the user never pointed at. What is left behind
 * is exactly the file minus one element.
 */
import { type Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type JsxChildRangeReason,
} from './jsxChildRange'

export interface DeleteJsxElementParams {
  file: string
  /** 1-based line/col of the element being deleted (its tag-name start). */
  line: number
  col: number
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type DeleteJsxRefusalReason = JsxChildRangeReason

export interface DeleteJsxRefusal {
  reason: DeleteJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export type DeleteJsxElementResult = { ok: true } | { ok: false; refusal: DeleteJsxRefusal }

export function deleteJsxElement(params: DeleteJsxElementParams): DeleteJsxElementResult {
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

  writeVerbatimSource(sourceFile, file, verbatim.slice(0, target.range.start) + verbatim.slice(target.range.end))
  return { ok: true }
}
