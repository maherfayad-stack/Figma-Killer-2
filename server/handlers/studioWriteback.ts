/**
 * studioWriteback — the pure dir+edit→codemod DISPATCH BEHAVIOUR that `POST
 * /admin/api/studio/save` (`server/handlers/studio.ts`) runs per edit (Phase
 * 3, Slice B). Split out of `studio.ts` because this is one coherent unit —
 * the ordering rule and the dispatcher exist to serve the same "batch of
 * typed source writebacks" contract — and it's independently unit-testable
 * against temp fixture files without a full Request/Response round trip.
 *
 * The WIRE SHAPE (`StudioEditSchema`/`StudioEdit` — `kind: 'prop' | 'text' |
 * 'style' | 'class' | 'literal' | 'tag' | 'asset' | 'detach' | 'swap' | 'move' |
 * 'delete' | 'insert' | 'insert-slot' | 'promote-component' | 'add-slot-prop' |
 * 'css'`) lives in `studioEditSchemas.ts` (split out for the
 * `module-size-budgets` ceiling) and is re-exported below verbatim, so every
 * existing consumer's import path is unchanged.
 *
 * This module dispatches the VALUE kinds, which all share one shape: decode
 * the `nodeId` back to a `rel:line:col`, path-guard it, and hand it to the
 * matching `ast-codemods` writer (`setJsxProp` / `setJsxText` / `setJsxStyle`
 * / `setJsxClassName` / `setStringLiteral` / `setJsxTagName` /
 * `setImportSpecifier`) — a rewrite in place that leaves the file's line
 * count alone. Three SIBLINGS own the kinds that do not fit that shape, and
 * every dependency runs one way (this module calls in; none import back):
 *
 *   - `studioCssWriteback.ts` — `css`. Its target is a FILE + SELECTOR rather
 *     than a decoded `line:col`, and it writes through a postcss CST.
 *   - `studioStructuralWriteback.ts` — `move` / `delete` / `insert`. These
 *     change WHERE markup is: they take a second location (an anchor sibling),
 *     they change the file's line count (invalidating every id below them,
 *     which is why `isSharedSourceNodeId` always reports them as shared), and
 *     each can refuse for reasons only the AST can see.
 *   - `studioSlotWriteback.ts` (E2.4/E2.2) — `insert-slot` / `promote-component`
 *     / `add-slot-prop`. `insert-slot` writes into a component PROP rather
 *     than a child list or an existing attribute's scalar; `promote-component`
 *     mints a whole new component FILE; `add-slot-prop` rewrites an EXISTING
 *     component's own signature. All three always change a touched file's
 *     line count WHEN THEY WRITE — `add-slot-prop`'s `preview: true` case is
 *     the one outcome in this whole module that can be `ok` and yet touch no
 *     file at all (see `applyStudioEdit`'s dispatch case and
 *     `applyStudioEditBatch`'s counting loop, both below).
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
  createImportPruneSession,
  detachComponentInstance,
  isPrunableSourceFile,
  setImportSpecifier,
  setJsxClassName,
  setJsxProp,
  setJsxStyle,
  setJsxTagName,
  setJsxText,
  setStringLiteral,
  swapComponentInstance,
} from '@core/ast-codemods'
import { applyCssEdit } from './studioCssWriteback'
import {
  applySlotEdit,
  isSlotEditKind,
  isSlotPreviewOutcome,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail,
} from './studioSlotWriteback'
import { applyStructuralEdit, isStructuralEditKind } from './studioStructuralWriteback'
import {
  isRefusingEditKind,
  type StudioEdit,
  type StudioEditApplyOutcome,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail,
  type StudioEditUnexplainedSkip,
} from './studioEditSchemas'

export {
  StudioEditSchema,
  type StudioEdit,
  type StudioEditApplyOutcome,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail,
  type StudioEditUnexplainedSkip,
} from './studioEditSchemas'

const NODE_LOC_ID = /^(.*):(\d+):(\d+)$/

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
 *
 * Exported (not just used internally) so `studio/reloadScope.ts` (Track C5)
 * can apply the SAME adversarial-path guard to the `files` list a reload-scope
 * request round-trips back to the server, rather than a second, parallel
 * check that could drift from this one.
 */
