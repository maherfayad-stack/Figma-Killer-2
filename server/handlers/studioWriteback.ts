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
import { setJsxProp, setJsxStyle, setJsxTagName, setJsxText, setStringLiteral } from '@core/ast-codemods'
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

/**
 * One string-literal-in-place writeback — `setStringLiteral`.
 *
 * The odd one out: its target is not the JSX the node renders, but the literal
 * that JSX READS. `<span>{c.hotelsTag}</span>` cannot be written at the span —
 * that would replace the i18n binding with a baked string — while
 * `hotelsTag: 'Exclusive rates on hotels'` in `translations.js` is an ordinary
 * literal and rewriting it is exactly what editing that copy means. The client
 * emits this from `PageNode.textOrigin`.
 *
 * `nodeId` here is the ORIGIN's own `rel:line:col`, not the rendering node's, so
 * ordering / dedupe / touched-file collection all keep working through the one
 * `studioEditLocation` decoder — and two board nodes fed by the same dictionary
 * key dedupe onto one write, which is what shared copy means.
 */
const LiteralEditSchema = Type.Object({
  kind: Type.Literal('literal'),
  nodeId: Type.String(),
  text: Type.String(),
})

/**
 * One element rename — `setJsxTagName`.
 *
 * `tag` is the one editor property that is not an attribute: it is synthesized
 * from the element's NAME so an imported `<h1>` keeps rendering as an `<h1>`.
 * Writing it through `setJsxProp` added a literal `tag="section"` attribute and
 * left the element a `<div>`, so it gets its own kind and its own codemod.
 */
const TagEditSchema = Type.Object({
  kind: Type.Literal('tag'),
  nodeId: Type.String(),
  tag: Type.String(),
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
export const StudioEditSchema = Type.Union([
  PropEditSchema,
  TextEditSchema,
  StyleEditSchema,
  LiteralEditSchema,
  TagEditSchema,
])
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
  if (!m) return null
  const rel = m[1]!
  return isWritableSourceRel(rel) ? { rel, line: Number(m[2]), col: Number(m[3]) } : null
}

/** Files a writeback may touch. Never a `.env`, a lockfile, or anything else that isn't app source. */
const WRITABLE_SOURCE_EXTENSION = /\.(tsx?|jsx?|mjs|cjs)$/i

/**
 * Whether a decoded `rel` is safe to write, checked on the PATH SHAPE alone so
 * this stays pure and every consumer of `studioEditLocation` inherits it.
 *
 * The whole batch arrives from the client, `rel` included, and the save route
 * builds its target with `join(dir, rel)` — so `../../.ssh/config:1:1` as a
 * nodeId was an arbitrary file write. Nothing legitimate produces one: the parser
 * mints these ids from `path.relative(workspaceRoot, file)` for files it already
 * found inside the workspace.
 *
 * The extension check is the second half. Even contained, a writeback belongs on
 * app source and nowhere else, and every codemod here parses its target as
 * TypeScript/JavaScript anyway.
 */
function isWritableSourceRel(rel: string): boolean {
  if (rel.length === 0) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false
  const segments = rel.split(/[/\\]/)
  if (segments.some((segment) => segment === '..' || segment === '')) return false
  return WRITABLE_SOURCE_EXTENSION.test(rel)
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
    case 'literal':
      setStringLiteral({ ...loc, value: edit.text })
      return true
    case 'tag':
      setJsxTagName({ ...loc, tag: edit.tag })
      return true
  }
}
