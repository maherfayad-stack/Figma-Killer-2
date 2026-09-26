/**
 * studioSvgWriteback — the `svg-attr` edit kind (P5-D, SVG-4): set and remove
 * literal attributes on one element inside an inline `<svg>`, in one write.
 *
 * It rides `POST /admin/api/studio/save` like every value kind: no new route,
 * no new capability. `nodeId` is the HOST `<svg>`'s own node id, so it decodes
 * through `studioEditLocation`'s containment guard, orders, dedupes and
 * collects its touched file exactly as a `prop` edit does. `part` is the
 * inner element's `line:col` in that same file, as the parser stamped it
 * (`data-studio-svg-part`, SVG-3); `''` names the host itself.
 *
 * ## Why a kind of its own and not `prop`
 *
 *   - **Containment.** A part location arrives from the client. The codemod
 *     proves it is JSX nested inside the host `<svg>`, with a tag from the SVG
 *     content set — `svg-attr` cannot write an attribute anywhere else in the
 *     file.
 *   - **The server refuses an expression.** `d={ICON}` refuses
 *     `svg-attr-expression`: the guard is here, not only in the client.
 *   - **Atomic.** `d` + `transform`, or setting one attribute and clearing
 *     another, is one write and one undo — `setJsxProp` cannot say that.
 *   - **One rule for what may be written.** Every name and value goes through
 *     `@core/vector`'s `svgAttributeWriteRefusal`, the rule the SVG importer
 *     uses: no handlers, no namespaces, fragment-only `href`, no remote
 *     `url()`. Untrusted input from the editor, a plugin or an agent all hits
 *     the same wall.
 *
 * The codemod RETURNS its refusals (`setSvgPartAttributes`); the dispatcher
 * turns them into the batch's one refusal channel, as for `styled`/`class`.
 *
 * ## Its undo
 *
 * The inverse is the same kind carrying the previous literals, with `remove`
 * for attributes that were absent (`svgPartCommits.ts` on the client records
 * it as a `known` structural inverse). A part whose location no longer
 * resolves refuses `element-moved`, the stale-target refusal the board
 * recovers from by re-reading.
 */
import { setSvgPartAttributes, type SetSvgPartAttributesResult } from '@core/ast-codemods'
import { parseSvgPartLocation } from '@core/vector'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { Project } from 'ts-morph'

/** The wire bound on one edit: more attributes than any real element carries. */
const MAX_ATTRIBUTES_PER_EDIT = 64

/** A JSX attribute name as it may arrive; the codemod applies the real rule. */
const AttributeNameSchema = Type.String({ minLength: 1, maxLength: 64 })

const SvgAttrEditSchema = Type.Object({
  kind: Type.Literal('svg-attr'),
  /** The host `<svg>` node's id. */
  nodeId: Type.String(),
  /** The part's `line:col` as stamped, or `''` for the host `<svg>` itself. */
  part: Type.String({ maxLength: 16 }),
  /** The part's tag as the caller read it; a mismatch refuses `element-moved`. */
  partTag: Type.String({ minLength: 1, maxLength: 32 }),
  /** JSX attribute names → the literal to write. */
  set: Type.Record(AttributeNameSchema, Type.Union([Type.String(), Type.Number()]), { maxProperties: MAX_ATTRIBUTES_PER_EDIT }),
  /** JSX attribute names to delete; an absent one is a no-op. */
  remove: Type.Optional(Type.Array(AttributeNameSchema, { maxItems: MAX_ATTRIBUTES_PER_EDIT })),
})

export const SvgEditSchemas = [SvgAttrEditSchema] as const
export type SvgAttrEdit = Static<typeof SvgAttrEditSchema>

export function isSvgAttrEdit(edit: { kind: string }): edit is SvgAttrEdit {
  return edit.kind === 'svg-attr'
}

/**
 * Where an `svg-attr` edit writes, for ordering a batch: its PART, not its
 * host. Two part edits inside one `<svg>` share the host's `line:col`, and an
 * added attribute can wrap a multi-line tag, so the lower part must be written
 * first — the batch's bottom-to-top rule, one level down. `null` when `edit`
 * is not one (or names the host itself).
 */
export function svgAttrOrderLocation(edit: { kind: string; part?: unknown }): { line: number; col: number } | null {
  if (edit.kind !== 'svg-attr' || typeof edit.part !== 'string' || edit.part === '') return null
  return parseSvgPartLocation(edit.part)
}

/** Apply one `svg-attr` edit at the decoded host location. */
export function applySvgAttrEdit(
  host: { file: string; line: number; col: number },
  edit: SvgAttrEdit,
  project?: Project,
): SetSvgPartAttributesResult {
  const part = edit.part === '' ? null : parseSvgPartLocation(edit.part)
  if (edit.part !== '' && part === null) {
    return { ok: false, reason: 'svg-part-outside-host', message: 'That part of the graphic has no location Studio can write to.' }
  }
  return setSvgPartAttributes({
    ...host,
    part,
    partTag: edit.partTag,
    set: edit.set,
    ...(edit.remove ? { remove: edit.remove } : {}),
    ...(project ? { project } : {}),
  })
}
