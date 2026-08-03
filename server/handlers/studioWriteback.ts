/**
 * studioWriteback — the typed studio-edit model and the pure dir+edit→codemod
 * dispatch that `POST /admin/api/studio/save` (`server/handlers/studio.ts`)
 * runs per edit (Phase 3, Slice B). Split out of `studio.ts` because this is
 * one coherent unit — the edit schema, the ordering rule, and the dispatcher
 * all exist to serve the same "batch of typed source writebacks" contract —
 * and it's independently unit-testable against temp fixture files without a
 * full Request/Response round trip.
 *
 * A batch of typed edits (`kind: 'prop' | 'text' | 'style' | 'literal' | 'tag'
 * | 'asset' | 'detach' | 'swap' | 'move' | 'delete' | 'insert' | 'css'`).
 *
 * This module owns the VALUE kinds, which all share one shape: decode the
 * `nodeId` back to a `rel:line:col`, path-guard it, and hand it to the matching
 * `ast-codemods` writer (`setJsxProp` / `setJsxText` / `setJsxStyle` /
 * `setStringLiteral` / `setJsxTagName` / `setImportSpecifier`) — a rewrite in
 * place that leaves the file's line count alone. Two SIBLINGS own the kinds
 * that do not fit that shape, and both dependencies run one way (this module
 * folds their schemas into `StudioEditSchema` and calls in; neither imports
 * back):
 *
 *   - `studioCssWriteback.ts` — `css`. Its target is a FILE + SELECTOR rather
 *     than a decoded `line:col`, and it writes through a postcss CST.
 *   - `studioStructuralWriteback.ts` — `move` / `delete` / `insert`. These
 *     change WHERE markup is: they take a second location (an anchor sibling),
 *     they change the file's line count (invalidating every id below them,
 *     which is why `isSharedSourceNodeId` always reports them as shared), and
 *     each can refuse for reasons only the AST can see.
 *
 * Synthetic nodes (e.g. the `index:body` root) don't match the loc pattern and
 * are skipped. The save route applies each edit independently — one codemod
 * throwing (e.g. a text edit landing on an element with mixed children) is
 * logged and skipped by the route rather than aborting the whole batch.
 */
import { isAbsolute, join, resolve, sep } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES, INLINE_ID_SEPARATOR } from '@core/page-parser'
import { isInlinedNodeId, isRouteChromeNodeId } from '@core/page-tree'
import {
  detachComponentInstance,
  setImportSpecifier,
  setJsxProp,
  setJsxStyle,
  setJsxTagName,
  setJsxText,
  setStringLiteral,
  swapComponentInstance,
} from '@core/ast-codemods'
import { applyCssEdit, CssEditSchema } from './studioCssWriteback'
import {
  applyStructuralEdit,
  isStructuralEditKind,
  StructuralEditSchemas,
} from './studioStructuralWriteback'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/

/**
 * One prop attribute writeback — `setJsxProp`.
 *
 * WS-4.2/4.3 — `prop` may arrive prefixed `callSiteProps:<name>` (the
 * convention `parsedPageToSitePage.ts` uses for a `studio.instance`'s
 * call-site props, parallel to `style:<property>`). `applyStudioEdit` strips
 * the prefix before calling `setJsxProp` — a `studio.instance`'s own id IS
 * the call site's plain (non-composite) location, so the prop write lands
 * on the call site's own JSX attribute exactly like any other node's.
 */
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

/**
 * One import-specifier writeback — `setImportSpecifier` (WS-8.3).
 *
 * The other odd one out, same shape of oddity as `literal` above: its target
 * is not the JSX the node renders (`<img src={heroImg}/>`), but the IMPORT
 * DECLARATION that JSX reads through. `nodeId` here is `PageNode.assetOrigin`'s
 * own `rel:line:col` — the import's module-specifier literal — so it decodes
 * through the same `studioEditLocation` every other edit kind shares.
 *
 * `assetPath` is the workspace-relative POSIX path of the file the import
 * should point at AFTER the edit (from `POST /admin/api/studio/asset-upload`'s
 * response, or an existing asset the picker offered) — never a specifier
 * string directly: computing the actual relative specifier from the
 * IMPORTING file's own directory to `assetPath` is `applyStudioEdit`'s job,
 * because only the server knows both paths precisely, and doing it here means
 * `assetPath` gets the same containment guard every other write target gets
 * (see `resolveContainedAssetPath`) before a single character reaches disk.
 */
