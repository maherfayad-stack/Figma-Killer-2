/**
 * studioWriteback — the pure dir+edit→codemod DISPATCH BEHAVIOUR that `POST
 * /admin/api/studio/save` (`server/handlers/studio.ts`) runs per edit (Phase
 * 3, Slice B). Split out of `studio.ts` because this is one coherent unit —
 * the ordering rule and the dispatcher exist to serve the same "batch of
 * typed source writebacks" contract — and it's independently unit-testable
 * against temp fixture files without a full Request/Response round trip.
 *
 * The WIRE SHAPE (`StudioEditSchema`/`StudioEdit` — `kind: 'prop' | 'text' |
 * 'style' | 'class' | 'literal' | 'tag' | 'asset' | 'svg-attr' | 'detach' | 'expose-prop' | 'swap' | 'restore' | 'move' |
 * 'delete' | 'insert' | 'duplicate' | 'wrap' | 'group' | 'ungroup' |
 * 'reparent' | 'transplant' | 'insert-slot' |
 * 'promote-component' | 'add-slot-prop' | 'add-variant' | 'remove-variant' |
 * 'add-component-prop' | 'css'`) lives in
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
 *     `duplicate` / `wrap` / `group` / `ungroup` / `reparent` / `transplant`,
 *     entered through `studioStructuralDispatch.ts`, which decodes their extra
 *     ends.
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
 * write nothing. The save route applies each edit independently — one codemod
 * declining (e.g. a text edit landing on an element with mixed children) is
 * reported as that edit's named refusal rather than aborting the whole batch,
 * and every edit that does not write is named (WB-12, `studioEditRefusals.ts`).
 */
import {
  createModuleImportPlan,
  createProject,
  
  
  
  
  
  
  
  
  
  
  
  
  syncProjectWithDisk } from '@core/ast-codemods'
import { type SourceFingerprintExpectations, type StyleLanding } from '@core/page-tree'
import type { } from 'ts-morph'
import type { PastedHtmlSummary } from './studioPastedHtmlStyles'
import { withProjectWriteLock } from './studio/projectWriteLock'
import { snapshotImportsBeforeRemoval } from './studioBatchImportPrune'
import { dematerializeDesignSystem, materializeDesignSystem, namesDesignSystemImport } from './studio/designSystemMaterialize'
import { openBatchUndoJournal, RESTYLE_ROLLED_BACK_REASON } from './studioBatchUndoJournal'
import {
  
  isSlotPreviewOutcome,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail } from './studioSlotWriteback'
import { createCanvasLayerScope } from './studioCanvasLayerScope'
import { createSyntaxGuard } from './studioSyntaxGuard'
import { expandMergedOutcomes } from './studioEditMerge'
import { fingerprintAfterWrite, resolveEditIdentities } from './studioEditIdentity'
import { rememberSourceTexts } from './studio/sourceTextHistory'
import { countLines, recordCreatedPosition, resolveCreatedNodeIds, type CreatedNodePosition } from './studioEditPositions'
import { projectThumbnailQueue } from './studio/projectThumbnailQueue'
import {
  type StudioCarriedDeclaration,
  type StudioEdit,
  
  type StudioEditBatchOptions,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail,
  type StudioDetachDetail } from './studioEditSchemas'
import {
  refusalFor,
  refusalForUnwritable,
  
  StudioEditRefusalError,
  WRITE_FAILED_REASON,
  writeFailedRefusal } from './studioEditRefusals'

export {
  StudioEditSchema,
  type StudioEdit,
  type StudioEditApplyOutcome,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail } from './studioEditSchemas'
export { StudioEditRefusalError } from './studioEditRefusals'
export { applyStudioEdit, type StudioEditBatchContext } from './studioEditApply'
import { applyStudioEdit } from './studioEditApply'

// The ROUTING half — which file an edit lands in, and in what order a batch
// is applied. Its own module since this file passed the 700-line ceiling;
// re-exported here because this is the front door every caller already uses.
export { canonicalSourceRel, isWritableSourceRel } from './studioEditRouting'
export { studioEditLocation, isSharedSourceNodeId, orderStudioEditsForApply, dedupeStudioEdits, studioEditFile, type StudioEditLocation }
import {
  
  dedupeStudioEdits,
  isSharedSourceNodeId,
  orderStudioEditsForApply,
  studioEditFile,
  studioEditLocation,
  studioEditsTouchedFiles,
  type SourceTargetScope,
  type StudioEditLocation } from './studioEditRouting'

