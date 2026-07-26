/**
 * studioWriteback — the typed studio-edit model and the pure dir+edit→codemod
 * dispatch that `POST /admin/api/studio/save` (`server/handlers/studio.ts`)
 * runs per edit (Phase 3, Slice B). Split out of `studio.ts` because this is
 * one coherent unit — the edit schema, the ordering rule, and the dispatcher
 * all exist to serve the same "batch of typed source writebacks" contract —
 * and it's independently unit-testable against temp fixture files without a
 * full Request/Response round trip.
 *
 * A batch of typed edits (`kind: 'prop' | 'text' | 'style'`). Each edit's
 * nodeId is decoded back to a source location and dispatched to the matching
 * `ast-codemods` writer (`setJsxProp` / `setJsxText` / `setJsxStyle`) via
 * `applyStudioEdit`. Synthetic nodes (e.g. the `index:body` root) don't match
 * the loc pattern and are skipped. The save route applies each edit
 * independently — one codemod throwing (e.g. a text edit landing on an
 * element with mixed children) is logged and skipped by the route rather than
 * aborting the whole batch.
 */
import { join } from 'node:path'
import { INLINE_ID_SEPARATOR } from '@core/page-parser'
import { setJsxProp, setJsxStyle, setJsxText } from '@core/ast-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/

/** One prop attribute writeback — `setJsxProp`. */
const PropEditSchema = Type.Object({
  kind: Type.Literal('prop'),
  nodeId: Type.String(),
  prop: Type.String(),
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
})

/** One element-text-children writeback — `setJsxText`. */
const TextEditSchema = Type.Object({
  kind: Type.Literal('text'),
  nodeId: Type.String(),
  text: Type.String(),
})

/** One `style={{ ... }}` merge writeback — `setJsxStyle`. */
const StyleEditSchema = Type.Object({
  kind: Type.Literal('style'),
  nodeId: Type.String(),
  style: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
export const StudioEditSchema = Type.Union([PropEditSchema, TextEditSchema, StyleEditSchema])
export type StudioEdit = Static<typeof StudioEditSchema>

/**
 * Order a save batch BOTTOM-TO-TOP: descending line, then descending column.
 * Node ids encode a `line:col` source location, and a codemod can change a
 * file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line). Applying the lowest positions first guarantees an edit can
 * never invalidate the source location of another edit still pending in the
 * same batch. Edits whose id has no decodable location (synthetic nodes like
 * `index:body`) sort last — `applyStudioEdit` no-ops on them anyway. A
 * composite (inlined) node id (§2.4 — contains `INLINE_ID_SEPARATOR`) sorts
 * last for the same reason: `applyStudioEdit` refuses it too, and
 * `NODE_LOC_ID`'s greedy `.*` would otherwise happily match a composite id's
 * TAIL location and rank it as if it were a real, decodable position. Pure,
 * so the ordering is unit-testable without touching the filesystem.
 */
export function orderStudioEditsForApply<T extends { nodeId: string }>(edits: readonly T[]): T[] {
  return [...edits].sort((a, b) => {
    const aInlined = a.nodeId.includes(INLINE_ID_SEPARATOR)
    const bInlined = b.nodeId.includes(INLINE_ID_SEPARATOR)
    if (aInlined || bInlined) return aInlined === bInlined ? 0 : aInlined ? 1 : -1
    const la = NODE_LOC_ID.exec(a.nodeId)
    const lb = NODE_LOC_ID.exec(b.nodeId)
    if (!la) return 1
    if (!lb) return -1
    return Number(lb[2]) - Number(la[2]) || Number(lb[3]) - Number(la[3])
  })
}

/**
 * Applies one typed studio edit to the .tsx source under `dir`, dispatching
 * on `edit.kind` to the matching `ast-codemods` writer. Extracted as a pure
 * helper (dir + edit in, codemod side effect out) so it's unit-testable
 * against temp fixture files without a full Request/Response round trip.
 *
 * Returns `false` for a synthetic node id (e.g. the `index:body` root) that
 * has no source location — nothing to write, not an error. Returns `false`
 * for a composite (inlined) node id too (§2.4) — `NODE_LOC_ID`'s greedy `.*`
 * would otherwise happily match past the `INLINE_ID_SEPARATOR` and derive a
 * garbage file path from the composite id's prefix, silently corrupting
 * whatever file that prefix happens to resolve to. An inlined node has no
 * single valid writeback location (see `inlineLocalComponents`'s doc comment
 * for why) — refusing here is deliberate, not a gap. Returns `true` once the
 * matching codemod has written the file. Propagates whatever the underlying
 * codemod throws (e.g. `JsxTextTargetError`, `JsxStyleTargetError`) for a real
 * source location it refuses to touch — callers decide whether to
 * skip-and-log or let it bubble.
 */
/**
 * Decodes a node id's source-location prefix into an absolute file path under
 * `dir`, or `null` for a synthetic node (no location) or a composite
 * (inlined, §2.4) node id — the same decode `applyStudioEdit` uses, exposed
 * so the save route can build its "which files did this batch touch" set
 * (to detect a codemod-caused line-count shift) without duplicating the
 * composite-id guard.
 */
export function studioEditFile(dir: string, nodeId: string): string | null {
  if (nodeId.includes(INLINE_ID_SEPARATOR)) return null // inlined — no writeback (§2.4)
  const m = NODE_LOC_ID.exec(nodeId)
  return m ? join(dir, m[1]) : null
}

export function applyStudioEdit(dir: string, edit: StudioEdit): boolean {
  if (edit.nodeId.includes(INLINE_ID_SEPARATOR)) return false // inlined — no writeback (§2.4)
  const m = NODE_LOC_ID.exec(edit.nodeId)
  if (!m) return false // synthetic node (e.g. body) — no source location
  const [, rel, line, col] = m
  const loc = { file: join(dir, rel), line: Number(line), col: Number(col) }

  switch (edit.kind) {
    case 'prop':
      setJsxProp({ ...loc, prop: edit.prop, value: edit.value })
      return true
    case 'text':
      setJsxText({ ...loc, text: edit.text })
      return true
    case 'style':
      setJsxStyle({ ...loc, style: edit.style })
      return true
  }
}