const AssetEditSchema = Type.Object({
  kind: Type.Literal('asset'),
  nodeId: Type.String(),
  assetPath: Type.String(),
})

/**
 * One "detach a local component instance" writeback (WS-4.4) —
 * `detachComponentInstance`. `nodeId` is a `studio.instance` node's own id
 * (the call site's plain location — never composite, see that node's doc
 * comment). Unlike every other edit kind, this can REFUSE with a specific
 * reason rather than simply "no writable location" — see `applyStudioEdit`'s
 * `StudioEditRefusalError`.
 */
const DetachEditSchema = Type.Object({
  kind: Type.Literal('detach'),
  nodeId: Type.String(),
})

/**
 * One "swap this instance for a different component" writeback (WS-4.5) —
 * `swapComponentInstance`. `newComponentFile` is a workspace-relative POSIX
 * path when `newComponentSource` is `'local'`, or a bare package specifier
 * when `'package'`.
 */
const SwapEditSchema = Type.Object({
  kind: Type.Literal('swap'),
  nodeId: Type.String(),
  newComponentName: Type.String(),
  newComponentSource: Type.Union([Type.Literal('local'), Type.Literal('package')]),
  newComponentFile: Type.String(),
})

/** Discriminated union of every studio edit kind — `kind` is the discriminator. */
export const StudioEditSchema = Type.Union([
  PropEditSchema,
  TextEditSchema,
  StyleEditSchema,
  LiteralEditSchema,
  TagEditSchema,
  AssetEditSchema,
  DetachEditSchema,
  SwapEditSchema,
  ...StructuralEditSchemas,
  CssEditSchema,
])
export type StudioEdit = Static<typeof StudioEditSchema>

/**
 * Thrown by `applyStudioEdit` when a `detach`/`swap` codemod REFUSES rather
 * than failing unexpectedly — a typed, first-class outcome (reason +
 * message) distinct from an ordinary codemod exception. `applyStudioEditBatch`
 * catches this specially and records it in `StudioEditBatchResult.refusals`
 * so the client can show the SPECIFIC reason (a toast with an offer, per
 * WS-4.4's plan), not just a generic "skipped" count — every other codemod's
 * thrown error stays in the existing skip-and-log path unchanged.
 */
export class StudioEditRefusalError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'StudioEditRefusalError'
    this.reason = reason
  }
}

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

/**
 * True when an edit to this node invalidates OTHER frames on the board —
 * because the id is an inlined component instance, because it belongs to
 * route chrome composed into many routes, or (WS-8.3) because it is an ASSET
 * edit. The save route returns this as `sharedComponents` so the client knows
 * to reload rather than trust its in-memory copy of the other frames.
 *
 * `isInlinedNodeId`/`isRouteChromeNodeId` are the page-tree module's own id
 * grammar (`@core/page-tree/sourceNodeId.ts`) — the same predicates the
 * editor's structural refusal consults, so the "this write is shared" answer
 * cannot drift between the two sides of the wire.
 *
 * An asset edit's target is an IMPORT DECLARATION, which any number of JSX
 * usages in the same file can read (`<img src={hero}/>` appearing twice) —
 * unlike a plain prop/style/tag/literal edit, whose `nodeId` names the ONE
 * element (or ONE dictionary entry) being changed, there is no cheap way to
 * tell from the id alone whether another node depends on the same import.
 * Treated as shared unconditionally: same "fail toward the reload" policy as
 * route chrome below — the cost of a false positive is one redundant reload,
 * the cost of a false negative is a board showing an image that no longer
 * matches source.
 *
 * WS-4.4/4.5 — `detach`/`swap` are ALSO treated as shared unconditionally:
 * both always rewrite JSX structure (adding/removing imports, replacing an
 * element) and therefore always shift line numbers, invalidating every OTHER
 * node id below them in the same file whether or not this particular node
 * happened to be an inlined/shared one.
 *
 * `struct-01` — `move`/`delete` join them for the same reason: relocating or
 * removing a JSX child always changes the line count of every node id below it.
 */
