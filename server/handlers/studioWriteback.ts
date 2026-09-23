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
 * 'delete' | 'insert' | 'duplicate' | 'wrap' | 'group' | 'ungroup' |
 * 'reparent' | 'transplant' | 'insert-slot' |
 * 'promote-component' | 'add-slot-prop' | 'css'`) lives in
 * `studioEditSchemas.ts` (split out for the
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
 *   - `studioStructuralWriteback.ts` — `move` / `delete` / `insert` /
 *     `duplicate` / `wrap` / `group` / `ungroup` / `reparent` / `transplant`.
 *     These change WHERE markup is: they
 *     take a second and sometimes a third location (an anchor sibling, a
 *     destination parent), they change the file's line count (invalidating
 *     every id below them, which is why `isSharedSourceNodeId` always reports
 *     them as shared), and each can refuse for reasons only the AST can see.
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
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  createImportPruneSession,
  detachComponentInstance,
  isPrunableSourceFile,
  setImportSpecifier,
  setJsxClassName,
  setJsxProp,
  JsxPropTargetError,
  setJsxStyle,
  JsxStyleTargetError,
  setJsxTagName,
  setJsxText,
  setStringLiteral,
  setStyledDeclaration,
  swapComponentInstance,
  type DeletedJsxText,
} from '@core/ast-codemods'
import type { SourceFingerprintExpectations } from '@core/page-tree'
import { applyCssEdit } from './studioCssWriteback'
import { withProjectWriteLock } from './studio/projectWriteLock'
import { relativeImportSpecifier, resolveClassNameTokens, resolveContainedRefPath } from './studioEditTargets'
import {
  applySlotEdit,
  isSlotPreviewOutcome,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail,
} from './studioSlotWriteback'
import { applyStructuralEdit, applyTransplantEdit } from './studioStructuralWriteback'
import { findMovedEdits, fingerprintAfterWrite } from './studioEditIdentity'
import { countLines, recordCreatedPosition, resolveCreatedNodeIds, type CreatedNodePosition } from './studioEditPositions'
import { projectThumbnailQueue } from './studio/projectThumbnailQueue'
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

// The ROUTING half — which file an edit lands in, and in what order a batch
// is applied. Its own module since this file passed the 700-line ceiling;
// re-exported here because this is the front door every caller already uses.
export {
  studioEditLocation,
  canonicalSourceRel,
  isWritableSourceRel,
  isSharedSourceNodeId,
  orderStudioEditsForApply,
  dedupeStudioEdits,
  studioEditFile,
  type StudioEditLocation,
} from './studioEditRouting'
import {
  dedupeStudioEdits,
  isSharedSourceNodeId,
  orderStudioEditsForApply,
  studioEditFile,
  studioEditLocation,
  type StudioEditLocation,
} from './studioEditRouting'

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

  const target = studioEditLocation(dir, edit.nodeId)
  if (!target) return { applied: false } // synthetic node (e.g. body) — no source location
  const loc = { file: join(dir, target.rel), line: target.line, col: target.col }

  switch (edit.kind) {
    case 'prop': {
      // WS-4.2/4.3 — a `studio.instance`'s call-site prop arrives as
      // `callSiteProps:<name>` (see `PropEditSchema`'s doc comment); the
      // actual JSX attribute is `<name>` at this SAME location (the instance
      // node's own id is the call site's own plain location).
      const prop = edit.prop.startsWith('callSiteProps:') ? edit.prop.slice('callSiteProps:'.length) : edit.prop
      try {
        setJsxProp({ ...loc, prop, value: edit.value })
      } catch (err) {
        // WB-11 — the attribute holds code, and a literal written over it would
        // delete the binding. A named decision, same channel as `style-target`.
        if (err instanceof JsxPropTargetError) throw new StudioEditRefusalError(err.reason, err.message)
        throw err
      }
      return { applied: true }
    }
    case 'text':
      setJsxText({ ...loc, text: edit.text })
      return { applied: true }
    case 'styled': {
      // W4-4 Phase B. `loc` is the `styled.…` TAG, not a JSX element — the
      // codemod re-finds the tagged template there and rewrites one
      // declaration's value span inside its own quasi. It RETURNS its
      // refusals (it is a leaf that knows nothing about this module), so they
      // are translated here into the one refusal channel every kind shares.
      const outcome = setStyledDeclaration({
        ...loc,
        className: edit.className,
        selector: edit.selector,
        property: edit.property,
        value: edit.value,
        ...(edit.atMedia ? { atMedia: edit.atMedia } : {}),
      })
      if (!outcome.ok) throw new StudioEditRefusalError(outcome.reason, outcome.message)
      // `changed: false` means the template already says exactly this — the
      // requested state IS the state on disk, so reporting a skip would toast
      // the user about a no-op (`applyCssEdit`'s `unset` precedent).
      return { applied: true }
    }
    case 'style':
      // `style-03` — `JsxStyleTargetError` is a NAMED decision (a spread, a
      // non-object initializer, a shorthand key), not an unexpected failure.
      // It used to fall into the generic catch and be reported as an
      // unexplained skip with the wrong sentence attached; it is a refusal,
      // and gets the same channel `class`/`css`/`detach`/`swap` use.
      try {
        setJsxStyle({ ...loc, style: edit.style, ...(edit.remove ? { remove: edit.remove } : {}) })
      } catch (err) {
        if (err instanceof JsxStyleTargetError) {
          throw new StudioEditRefusalError('style-target', err.message)
        }
        throw err
      }
      return { applied: true }
    case 'class': {
      // Track B2 — the real write behind Phase 0 item 0.6's honesty-only
      // stopgap. `setJsxClassName` returns a NAMED refusal (never throws)
      // for a `className` shape it can't safely rewrite — translated into
      // `StudioEditRefusalError` here, the same "leaf returns, dispatcher
      // throws" shape `applyCssEdit`'s `'css'` case already uses just above.
      //
      // `style-02` — a `module` token names a `*.module.css` by
      // workspace-relative path. That path arrives FROM THE CLIENT, so it
      // gets the same containment guard `asset` already applies, and is
      // turned into a relative specifier here (not in the codemod) so the
      // path decoder stays server-side and singular.
      const add = resolveClassNameTokens(dir, target.rel, edit.add)
      const remove = resolveClassNameTokens(dir, target.rel, edit.remove)
      if (add === null || remove === null) return { applied: false } // unsafe or missing stylesheet — refuse, never guess
      const result = setJsxClassName({ ...loc, add, remove })
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
      const assetPath = resolveContainedRefPath(dir, edit.assetPath)
      if (assetPath === null) return { applied: false } // unsafe or missing target — refuse, never guess
      const specifier = relativeImportSpecifier(target.rel, assetPath)
      setImportSpecifier({ ...loc, specifier })
      return { applied: true }
    }
    case 'tag':
      setJsxTagName({ ...loc, tag: edit.tag })
      return { applied: true }
    case 'transplant': {
      // D2 G3 — the ONE structural kind whose destination is deliberately in a
      // DIFFERENT file, so its ends are decoded WITHOUT the same-file filter
      // every other kind applies. They still go through `studioEditLocation`,
      // which is where the containment and app-source guards live, so a
      // hand-crafted `parentNodeId` still cannot name a file outside the
      // workspace or one that is not app source.
      //
      // The ANCHOR belongs to the destination's file, not the origin's: it
      // names an existing child of the container the element is landing in. A
      // foreign anchor is therefore dropped (append is an honest position),
      // exactly as `insert`/`reparent` treat theirs.
      const destination = studioEditLocation(dir, edit.parentNodeId)
      const anchorId = edit.anchorNodeId
      const anchor = anchorId ? studioEditLocation(dir, anchorId) : null
      const result = applyTransplantEdit(
        loc,
        edit,
        destination ? { file: join(dir, destination.rel), line: destination.line, col: destination.col } : null,
        anchor && destination && anchor.rel === destination.rel
          ? { file: join(dir, anchor.rel), line: anchor.line, col: anchor.col }
          : null,
      )
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      // `store-13`/`store-14` — a transplant writes markup into the
      // DESTINATION, so the position it reports is pinned to
      // `edit.parentNodeId`'s file, not to this edit's own.
      // `applyStudioEditBatch` reads `createdIn`/`relocatedIn` for that.
      return {
        applied: true,
        ...(result.created === undefined ? {} : { created: result.created, createdIn: edit.parentNodeId }),
        ...(result.relocated === undefined
          ? {}
          : { relocated: result.relocated, relocatedIn: edit.parentNodeId }),
      }
    }
    case 'move':
    case 'delete':
    case 'reinsert-source':
    case 'insert':
    case 'duplicate':
    case 'wrap':
    case 'group':
    case 'ungroup':
    case 'reparent': {
      // Every end decodes through the same guard, so a hand-crafted
      // `anchorNodeId`/`parentNodeId` cannot name a file outside the workspace
      // or a file that is not app source — and a cross-file anchor or
      // destination is dropped here rather than reaching a codemod that would
      // need an AST to notice. What each kind does with a missing one is
      // `applyStructuralEdit`'s call (a reparent refuses `cross-file`; an
      // insert appends).
      const anchorId = 'anchorNodeId' in edit ? edit.anchorNodeId : undefined
      const anchor = anchorId ? studioEditLocation(dir, anchorId) : null
      const parentId = 'parentNodeId' in edit ? edit.parentNodeId : undefined
      const destination = parentId ? studioEditLocation(dir, parentId) : null
      // K3 — a `group` names the REST of its run. Same decoder, same guard,
      // same same-file filter as the anchor above; `applyStructuralEdit`
      // refuses when the filter dropped any of them, because a group that
      // quietly wrapped the subset that happened to be in this file would be
      // a write the user never asked for.
      const siblings = ('siblingNodeIds' in edit ? edit.siblingNodeIds : [])
        .map((nodeId) => studioEditLocation(dir, nodeId))
        .filter((location): location is StudioEditLocation => location !== null && location.rel === target.rel)
      const result = applyStructuralEdit(
        loc,
        edit,
        anchor && anchor.rel === target.rel ? anchor : null,
        destination && destination.rel === target.rel ? destination : null,
        // The workspace-relative path of the file being written — what a
        // `designSystemImport` needs to become a real relative specifier. It
        // comes from the SAME decoder every other path here goes through, so
        // it inherits `studioEditLocation`'s containment guard.
        target.rel,
        siblings,
      )
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      // `store-13`/`store-14` — `created`/`relocated` ride straight through;
      // only the kinds that make or move markup set them, and
      // `applyStudioEditBatch` is what turns a position into a node id (it
      // alone knows the batch's final line count).
      return {
        applied: true,
        ...(result.created === undefined ? {} : { created: result.created }),
        ...(result.relocated === undefined ? {} : { relocated: result.relocated }),
        ...(result.removed === undefined ? {} : { removed: result.removed }),
      }
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
      const anchor = anchorId ? studioEditLocation(dir, anchorId) : null
      const result = applySlotEdit(loc, edit, anchor && anchor.rel === target.rel ? anchor : null, dir, target.rel)
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
 *
 * `expect` (P1-A) is the identity the caller recorded for each node id its
 * edits name. An edit naming an id whose position now holds something else
 * refuses `element-moved` before any codemod runs — see `studioEditIdentity.ts`.
 */
export function applyStudioEditBatch(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations = {},
): StudioEditBatchResult {
  const ordered = orderStudioEditsForApply(dedupeStudioEdits(dir, edits))
  // P1-A — which edits name a position whose element is not the one the client
  // read. Decided against the files as they stand BEFORE this batch writes a
  // byte, and those edits never reach a codemod. See `studioEditIdentity.ts`.
  const moved = findMovedEdits(dir, ordered, expect)
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
    // D2 G3 — a transplant writes TWO files, and only the origin is named by
    // `edit.nodeId`. The destination has to be in this set or the batch's
    // line-count-shift check would report `shifted: false` for a write that
    // moved every id in the file the element landed in.
    if (edit.kind === 'transplant') {
      const destination = studioEditFile(dir, edit.parentNodeId)
      if (destination) touchedFiles.add(destination)
    }
  }
  const lineCountBefore = new Map<string, number>()
  for (const file of touchedFiles) {
    lineCountBefore.set(file, countLines(file))
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
  // `store-15` — the workspace-relative `rel` for every file `referencedBefore`
  // snapshots, so the prune pass below can report `prunedImports` in the same
  // path shape every other per-file field on this result uses (never the
  // absolute path `studioEditFile` resolves internally).
  const relByFile = new Map<string, string>()
  for (const edit of ordered) {
    // D2 G3 — a transplant that MOVES (not copies) removes markup from the
    // origin file exactly as a delete does, so it can orphan an import there
    // in exactly the same way. The DESTINATION is deliberately not snapshotted:
    // the codemod just added imports to it, and pruning a binding that has no
    // reference yet at snapshot time would delete the one it wrote.
    // `store-14` — an `ungroup` joined the list: dissolving a container can be
    // the last use of the binding that named it, and leaving that import
    // behind is a `noUnusedLocals` build failure in the user's repo. It is
    // also what makes ⌘G → ⌘Z byte-exact: the group wrote the import, so its
    // undo has to take it back out.
    const removesMarkup =
      edit.kind === 'delete' ||
      edit.kind === 'ungroup' ||
      (edit.kind === 'transplant' && edit.copy !== true)
    if (!removesMarkup) continue
    const file = studioEditFile(dir, edit.nodeId)
    if (!file || referencedBefore.has(file)) continue
    if (isPrunableSourceFile(file) && existsSync(file)) {
      referencedBefore.set(file, importPrune.snapshot(file))
      const rel = studioEditLocation(dir, edit.nodeId)?.rel
      if (rel) relByFile.set(file, rel)
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
  // `store-13` — where each created element sat, measured from the END of its
  // file. See `resolveCreatedNodeIds` for why that anchor and not the line.
  const createdPositions: CreatedNodePosition[] = []
  // `store-14` — the same, for the elements a batch MOVED rather than made.
  const relocatedPositions: CreatedNodePosition[] = []
  // `store-15` — every `delete` edit's own discarded bytes, keyed by the
  // edit's own `nodeId` so a caller can pair a `removed` entry with the edit
  // that produced it.
  const removed: (DeletedJsxText & { nodeId: string })[] = []
  const fingerprints: { nodeId: string; fingerprint: string }[] = []
  for (const edit of ordered) {
    const movedRefusal = moved.get(edit)
    if (movedRefusal) {
      refusals.push(movedRefusal)
      skipped += 1
      continue
    }
    try {
      const outcome = applyStudioEdit(dir, edit)
      if (outcome.addSlotPropDetail) addSlotPropDetails.push({ nodeId: edit.nodeId, ...outcome.addSlotPropDetail })
      if (isSlotPreviewOutcome(outcome)) {
        // E2.2 — a deliberate `add-slot-prop` preview: `ok`, nothing written,
        // not a failure. Neither counter moves; `addSlotPropDetails` above
        // already carries the blast radius the caller asked to see.
      } else if (outcome.applied) {
        written += 1
        if (outcome.created) recordCreatedPosition(createdPositions, dir, outcome.createdIn ?? edit.nodeId, outcome.created)
        for (const relocated of outcome.relocated ?? []) {
          recordCreatedPosition(relocatedPositions, dir, outcome.relocatedIn ?? edit.nodeId, relocated)
        }
        if (outcome.swapDetail) swapDetails.push({ nodeId: edit.nodeId, ...outcome.swapDetail })
        if (outcome.createdStylesheet) createdStylesheets.push({ nodeId: edit.nodeId, ...outcome.createdStylesheet })
        if (outcome.promoteDetail) promoteDetails.push({ nodeId: edit.nodeId, ...outcome.promoteDetail })
        if (outcome.removed) removed.push({ nodeId: edit.nodeId, ...outcome.removed })
        const identity = fingerprintAfterWrite(dir, edit)
        if (identity) fingerprints.push(identity)
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
  const prunedImports: { file: string; declarations: string[] }[] = []
  for (const [file, wasReferenced] of referencedBefore) {
    if (!existsSync(file)) continue
    const pruned = importPrune.prune(file, wasReferenced)
    const rel = relByFile.get(file)
    if (rel && pruned.declarations.length > 0) prunedImports.push({ file: rel, declarations: [...pruned.declarations] })
  }

  let shifted = false
  const lineCountAfter = new Map<string, number>()
  for (const file of touchedFiles) {
    const after = countLines(file)
    lineCountAfter.set(file, after)
    if (after !== lineCountBefore.get(file)) shifted = true
  }

  // W7-3 — the project's launcher preview is now out of date. Debounced and
  // fire-and-forget: `refreshAfterSave` returns immediately and the capture
  // happens ~15s after the last write in this project, so an editing burst
  // costs one screenshot rather than one per keystroke-driven save. Hooked
  // HERE rather than on the `/save` route because this function is the single
  // engine BOTH the route and the MCP `studio_apply_edits` tool run through —
  // and the agent's writes are the ones most likely to change what a screen
  // looks like.
  if (written > 0) projectThumbnailQueue.refreshAfterSave(dir)

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
    removed,
    prunedImports,
    fingerprints,
    createdNodeIds: resolveCreatedNodeIds(createdPositions, lineCountAfter),
    relocatedNodeIds: resolveCreatedNodeIds(relocatedPositions, lineCountAfter),
  }
}

/**
 * {@link applyStudioEditBatch}, serialized against every other writer of this
 * project — **the entry every production caller uses**. The `/admin/api/studio/save`
 * route and the MCP `studio_apply_edits` tool both come through here; the
 * synchronous engine above stays exported for tests, which drive it directly
 * against a temp directory with nothing else running.
 *
 * The lock matters even though the engine is synchronous and therefore atomic
 * on its own: an async git verb holds the lock across several subprocesses,
 * and without waiting here a save would land *between* `git add` and
 * `git commit` and put content nobody reviewed into the commit. See
 * `projectWriteLock.ts`.
 *
 * No `waitMs`: a save waits as long as it has to. The user's alternative to
 * waiting is losing the edit.
 *
 * `studioCssWriteback.ts`'s `applyCssEdit` needs no lock of its own — the
 * batch above is its only caller, so a `css` edit is already inside this one.
 */
export function applyStudioEditBatchLocked(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations = {},
): Promise<StudioEditBatchResult> {
  return withProjectWriteLock(dir, () => applyStudioEditBatch(dir, edits, expect))
}