/**
 * `StudioEditRefusal` and `StudioEditBatchResult` (this function's own return
 * shape, below) live
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
 * edits name. An edit naming an id whose position now holds something else is
 * re-found in its changed file and written THERE (P1-D, reported in
 * `retargeted`), or — when it cannot be found exactly once — refuses
 * `element-moved` before any codemod runs. See `studioEditIdentity.ts`.
 * Every outcome is reported under the id the caller SENT, so a caller pairs
 * results with its own edits whether or not they were re-found.
 */
export function applyStudioEditBatch(
  dir: string,
  edits: readonly StudioEdit[],
  expect: SourceFingerprintExpectations = {},
  options: StudioEditBatchOptions = {},
): StudioEditBatchResult {
  // P1-A/P1-D — which edits still name the element the client read, which name
  // one that moved within its changed file (re-addressed to where it is now),
  // and which cannot be found exactly once (refused, never reaching a
  // codemod). Decided against the files as they stand BEFORE this batch writes
  // a byte, and before ordering — a re-addressed edit sorts by where it will
  // actually write. See `studioEditIdentity.ts`.
  // FC-1 — the ONE place a non-default scope is chosen (layers: the editor's `/save` only).
  const scope: SourceTargetScope = { canvasLayers: options.canvasLayers }
  // Only NAMES a layer target so an agent's refusal says why; nothing writes through it.
  const identifyLayerTarget = (nodeId: string) => studioEditLocation(dir, nodeId, { canvasLayers: 'allow' })
  // WB-25 — one ts-morph project for the whole batch; see `StudioEditBatchContext`.
  const project = createProject()
  const identity = resolveEditIdentities(dir, edits, expect, project, scope)
  const ordered = orderStudioEditsForApply(dedupeStudioEdits(dir, identity.runnable, scope))
  const sharedComponents = edits.some((edit) => isSharedSourceNodeId(edit.nodeId, edit.kind))

  // A refused edit's file is still reported: the caller re-reads exactly these
  // to recover from an `element-moved` refusal.
  const touchedFiles = studioEditsTouchedFiles(dir, [...ordered, ...identity.moved.map((entry) => entry.edit)], scope)
  // P3-F — before any byte is written: a one-shot write's pre-image, and a restore's own files.
  // The first design-system insert into a project without the folder brings the
  // folder with it, so the import it writes resolves; the same batch's undo removes both.
  const designSystemCreated = ordered.some(namesDesignSystemImport) && materializeDesignSystem(dir)
  const journal = openBatchUndoJournal(dir, edits, touchedFiles, options, designSystemCreated)
  const lineCountBefore = new Map<string, number>()
  for (const file of touchedFiles) {
    lineCountBefore.set(file, countLines(file))
  }

  // Which import bindings the files a batch REMOVES markup from reference
  // before anything is written — pruned after the loop (`studioBatchImportPrune.ts`).
  const importPrune = snapshotImportsBeforeRemoval(dir, ordered, scope)

  let written = 0
  const refusals: StudioEditRefusal[] = identity.moved.map((entry) => entry.refusal)
  const swapDetails: (StudioEditSwapDetail & { nodeId: string })[] = []
  const detachDetails: (StudioDetachDetail & { nodeId: string })[] = []
  const createdStylesheets: { nodeId: string; file: string }[] = []
  const styleLandings: StyleLanding[] = []
  const promoteDetails: (StudioPromoteComponentDetail & { nodeId: string })[] = []
  const addSlotPropDetails: (StudioAddSlotPropDetail & { nodeId: string })[] = []
  // `store-13` — where each created element sat, measured from the END of its
  // file. See `resolveCreatedNodeIds` for why that anchor and not the line.
  const createdPositions: CreatedNodePosition[] = []
  // `store-14` — the same, for the elements a batch MOVED rather than made.
  const relocatedPositions: CreatedNodePosition[] = []
  // P5-G — every `canvas-layer-delete`'s module bytes, keyed by the edit's own `nodeId`.
  const removed: StudioEditBatchResult['removed'] = []
  // G-1 — what each landed `transplant` copied to its destination.
  const carried: StudioCarriedDeclaration[] = []
  // G-10 - where each pasted HTML fragment's styles went.
  const pastedHtml: PastedHtmlSummary[] = []
  // OD-8 — each written `list-item` edit's array, pinned from the file's end.
  const listArrayPositions: { nodeId: string; position: CreatedNodePosition[] }[] = []
  // WB-24 — no edit writes into a file that does not parse (`studioSyntaxGuard.ts`).
  const syntaxRefusal = createSyntaxGuard(dir, scope)
  const canvasLayerScope = createCanvasLayerScope(options.canvasLayers, identifyLayerTarget) // P5-G — agents never write loose layers
  const fingerprints: { nodeId: string; fingerprint: string }[] = []
  // P3-C (WB-18) — CSS-Module imports the class edits below reserve, added
  // after the loop for the same reason the import prune runs there.
  const moduleImports = createModuleImportPlan()
  for (const edit of ordered) {
    const brokenTarget = canvasLayerScope(edit) ?? journal.refuse(edit) ?? syntaxRefusal(edit)
    if (brokenTarget) {
      refusals.push(brokenTarget)
      continue
    }
    syncProjectWithDisk(project)
    try {
      const outcome = applyStudioEdit(dir, edit, { moduleImports, project, scope })
      if (outcome.addSlotPropDetail) addSlotPropDetails.push({ nodeId: edit.nodeId, ...outcome.addSlotPropDetail })
      if (outcome.detachDetail) detachDetails.push({ nodeId: edit.nodeId, ...outcome.detachDetail })
      if (isSlotPreviewOutcome(outcome) || outcome.detachDetail?.written === false) {
        // E2.2 — a deliberate `add-slot-prop` preview: `ok`, nothing written,
        // not a failure. Neither counter moves; `addSlotPropDetails` above
        // already carries the blast radius the caller asked to see.
      } else if (outcome.applied) {
        written += 1
        for (const created of outcome.created ?? []) {
          recordCreatedPosition(createdPositions, dir, outcome.createdIn ?? edit.nodeId, created, scope)
        }
        for (const relocated of outcome.relocated ?? []) {
          recordCreatedPosition(relocatedPositions, dir, outcome.relocatedIn ?? edit.nodeId, relocated, scope)
        }
        if (outcome.swapDetail) swapDetails.push({ nodeId: edit.nodeId, ...outcome.swapDetail })
        if (outcome.createdStylesheet) createdStylesheets.push({ nodeId: edit.nodeId, ...outcome.createdStylesheet })
        if (outcome.styleLanding) styleLandings.push({ nodeId: edit.nodeId, ...outcome.styleLanding })
        if (outcome.promoteDetail) promoteDetails.push({ nodeId: edit.nodeId, ...outcome.promoteDetail })
        for (const text of outcome.removed ?? []) removed.push({ nodeId: edit.nodeId, ...text })
        for (const entry of outcome.carried ?? []) carried.push({ name: entry.name, as: entry.as, how: entry.how })
        if (outcome.pastedHtml) pastedHtml.push(outcome.pastedHtml)
        const array = edit.kind === 'list-item' ? studioEditLocation(dir, edit.nodeId, scope) : null
        if (array) {
          const position: CreatedNodePosition[] = []
          recordCreatedPosition(position, dir, edit.nodeId, array, scope)
          listArrayPositions.push({ nodeId: edit.nodeId, position })
        }
        const identity = fingerprintAfterWrite(dir, edit, project, scope)
        if (identity) fingerprints.push(identity)
      } else {
        refusals.push(refusalForUnwritable(edit, outcome))
      }
    } catch (err) {
      if (err instanceof StudioEditRefusalError) {
        refusals.push(refusalFor(edit, err.reason, err.message))
      } else {
        console.error('[studio]', err)
        refusals.push(writeFailedRefusal(edit))
      }
    }
  }
  // WB-7 — an edit several nodes collapsed into reports its outcome for each of them.
  expandMergedOutcomes(ordered, refusals)

  // Every edit has landed, so an import line can no longer move a pending one.
  // A failed import is one the written markup already reads, so each class
  // edit in that file says so rather than reporting a clean write.
  for (const { file, imports } of moduleImports.apply().failed) {
    for (const edit of ordered) {
      if (edit.kind !== 'class' || studioEditFile(dir, edit.nodeId, scope) !== file) continue
      refusals.push(
        refusalFor(
          edit,
          WRITE_FAILED_REASON,
          `The class was written, but Studio could not add ${imports.join('; ')} to the file. Add it by hand.`,
        ),
      )
    }
  }

  importPrune.prune()
  // CT-5 - a restyle that refused anywhere writes nothing at all: files back to
  // the pre-image, the stylesheet it created removed. The edits that DID run are
  // reported as rolled back, after the real refusals, so `skipped` still counts
  // every edit that did not land.
  const createdFiles = [...promoteDetails.map((detail) => detail.newFile), ...createdStylesheets.map((created) => created.file)]
  const rolledBack = journal.rollbackRestyle(refusals.length > 0, createdFiles)
  if (rolledBack) {
    const refused = new Set(refusals.map((refusal) => `${refusal.kind}|${refusal.nodeId}`))
    for (const edit of ordered) {
      if (refused.has(`${edit.kind}|${edit.nodeId}`)) continue
      refusals.push(refusalFor(edit, RESTYLE_ROLLED_BACK_REASON, 'Another part of this style change was refused, so none of it was written.'))
    }
    written = 0
    createdStylesheets.length = 0
    fingerprints.length = 0
    swapDetails.length = 0
    detachDetails.length = 0
  }
  // P3-F — after the prune and the module imports: the entry is what the files are NOW.
  // A stylesheet a `css`/`create` edit invented did not exist before the batch: recorded as such, so a restore removes it with the import it needed.
  const undoToken = rolledBack ? undefined : journal.commit(written, createdFiles, styleLandings)
  // Nothing landed, so the project must not be left carrying a design system nobody asked for.
  if (designSystemCreated && (written === 0 || rolledBack)) dematerializeDesignSystem(dir)

  // A re-found edit means the caller's ids for its file were already stale
  // before this batch wrote anything — `shifted` is how every caller learns
  // to re-read them.
  let shifted = identity.retargeted.length > 0
  const lineCountAfter = new Map<string, number>()
  for (const file of touchedFiles) {
    const after = countLines(file)
    lineCountAfter.set(file, after)
    if (after !== lineCountBefore.get(file)) shifted = true
  }

  // P1-D — what the files say now is what the caller's ids describe next: a
  // value write does not re-read the board. Remembered so the NEXT batch can
  // be re-found through a later outside change (`sourceTextHistory.ts`).
  if (written > 0) rememberSourceTexts(touchedFiles)

  // W7-3 — the project's launcher preview is now out of date. Debounced and
  // fire-and-forget: `refreshAfterSave` returns immediately and the capture
  // happens ~15s after the last write in this project, so an editing burst
  // costs one screenshot rather than one per keystroke-driven save. Hooked
  // HERE rather than on the `/save` route because this function is the single
  // engine BOTH the route and the MCP `studio_apply_edits` tool run through —
  // and the agent's writes are the ones most likely to change what a screen
  // looks like.
  if (written > 0) projectThumbnailQueue.refreshAfterSave(dir)

  // Every per-edit outcome under the id the caller SENT — see this function's doc.
  const sentId = new Map(identity.retargeted.map(({ nodeId, to }) => [to, nodeId]))
  const asSent = <T extends { nodeId: string }>(outcomes: T[]): T[] =>
    outcomes.map((outcome) => (sentId.has(outcome.nodeId) ? { ...outcome, nodeId: sentId.get(outcome.nodeId)! } : outcome))

  return {
    written,
    skipped: refusals.length,
    shifted,
    sharedComponents,
    refusals: asSent(refusals),
    swapDetails: asSent(swapDetails),
    detachDetails: asSent(detachDetails),
    createdStylesheets: asSent(createdStylesheets),
    styleLandings: asSent(styleLandings),
    promoteDetails: asSent(promoteDetails),
    addSlotPropDetails: asSent(addSlotPropDetails),
    touchedFiles: [...touchedFiles],
    removed: asSent(removed),
    fingerprints: asSent(fingerprints),
    retargeted: identity.retargeted,
    createdNodeIds: resolveCreatedNodeIds(createdPositions, lineCountAfter),
    relocatedNodeIds: resolveCreatedNodeIds(relocatedPositions, lineCountAfter),
    listArrays: listArrayPositions.flatMap(({ nodeId, position }) =>
      resolveCreatedNodeIds(position, lineCountAfter).map((to) => ({ nodeId: sentId.get(nodeId) ?? nodeId, to })),
    ),
    ...(carried.length > 0 ? { carried } : {}),
    ...(pastedHtml.length > 0 ? { pastedHtml } : {}),
    ...(undoToken ? { undoToken } : {}) }
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
  options: StudioEditBatchOptions = {},
): Promise<StudioEditBatchResult> {
  return withProjectWriteLock(dir, () => applyStudioEditBatch(dir, edits, expect, options))
}