export function isSharedSourceNodeId(nodeId: string, kind?: StudioEdit['kind']): boolean {
  if (kind === 'asset' || kind === 'detach' || kind === 'swap') return true
  if (kind !== undefined && isStructuralEditKind(kind)) return true
  return isInlinedNodeId(nodeId) || isRouteChromeNodeId(nodeId)
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
 * Validates that `assetPathRel` — the client-supplied, workspace-relative
 * path of the file a `kind: 'asset'` edit should point an import AT — is safe
 * to reference, and resolves to a POSIX-normalized form once confirmed.
 *
 * Same adversarial posture as `resolveStudioAssetResponse`'s read-path guard
 * (`server/handlers/studioAsset.ts`): reject absolute/UNC/drive-letter forms,
 * `..`/empty segments on EITHER separator, and any `EXCLUDED_WORKSPACE_DIR_NAMES`
 * segment; then require CONTAINMENT ON THE REAL PATH after resolving symlinks
 * — a workspace can arrive from GitHub, and git stores symlinks, so a textual
 * check alone is bypassable. `null` on any violation, or when the target does
 * not exist (a specifier pointing nowhere is worse than refusing the edit).
 *
 * This never touches `assetPathRel` itself for the WRITE — `applyStudioEdit`
 * only ever calls `setImportSpecifier` on the file holding the import — but a
 * bad value here would still inject an arbitrary relative reference into the
 * user's tracked source, so it gets the full guard set before being trusted.
 */
function resolveContainedAssetPath(dir: string, assetPathRel: string): string | null {
  if (assetPathRel.length === 0) return null
  if (isAbsolute(assetPathRel)) return null
  if (/^[a-zA-Z]:/.test(assetPathRel)) return null // Windows drive path
  if (assetPathRel.startsWith('\\\\') || assetPathRel.startsWith('//')) return null // UNC path

  const segments = assetPathRel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = resolve(dir)
  const resolved = resolve(join(dir, ...segments))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null

  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return null // missing file / broken symlink — nowhere honest to point an import
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null

  return segments.join('/')
}

/**
 * A relative module specifier from the file at `fromFileRel` to the file at
 * `toFileRel`, both workspace-relative POSIX paths — the exact inverse of
 * what `resolveImageAssetImport` (`src/core/page-parser/assetImports.ts`)
 * resolves when READING an import, so a round trip (edit, reload, re-resolve)
 * lands back on the same file. Always relative (`./…` / `../…`), matching
 * every specifier shape this pipeline already reads.
 */
function relativeImportSpecifier(fromFileRel: string, toFileRel: string): string {
  const fromDir = fromFileRel.split('/').slice(0, -1).join('/')
  const fromSegments = fromDir.length > 0 ? fromDir.split('/') : []
  const toSegments = toFileRel.split('/')

  let common = 0
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1
  }

  const ups = fromSegments.length - common
  const downSegments = toSegments.slice(common)
  const relPath = [...Array(ups).fill('..'), ...downSegments].join('/')
  return relPath.startsWith('.') ? relPath : `./${relPath}`
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
 * skip-and-log or let it bubble. A `detach`/`swap` REFUSAL (a typed, expected
 * outcome — see `detachComponentInstance`/`swapComponentInstance`) throws
 * `StudioEditRefusalError` specifically, so `applyStudioEditBatch` can surface
 * the reason instead of folding it into the generic skip-and-log path.
 */
/**
 * WS-4.5 — what changed on the call site's props when a `swap` edit
 * succeeds: attributes the new component doesn't accept (dropped) and
 * required props it needs that the call site didn't already supply (left
 * for the user to fill in — never synthesized). Surfaced all the way to the
 * client (`StudioEditBatchResult.swapDetails` → `/save`'s response →
 * `swapComponentInstance` in `fsCodemodAdapter.ts`) so the Properties panel
 * can report it instead of a bare "swapped" toast.
 */
export interface StudioEditSwapDetail {
  removedProps: string[]
  unfilledRequiredProps: string[]
}

/**
 * `applyStudioEdit`'s result. `applied: false` means "no writable source
 * location, nothing to do" (a synthetic node, an unresolvable asset target)
 * — not an error, the existing `skipped` counter's meaning. `swapDetail` is
 * populated only for a successful `swap` edit — see `StudioEditSwapDetail`.
 */
export interface StudioEditApplyOutcome {
  applied: boolean
  swapDetail?: StudioEditSwapDetail
}

export function applyStudioEdit(dir: string, edit: StudioEdit): StudioEditApplyOutcome {
  // WS-6.3 — a CSS edit's target is a FILE + SELECTOR (`edit.file`/
  // `edit.selector`), never the nodeId-encoded `rel:line:col` every other
  // kind decodes below; `edit.nodeId` here is a synthesized, non-decodable
  // string (see `CssEditSchema`'s doc), so it must branch off before
  // `studioEditLocation` ever sees it. `studioCssWriteback` RETURNS its
  // refusals rather than throwing (it is a leaf that knows nothing about this
  // module); translating them here keeps one refusal channel for every kind.
  if (edit.kind === 'css') {
    const outcome = applyCssEdit(dir, edit)
    if ('refusal' in outcome) throw new StudioEditRefusalError(outcome.refusal.reason, outcome.refusal.message)
    return { applied: outcome.applied }
  }

  const target = studioEditLocation(edit.nodeId)
  if (!target) return { applied: false } // synthetic node (e.g. body) — no source location
  const loc = { file: join(dir, target.rel), line: target.line, col: target.col }

  switch (edit.kind) {
    case 'prop': {
      // WS-4.2/4.3 — a `studio.instance`'s call-site prop arrives as
      // `callSiteProps:<name>` (see `PropEditSchema`'s doc comment); the
      // actual JSX attribute is `<name>` at this SAME location (the instance
      // node's own id is the call site's own plain location).
      const prop = edit.prop.startsWith('callSiteProps:') ? edit.prop.slice('callSiteProps:'.length) : edit.prop
      setJsxProp({ ...loc, prop, value: edit.value })
      return { applied: true }
    }
    case 'text':
      setJsxText({ ...loc, text: edit.text })
      return { applied: true }
    case 'style':
      setJsxStyle({ ...loc, style: edit.style })
      return { applied: true }
    case 'literal':
      setStringLiteral({ ...loc, value: edit.text })
      return { applied: true }
    case 'asset': {
      // `target` here is the IMPORT's own location (assetOrigin), decoded by
      // the same `studioEditLocation` every other kind shares — `target.rel`
      // is therefore the file HOLDING the import, which is exactly what
      // `relativeImportSpecifier` needs as its "from" side.
      const assetPath = resolveContainedAssetPath(dir, edit.assetPath)
      if (assetPath === null) return { applied: false } // unsafe or missing target — refuse, never guess
      const specifier = relativeImportSpecifier(target.rel, assetPath)
      setImportSpecifier({ ...loc, specifier })
      return { applied: true }
    }
    case 'tag':
      setJsxTagName({ ...loc, tag: edit.tag })
      return { applied: true }
    case 'move':
    case 'delete':
    case 'insert': {
      // Both ends decode through the same guard, so a hand-crafted
      // `anchorNodeId` cannot name a file outside the workspace or a file that
      // is not app source — and a cross-file anchor is dropped here rather than
      // reaching a codemod that would need an AST to notice. What each kind
      // does with a missing anchor is `applyStructuralEdit`'s call.
      const anchorId = 'anchorNodeId' in edit ? edit.anchorNodeId : undefined
      const anchor = anchorId ? studioEditLocation(anchorId) : null
      const result = applyStructuralEdit(
        loc,
        edit,
        anchor && anchor.rel === target.rel ? anchor : null,
      )
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      return { applied: true }
    }
    case 'detach': {
      const result = detachComponentInstance({ ...loc, workspaceRoot: dir })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true }
    }
    case 'swap': {
      const result = swapComponentInstance({
        ...loc,
        workspaceRoot: dir,
        newComponentName: edit.newComponentName,
        newComponentSource: edit.newComponentSource,
        newComponentFile: edit.newComponentFile,
      })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return {
        applied: true,
        swapDetail: { removedProps: result.removedProps, unfilledRequiredProps: result.unfilledRequiredProps },
      }
    }
  }
}

