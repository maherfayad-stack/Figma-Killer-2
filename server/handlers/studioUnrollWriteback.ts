/**
 * studioUnrollWriteback — G-9's edit kind, `unroll-list`: a `.map` over an
 * array literal written in the same file becomes the explicit elements it
 * rendered (`unrollMapExpression`, `@core/ast-codemods`).
 *
 * Its own module for `studioListItemWriteback.ts`'s reason: its target is not
 * the element the board's id names, so the wire says what it expects to find.
 * `nodeId` is the ROW ROOT's template position (a row's id minus its `#n` —
 * one piece of JSX renders every row, so this is the one place all of them
 * are), decoded and path-guarded by the same `studioEditLocation` every kind
 * shares. `array` is the literal's `[` the board read and `length` its item
 * count: the codemod checks both against the file, so a list that changed
 * under the board refuses (`list-changed`) rather than unrolling something
 * the user did not point at.
 *
 * Returns rather than throws, like its siblings; `studioWriteback.ts` turns a
 * refusal into the batch's `StudioEditRefusalError`. ⌘Z is the undo journal's
 * `restore` (`studioBatchUndoJournal.ts`): the rows replace source text no
 * edit kind describes.
 */
import { unrollMapExpression } from '@core/ast-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { Project } from 'ts-morph'
import type { CreatedJsxLocation } from '@core/ast-codemods'

export const UnrollListEditSchema = Type.Object({
  kind: Type.Literal('unroll-list'),
  /** The row root's `rel:line:col`, without its `#n` row suffix. */
  nodeId: Type.String(),
  /** The array literal's own `rel:line:col` — its `[` — in the same file as `nodeId`. */
  array: Type.String(),
  /** How many items the board read in the literal. */
  length: Type.Integer({ minimum: 1 }),
})
export type UnrollListEditWire = Static<typeof UnrollListEditSchema>

/** Run one `unroll-list` edit against its already-decoded, already-guarded location. */
export type UnrollListOutcome =
  | { ok: true; created: CreatedJsxLocation[] }
  | { ok: false; reason: string; message: string }

export function applyUnrollListEdit(
  loc: { file: string; line: number; col: number },
  targetRel: string,
  /** `edit.array` decoded by `studioEditLocation` (the caller's job: the path guard lives there), or `null`. */
  array: { rel: string; line: number; col: number } | null,
  edit: UnrollListEditWire,
  project?: Project,
): UnrollListOutcome {
  // The array must be in the file being written: a list whose items are written
  // elsewhere is not one this edit can unroll.
  if (!array || array.rel !== targetRel) {
    return { ok: false, reason: 'not-literal', message: "This list's items are not written in the same file as its rows. Move the array into this file first." }
  }
  const result = unrollMapExpression({
    file: loc.file,
    line: loc.line,
    col: loc.col,
    array: { line: array.line, col: array.col },
    length: edit.length,
    ...(project ? { project } : {}),
  })
  return result.ok ? { ok: true, created: result.created } : { ok: false, ...result.refusal }
}