export function isWritableSourceRel(rel: string): boolean {
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
 *
 * E2.4/E2.2 — `insert-slot`/`promote-component`/`add-slot-prop` join them too:
 * filling a slot with a multi-line subtree, pulling one out into its own
 * file, and rewriting an existing component's own signature all change a
 * touched file's line count exactly like the structural three — WHEN they
 * write. A `preview: true` `add-slot-prop` writes nothing, but this function
 * only sees `kind`, not the edit's own `preview` flag, so it still reports
 * `true` for one; `applyStudioEditBatch`'s `written`-gated reload (see
 * `docs/features/studio-import.md`'s "A save only reloads when a write
 * actually landed") is what keeps a preview-only batch from reloading
 * anything despite this.
 */
export function isSharedSourceNodeId(nodeId: string, kind?: StudioEdit['kind']): boolean {
  if (kind === 'asset' || kind === 'detach' || kind === 'swap') return true
  if (kind !== undefined && (isStructuralEditKind(kind) || isSlotEditKind(kind))) return true
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
 *
 * ## Why `insert` and `insert-slot` are exempt
 *
 * Every other kind OVERWRITES the span its nodeId points at, so two of them on
 * one location are the same write twice and last-one-wins is the honest
 * reading. `insert` does not overwrite anything: its nodeId names the
 * CONTAINER, and the edit ADDS a child to it. Two inserts against one container
 * are therefore two different, both-wanted elements, not a duplicate — and
 * collapsing them silently dropped all but the last, so composing a screen one
 * batch at a time quietly produced a single child no matter how many were
 * asked for, with `written` reporting the truth and nothing reporting the loss.
 *
 * `insert-slot` (E2.4) is the identical shape one level down: its `nodeId`
 * names the CALL SITE, not one attribute — filling `header` AND `footer` on
 * the same call site in one batch is two different, both-wanted slots, not a
 * duplicate. The dedup key below only distinguishes by the field name `prop`
 * (`PropEditSchema`'s own field, not `insert-slot`'s `propName`), so without
 * this exemption two DIFFERENT slot fills on one call site would collapse to
 * whichever the batch listed first.
 */
export function dedupeStudioEdits<T extends { nodeId: string; kind: string }>(edits: readonly T[]): T[] {
  const byTarget = new Map<string, T>()
  const passthrough: T[] = []
  for (const edit of edits) {
    const loc = studioEditLocation(edit.nodeId)
    if (!loc || edit.kind === 'insert' || edit.kind === 'insert-slot') {
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
 *
 * `StudioEditSwapDetail`/`StudioEditApplyOutcome` (this function's own return
 * shape) now live in `studioEditSchemas.ts`, alongside every other RESPONSE
 * type this module builds and returns — see that module's own doc for why.
 */
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
    return {
      applied: outcome.applied,
      ...(outcome.createdStylesheet ? { createdStylesheet: outcome.createdStylesheet } : {}),
    }
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
    case 'class': {
      // Track B2 — the real write behind Phase 0 item 0.6's honesty-only
      // stopgap. `setJsxClassName` returns a NAMED refusal (never throws)
      // for a `className` shape it can't safely rewrite — translated into
      // `StudioEditRefusalError` here, the same "leaf returns, dispatcher
      // throws" shape `applyCssEdit`'s `'css'` case already uses just above.
      const result = setJsxClassName({ ...loc, add: edit.add, remove: edit.remove })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true }
    }
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
    case 'insert-slot':
    case 'promote-component':
    case 'add-slot-prop': {
      // E2.4/E2.2. `insert-slot`'s optional `anchorNodeId` is only meaningful
      // for its `children` delegation; `add-slot-prop` never has one (see
      // `studioSlotWriteback.ts`'s own doc) — same cross-file guard
      // `move`/`insert` already apply above.
      const anchorId = 'anchorNodeId' in edit ? edit.anchorNodeId : undefined
      const anchor = anchorId ? studioEditLocation(anchorId) : null
      const result = applySlotEdit(loc, edit, anchor && anchor.rel === target.rel ? anchor : null, dir)
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      // `applied` reads straight from the codemod's own answer (E2.2 — a
      // `preview: true` add-slot-prop is `applied: false` here, on purpose;
      // see `applyStudioEditBatch`'s loop for what that means for the
      // written/skipped counters).
      return {
        applied: result.applied,
        ...(result.promoteDetail ? { promoteDetail: result.promoteDetail } : {}),
        ...(result.addSlotPropDetail ? { addSlotPropDetail: result.addSlotPropDetail } : {}),
      }
    }
  }
}

/**
 * `StudioEditRefusal`, `isRefusingEditKind`, `StudioEditUnexplainedSkip`, and
 * `StudioEditBatchResult` (this function's own return shape, below) now live
 * in `studioEditSchemas.ts` alongside every other RESPONSE type this module
 * builds and returns — see that module's own doc for why.
 *
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
    // A `css`/`create` edit's nodeId never decodes (it's synthetic), but the
    // edit itself rewrites `pageFile`'s import list — a real line-count
    // change downstream code needs to see, exactly like every OTHER kind's
    // decoded location. Added explicitly rather than through
    // `studioEditFile` because this kind's write target is a FILE +
    // SELECTOR pair, never a `rel:line:col` (see `CssEditSchema`'s doc).
    if (edit.kind === 'css' && edit.op === 'create') touchedFiles.add(join(dir, edit.pageFile))
  }
  const lineCountBefore = new Map<string, number>()
  for (const file of touchedFiles) {
    lineCountBefore.set(file, existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0)
  }

  // Which import bindings each file a DELETE touches references before anything
  // is written. Removing markup can be the last use of an import, and under
  // `noUnusedLocals` leaving that behind is a build failure — so the binding
  // has to go too. Snapshotted here, and pruned after the loop, because an
  // import lives at the TOP of a file: cutting its line mid-batch would shift
  // the pending `line:col` of every edit still queued below it, which is the
  // exact hazard `orderStudioEditsForApply` exists to prevent. Waiting also
  // makes the question answerable at all — a binding used by two elements
  // deleted in the same batch is orphaned by neither one alone.
  //
  // Scoped to batches that actually delete something, and to the files those
  // deletes name. Every other kind either cannot drop the last reference to a
  // binding or already retires its own (`swap`/`detach`, and
  // `insertJsxIntoSlotProp` for a slot replace), and this pass costs two extra
  // parses per file — not something to spend on every keystroke-driven save.
  const importPrune = createImportPruneSession()
  const referencedBefore = new Map<string, ReadonlySet<string>>()
  for (const edit of ordered) {
    if (edit.kind !== 'delete') continue
    const file = studioEditFile(dir, edit.nodeId)
    if (!file || referencedBefore.has(file)) continue
    if (isPrunableSourceFile(file) && existsSync(file)) {
      referencedBefore.set(file, importPrune.snapshot(file))
    }
  }

  let written = 0
  let skipped = 0
  const refusals: StudioEditRefusal[] = []
  const swapDetails: (StudioEditSwapDetail & { nodeId: string })[] = []
  const createdStylesheets: { nodeId: string; file: string }[] = []
  const promoteDetails: (StudioPromoteComponentDetail & { nodeId: string })[] = []
  const addSlotPropDetails: (StudioAddSlotPropDetail & { nodeId: string })[] = []
  const unexplainedSkips: StudioEditUnexplainedSkip[] = []
  for (const edit of ordered) {
    try {
      const outcome = applyStudioEdit(dir, edit)
      if (outcome.addSlotPropDetail) addSlotPropDetails.push({ nodeId: edit.nodeId, ...outcome.addSlotPropDetail })
      if (isSlotPreviewOutcome(outcome)) {
        // E2.2 — a deliberate `add-slot-prop` preview: `ok`, nothing written,
        // not a failure. Neither counter moves; `addSlotPropDetails` above
        // already carries the blast radius the caller asked to see.
      } else if (outcome.applied) {
        written += 1
        if (outcome.swapDetail) swapDetails.push({ nodeId: edit.nodeId, ...outcome.swapDetail })
        if (outcome.createdStylesheet) createdStylesheets.push({ nodeId: edit.nodeId, ...outcome.createdStylesheet })
        if (outcome.promoteDetail) promoteDetails.push({ nodeId: edit.nodeId, ...outcome.promoteDetail })
      } else {
        skipped += 1
        unexplainedSkips.push({ nodeId: edit.nodeId, kind: edit.kind })
      }
    } catch (err) {
      if (err instanceof StudioEditRefusalError && isRefusingEditKind(edit.kind)) {
        refusals.push({ nodeId: edit.nodeId, kind: edit.kind, reason: err.reason, message: err.message })
      } else {
        console.error('[studio]', err)
        unexplainedSkips.push({ nodeId: edit.nodeId, kind: edit.kind })
      }
      skipped += 1
    }
  }

  // Only a binding that was live BEFORE and is dead AFTER — an import the user
  // had already left unused is their line, not something this batch created.
  for (const [file, wasReferenced] of referencedBefore) {
    if (existsSync(file)) importPrune.prune(file, wasReferenced)
  }

  let shifted = false
  for (const file of touchedFiles) {
    const after = existsSync(file) ? readFileSync(file, 'utf8').split('\n').length : 0
    if (after !== lineCountBefore.get(file)) {
      shifted = true
      break
    }
  }

  return {
    written,
    skipped,
    shifted,
    sharedComponents,
    refusals,
    swapDetails,
    createdStylesheets,
    promoteDetails,
    addSlotPropDetails,
    unexplainedSkips,
    touchedFiles: [...touchedFiles],
  }
}