/**
 * One `detach`/`swap`/`move`/`delete`/`css` edit that refused rather than
 * writing — surfaced to the client so it can show the SPECIFIC reason (a toast
 * with an offer, per WS-4.4's plan; `StyleTargetChip`'s per-tier message for
 * `css`; the AST-only structural reasons for `move`/`delete`) instead of a
 * generic "skipped" count.
 */
export interface StudioEditRefusal {
  nodeId: string
  kind: 'detach' | 'swap' | 'move' | 'delete' | 'insert' | 'css'
  reason: string
  message: string
}

/** The edit kinds whose refusal is a NAMED, expected outcome rather than a codemod exception. */
function isRefusingEditKind(kind: StudioEdit['kind']): kind is StudioEditRefusal['kind'] {
  return kind === 'detach' || kind === 'swap' || kind === 'css' || isStructuralEditKind(kind)
}

/** The result of applying a batch of studio edits — `POST /admin/api/studio/save`'s own response shape. */
export interface StudioEditBatchResult {
  written: number
  skipped: number
  /** True when any write shifted a touched file's line count — stale `line:col` node ids downstream must re-parse. */
  shifted: boolean
  /** True when any edit targets an inlined/shared source location — every OTHER frame reading the same file is now stale too. */
  sharedComponents: boolean
  /** WS-4.4/4.5 — every `detach`/`swap` edit that refused, with why. Empty array when none did (always present, never omitted, so a client doesn't need an `?.length` guard). */
  refusals: StudioEditRefusal[]
  /** WS-4.5 — every `swap` edit that SUCCEEDED, with what changed on the call site. Empty array when none did. */
  swapDetails: (StudioEditSwapDetail & { nodeId: string })[]
  /**
   * mcp-tooling (WS-9's live-reload bridge) — every ABSOLUTE file path any
   * edit in the batch decoded a location in, whether or not that edit
   * ultimately wrote (a `css` edit's synthetic nodeId never decodes here —
   * see `studioEditFile` — so a stylesheet-only batch reports none). Not
   * "written" in the applied-count sense: `studio_apply_edits`'s caller maps
   * this to page ids for a best-effort live-reload push, and re-reading a
   * page whose edit happened to refuse is a harmless no-op, not a bug.
   */
  touchedFiles: string[]
}

