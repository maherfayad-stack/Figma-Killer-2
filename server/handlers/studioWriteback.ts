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

/** A decoded writeback target: workspace-relative file plus 1-based line/column. */
export interface StudioEditLocation {
  rel: string
  line: number
  col: number
}

/**
 * The source location a node id writes back to, or `null` for a synthetic node
 * (e.g. the `index:body` root) that has none.
 *
 * For a COMPOSITE (inlined) id — `callSite~component:line:col`, §2.4 — the
 * target is the LAST segment: the component's own file and position. That is
 * genuinely where the markup lives, so it is genuinely where an edit belongs.
 *
 * Splitting on `INLINE_ID_SEPARATOR` FIRST is not optional. `NODE_LOC_ID`'s
 * greedy `.*` matches straight through the separator, so running it on a whole
 * composite id yields the right line/col with a file path of
 * `"pages/Home.jsx:77:19~components/Icon.jsx"` — a path that does not exist,
 * and if it ever did, a file the user never asked to modify.
 */
export function studioEditLocation(nodeId: string): StudioEditLocation | null {
  const target = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  const m = NODE_LOC_ID.exec(target)
  return m ? { rel: m[1]!, line: Number(m[2]), col: Number(m[3]) } : null
}

/** True when this id came from a component inlined at a call site — one edit here rewrites every instance. */
export function isInlinedNodeId(nodeId: string): boolean {
  return nodeId.includes(INLINE_ID_SEPARATOR)
}

/**
 * Order a save batch BOTTOM-TO-TOP: descending line, then descending column.
 * Node ids encode a `line:col` source location, and a codemod can change a
 * file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line). Applying the lowest positions first guarantees an edit can
 * never invalidate the source location of another edit still pending in the
 * same batch — and because the sort is descending by line globally, it is also
 * descending within each file, so a batch spanning several files stays safe.
 * Edits whose id has no decodable location sort last — `applyStudioEdit`
 * no-ops on them anyway. Pure, so the ordering is unit-testable without
 * touching the filesystem.
 */
export function orderStudioEditsForApply<T extends { nodeId: string }>(edits: readonly T[]): T[] {
  return [...edits].sort((a, b) => {
    const la = studioEditLocation(a.nodeId)
    const lb = studioEditLocation(b.nodeId)
    if (!la) return 1
    if (!lb) return -1
    return lb.line - la.line || lb.col - la.col
  })
}

/**
 * Collapses edits that resolve to the SAME source location, keeping the last.
 *
 * Two board nodes can share one writeback target: every instance of an inlined
 * component maps back to the same lines in that component's file (measured on
 * the eSIM corpus: 138 of 223 targets are shared, one of them by 29 nodes).
 * Without this, editing two instances in a single batch would apply both writes
 * to the same position — the second reading a file the first already changed,
 * for a silent last-write-wins with a stale intermediate.
 */
export function dedupeStudioEdits<T extends { nodeId: string; kind: string }>(edits: readonly T[]): T[] {
  const byTarget = new Map<string, T>()
  const passthrough: T[] = []
  for (const edit of edits) {
    const loc = studioEditLocation(edit.nodeId)
    if (!loc) {
      passthrough.push(edit)
      continue
    }
    const prop = 'prop' in edit ? String((edit as { prop?: unknown }).prop) : ''
    byTarget.set(`${loc.rel}:${loc.line}:${loc.col}|${edit.kind}|${prop}`, edit)
  }
  return [...byTarget.values(), ...passthrough]
}

/**
 * The absolute file a node id writes back to, or `null` for a synthetic node.
 * Exposed so the save route can build its "which files did this batch touch"
 * set (to detect a codemod-caused line-count shift) without re-deriving the
 * composite-id rule — see `studioEditLocation`.
 */
export function studioEditFile(dir: string, nodeId: string): string | null {
  const loc = studioEditLocation(nodeId)
  return loc ? join(dir, loc.rel) : null
}

/**
 * Applies one typed studio edit to the .tsx source under `dir`, dispatching
 * on `edit.kind` to the matching `ast-codemods` writer. Extracted as a pure
 * helper (dir + edit in, codemod side effect out) so it's unit-testable
 * against temp fixture files without a full Request/Response round trip.
 *
 * An INLINED node writes to the component's own file (`studioEditLocation`),
 * which means the edit lands on every instance of that component. That is the
 * honest behaviour — there is one source file — and the editor warns before
 * the user commits to it (`fromComponent` on the node, surfaced in the
 * properties panel). It also means the board is stale afterwards for every
 * OTHER instance, so the save route reports `sharedComponents` and the client
 * reloads.
 *
 * Returns `false` for a synthetic node id (e.g. the `index:body` root) that
 * has no source location — nothing to write, not an error. Returns `true` once
 * the matching codemod has written the file. Propagates whatever the underlying
 * codemod throws (e.g. `JsxTextTargetError`, `JsxStyleTargetError`) for a real
 * source location it refuses to touch — callers decide whether to
 * skip-and-log or let it bubble.
 */
export function applyStudioEdit(dir: string, edit: StudioEdit): boolean {
  const target = studioEditLocation(edit.nodeId)
  if (!target) return false // synthetic node (e.g. body) — no source location
  const loc = { file: join(dir, target.rel), line: target.line, col: target.col }

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
