/**
 * duplicateJsxElement — writes a second copy of a JSX child element
 * immediately after the original, and writes the file back.
 *
 * ## Why this exists, given that Studio used to refuse it outright
 *
 * Duplicate was refused for every imported element with this reason: "the copy
 * would have no source location of its own, so it could never be written
 * back". That sentence describes a copy minted on the CANVAS — given a
 * `nanoid()` id, held in the tree, and then unwritable because no `line:col`
 * in the user's file corresponds to it. It was true of that design.
 *
 * But it is not a fact about duplication, and `insertJsxElement` is the proof:
 * an inserted element has no id either, and insert works, because it writes
 * the file FIRST and lets the board re-read the result. The copy's source
 * location is not something Studio has to invent — it is something the file
 * gives back the moment the bytes are on disk.
 *
 * So a duplicate is an insert whose content is bytes that already exist. That
 * turns out to be the *easiest* structural edit rather than the hardest,
 * because the one genuinely difficult part of insert — rendering a subtree to
 * correct source text — is replaced by copying a range verbatim.
 *
 * ## Byte-exactness
 *
 * The range comes from `ownedTextRange`, the same one `moveJsxElement` splices
 * and `deleteJsxElement` cuts. For an element alone on its line that range
 * already includes its indentation and trailing newline, so re-inserting it at
 * its own end yields a correctly indented copy on the next line with no
 * string-building at all. For an element sharing a line (`<a/><b/>`) the range
 * is the element alone, and the copy lands flush beside it — which is the
 * formatting the author chose for that spot.
 *
 * The copy is therefore byte-identical to the original: comments inside it,
 * attribute wrapping, blank lines and JSX expression children all survive,
 * because nothing is re-rendered. Every other byte in the file is untouched.
 *
 * ## What this deliberately does NOT do
 *
 * It does not rename anything in the copy. A duplicated element that sets
 * `id="checkout"` produces two elements with that id, exactly as copying the
 * JSX by hand would. Studio cannot know whether a given attribute is meant to
 * be unique, and inventing `id="checkout-2"` would be editing the user's
 * code beyond what they asked for — the "one honest write target" invariant
 * cuts both ways.
 *
 * The refusals that keep this safe are decided before the codemod runs:
 * `refuseStructuralEdit` rejects `.map` rows (where a copy needs a `key`),
 * shared components, route chrome and code-placed elements, and
 * `resolveJsxChildRange` rejects anything whose position is decided at runtime.
 */
import { Project } from 'ts-morph'
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
  /** Shared ts-morph project, so a batch of edits parses each file once. */
  project?: Project
}

/** Why a duplicate could not be written. Every reason is one `resolveJsxChildRange` already distinguishes. */
export type DuplicateJsxRefusalReason = JsxChildRangeReason

export interface DuplicateJsxRefusal {
  reason: DuplicateJsxRefusalReason
  message: string
}

export type DuplicateJsxElementResult = { ok: true } | { ok: false; refusal: DuplicateJsxRefusal }

/**
 * Write a copy of the element at `line:col` immediately after itself.
 *
 * Fails closed and says why, like every structural codemod: the file either
 * gains exactly one copy or is left byte-for-byte alone.
 */
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
        message:
          'This file changed on disk since the canvas last read it. Reload the project and try the duplicate again.',
      },
    }
  }

  const { start, end } = target.range
  const copy = verbatim.slice(start, end)
  writeVerbatimSource(sourceFile, file, verbatim.slice(0, end) + copy + verbatim.slice(end))
  return { ok: true }
}