/**
 * Apply a batch of typed studio edits to `dir`, exactly the way `POST
 * /admin/api/studio/save` does — ordering (bottom-to-top, so a line-count-
 * changing codemod can't invalidate another pending edit's location),
 * dedup (several board nodes can share one writeback target when they are
 * instances of the same inlined component), per-edit try/catch (one
 * codemod's refusal must not abort the rest of the batch), and line-count-
 * shift / shared-component detection.
 *
 * Single source of truth for "apply a batch of edits" — both the HTTP save
 * route and `studio_apply_edits` (MCP) call this, so there is exactly one
 * place that knows the ordering/dedup/shift rules.
 */
export function applyStudioEditBatch(dir: string, edits: readonly StudioEdit[]): StudioEditBatchResult {
  const ordered = orderStudioEditsForApply(dedupeStudioEdits(edits))
  const sharedComponents = edits.some((edit) => isSharedSourceNodeId(edit.nodeId, edit.kind))

  const touchedFiles = new Set<string>()
  for (const edit of ordered) {
    const file = studioEditFile(dir, edit.nodeId)
    if (file) touchedFiles.add(file)
  }
  const lineCountBefore = new Map<string, number>()
  for (const file of touchedFiles) {
    lineCountBefore.set(file, existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0)
  }

  let written = 0
  let skipped = 0
  const refusals: StudioEditRefusal[] = []
  const swapDetails: (StudioEditSwapDetail & { nodeId: string })[] = []
  for (const edit of ordered) {
    try {
      const outcome = applyStudioEdit(dir, edit)
      if (outcome.applied) {
        written += 1
        if (outcome.swapDetail) swapDetails.push({ nodeId: edit.nodeId, ...outcome.swapDetail })
      } else {
        skipped += 1
      }
    } catch (err) {
      if (err instanceof StudioEditRefusalError && isRefusingEditKind(edit.kind)) {
        refusals.push({ nodeId: edit.nodeId, kind: edit.kind, reason: err.reason, message: err.message })
      } else {
        console.error('[studio]', err)
      }
      skipped += 1
    }
  }

  let shifted = false
  for (const file of touchedFiles) {
    const after = existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0
    if (after !== lineCountBefore.get(file)) {
      shifted = true
      break
    }
  }

  return { written, skipped, shifted, sharedComponents, refusals, swapDetails, touchedFiles: [...touchedFiles] }
}
