/**
 * studioListItemWriteback — OD-8's edit kind, `list-item`: a `.map` row's
 * reorder, delete, duplicate or paste, written to the ARRAY LITERAL the
 * `.map` iterates (`editListItems`, `@core/ast-codemods`).
 *
 * Its own module rather than a branch of `studioStructuralWriteback.ts`
 * because its target is not a JSX element: `nodeId` is the array literal's own
 * `[` position (`ListRowSource.array`, stamped by the parser), decoded and
 * path-guarded by the same `studioEditLocation` every kind shares — so the
 * containment rules, the touched-file set and the bottom-to-top ordering all
 * apply unchanged. `length` is the element count the caller read; the codemod
 * refuses `list-changed` when the literal on disk holds a different one.
 *
 * The op vocabulary is `@core/page-tree`'s `ListItemOpSchema` — one source of
 * truth for the planner that builds an op and the wire that validates it.
 *
 * Returns rather than throws, like its structural siblings; `studioWriteback.ts`
 * turns a refusal into the batch's `StudioEditRefusalError`.
 */
import { editListItems } from '@core/ast-codemods'
import { ListItemOpSchema } from '@core/page-tree'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { Project } from 'ts-morph'

export const ListItemEditSchema = Type.Object({
  kind: Type.Literal('list-item'),
  /** The array literal's own `rel:line:col` — its `[`. */
  nodeId: Type.String(),
  /** How many elements the caller read in the literal — the identity this edit checks before writing. */
  length: Type.Integer({ minimum: 0 }),
  op: ListItemOpSchema,
})
export type ListItemEditWire = Static<typeof ListItemEditSchema>

export type ListItemEditOutcome = { ok: true } | { ok: false; reason: string; message: string }

/** Run one `list-item` edit against its already-decoded, already-guarded location. */
export function applyListItemEdit(
  loc: { file: string; line: number; col: number },
  edit: ListItemEditWire,
  project?: Project,
): ListItemEditOutcome {
  const result = editListItems({ ...loc, length: edit.length, op: edit.op, ...(project ? { project } : {}) })
  // A remove's ⌘Z is the undo journal's `restore` (P3-F): nothing to report.
  return result.ok ? { ok: true } : { ok: false, ...result.refusal }
}
