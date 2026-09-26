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
 * write nothing. The save route applies each edit independently — one codemod
 * declining (e.g. a text edit landing on an element with mixed children) is
 * reported as that edit's named refusal rather than aborting the whole batch,
 * and every edit that does not write is named (WB-12, `studioEditRefusals.ts`).
 */
import { join } from 'node:path'
import {
  createModuleImportPlan,
  createProject,
  detachComponentInstance,
  setImportSpecifier,
  setJsxClassName,
  setJsxProp,
  setJsxStyle,
  setJsxTagName,
  setJsxText,
  setStringLiteral,
  setStyledDeclaration,
  swapComponentInstance,
  syncProjectWithDisk,
  type DeletedJsxText,
  type ModuleImportPlan,
} from '@core/ast-codemods'
import type { SourceFingerprintExpectations } from '@core/page-tree'
import type { Project } from 'ts-morph'
import { applyCssEdit } from './studioCssWriteback'
import { withProjectWriteLock } from './studio/projectWriteLock'
import { snapshotImportsBeforeRemoval } from './studioBatchImportPrune'
import { resolveInsertAssetImports } from './studioInsertAssetImports'
import { relativeImportSpecifier, resolveClassNameTokens, resolveContainedRefPath } from './studioEditTargets'
import {
  applySlotEdit,
  isSlotPreviewOutcome,
  type StudioAddSlotPropDetail,
  type StudioPromoteComponentDetail,
} from './studioSlotWriteback'
import { applyStructuralEdit, applyTransplantEdit } from './studioStructuralWriteback'
import { applyListItemEdit } from './studioListItemWriteback'
import { applyCanvasLayerEdit, isCanvasLayerEdit } from './studioCanvasLayerWriteback'
import { createCanvasLayerScope } from './studioCanvasLayerScope'
import { createSyntaxGuard } from './studioSyntaxGuard'
import { expandMergedOutcomes } from './studioEditMerge'
import { fingerprintAfterWrite, resolveEditIdentities } from './studioEditIdentity'
import { rememberSourceTexts } from './studio/sourceTextHistory'
import { countLines, recordCreatedPosition, resolveCreatedNodeIds, type CreatedNodePosition } from './studioEditPositions'
import { projectThumbnailQueue } from './studio/projectThumbnailQueue'
import {
  type StudioEdit,
  type StudioEditApplyOutcome,
  type StudioEditBatchOptions,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail,
} from './studioEditSchemas'
import {
  refusalFor,
  refusalForUnwritable,
  refusalFromCodemodError,
  StudioEditRefusalError,
  WRITE_FAILED_REASON,
  writeFailedRefusal,
} from './studioEditRefusals'

export {
  StudioEditSchema,
  type StudioEdit,
  type StudioEditApplyOutcome,
  type StudioEditBatchResult,
  type StudioEditRefusal,
  type StudioEditSwapDetail,
} from './studioEditSchemas'
export { StudioEditRefusalError } from './studioEditRefusals'

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
  type StudioEditLocation,
} from './studioEditRouting'

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
 * Returns `applied: false` (with its `unwritable` reason) for a synthetic node
 * id (e.g. the `index:body` root) that has no source location, or a target path
 * that fails containment — nothing to write, not an exception. Returns
 * `applied: true` once the matching codemod has written the file. Every NAMED
 * decline — a codemod's typed error (`JsxTextTargetError`, `JsxPropTargetError`,
 * a locate miss …) or a returned refusal (`detach`/`swap`/`class`/`css`/the
 * structural family) — throws `StudioEditRefusalError` with a stable reason
 * and a sentence for a person (`studioEditRefusals.ts`, WB-12). Anything else
 * propagates unchanged; `applyStudioEditBatch` reports it as `write-failed`.
 *
 * `StudioEditSwapDetail`/`StudioEditApplyOutcome` (this function's own return
 * shape) now live in `studioEditSchemas.ts`, alongside every other RESPONSE
 * type this module builds and returns — see that module's own doc for why.
 */
export function applyStudioEdit(dir: string, edit: StudioEdit, batch?: StudioEditBatchContext): StudioEditApplyOutcome {
  // P3-C (WB-18) — a batch passes ITS plan and adds the reserved imports after
  // its last edit; a lone edit has nothing pending below it, so it adds them now.
  const plan = batch?.moduleImports ?? createModuleImportPlan()
  try {
    const outcome = dispatchStudioEdit(dir, edit, plan, batch)
    if (!batch?.moduleImports) plan.apply()
    return outcome
  } catch (err) {
    throw refusalFromCodemodError(edit, err) ?? err
  }
}

/**
 * What one edit shares with its batch. `project` is WB-25: one ts-morph project
 * per batch, re-synced with the disk before each edit (`syncProjectWithDisk`),
 * instead of a parse per VALUE codemod — 40 edits to a 1,500-element page took
 * 3.8 s in the audit, all under the write lock. Structural kinds keep their own.
 */
export interface StudioEditBatchContext {
  moduleImports: ModuleImportPlan
  project: Project
  /** The batch's own {@link SourceTargetScope} — `canvasLayers: 'allow'` for the editor's `/save` only. */
  scope?: SourceTargetScope
}

function dispatchStudioEdit(dir: string, edit: StudioEdit, moduleImports: ModuleImportPlan, batch?: StudioEditBatchContext): StudioEditApplyOutcome {
  const { project, scope } = batch ?? {}
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
      ...(outcome.applied ? {} : { unwritable: 'stylesheet-unavailable' as const }),
      ...(outcome.createdStylesheet ? { createdStylesheet: outcome.createdStylesheet } : {}),
    }
  }

  // P5-G — the free canvas's kinds address a layer by id (three never decode).
  if (isCanvasLayerEdit(edit)) return applyCanvasLayerEdit(dir, edit, (nodeId) => studioEditLocation(dir, nodeId, scope))
  const target = studioEditLocation(dir, edit.nodeId, scope)
  if (!target) return { applied: false, unwritable: 'no-source-location' } // synthetic node (e.g. body)
  const loc = { file: join(dir, target.rel), line: target.line, col: target.col }

  switch (edit.kind) {
    case 'prop': {
      // WS-4.2/4.3 — a `studio.instance`'s call-site prop arrives as
      // `callSiteProps:<name>` (see `PropEditSchema`'s doc comment); the
      // actual JSX attribute is `<name>` at this SAME location (the instance
      // node's own id is the call site's own plain location).
      // WB-11 — an attribute holding code refuses `binding-overwrite` rather
      // than baking a literal over the binding (`studioEditRefusals.ts`).
      const prop = edit.prop.startsWith('callSiteProps:') ? edit.prop.slice('callSiteProps:'.length) : edit.prop
      setJsxProp({ ...loc, prop, value: edit.value, project })
      return { applied: true }
    }
    case 'text':
      setJsxText({ ...loc, text: edit.text, project })
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
        ...(edit.atRule ? { atRule: edit.atRule } : {}),
        project,
      })
      if (!outcome.ok) throw new StudioEditRefusalError(outcome.reason, outcome.message)
      // `changed: false` means the template already says exactly this — the
      // requested state IS the state on disk, so reporting a skip would toast
      // the user about a no-op (`applyCssEdit`'s `unset` precedent).
      return { applied: true }
    }
    case 'style':
      // `style-03` — `JsxStyleTargetError` refuses `style-target`
      // (`studioEditRefusals.ts`). Since P3-C (WB-17) that is only a removal
      // from an expression `style`, a value that is not an object, or a
      // shorthand key: a spread or an identifier is written, not refused.
      setJsxStyle({ ...loc, style: edit.style, ...(edit.remove ? { remove: edit.remove } : {}), project })
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
      if (add === null || remove === null) return { applied: false, unwritable: 'stylesheet-unavailable' } // never guess
      // WB-18 — a CSS Module this file does not import yet is written against a
      // binding reserved in the batch's plan, imported after the last edit.
      const result = setJsxClassName({ ...loc, add, remove, pendingModuleImports: moduleImports.forFile(loc.file), project })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true }
    }
    case 'literal':
      setStringLiteral({ ...loc, value: edit.text, project })
      return { applied: true }
    case 'asset': {
      // `target` here is the IMPORT's own location (assetOrigin), decoded by
      // the same `studioEditLocation` every other kind shares — `target.rel`
      // is therefore the file HOLDING the import, which is exactly what
      // `relativeImportSpecifier` needs as its "from" side.
      const assetPath = resolveContainedRefPath(dir, edit.assetPath)
      if (assetPath === null) return { applied: false, unwritable: 'asset-unavailable' } // never guess
      const specifier = relativeImportSpecifier(target.rel, assetPath)
      setImportSpecifier({ ...loc, specifier, project })
      return { applied: true }
    }
    case 'tag':
      setJsxTagName({ ...loc, tag: edit.tag, project })
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
      const destination = studioEditLocation(dir, edit.parentNodeId, scope)
      const anchorId = edit.anchorNodeId
      const anchor = anchorId ? studioEditLocation(dir, anchorId, scope) : null
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
      const anchor = anchorId ? studioEditLocation(dir, anchorId, scope) : null
      const parentId = 'parentNodeId' in edit ? edit.parentNodeId : undefined
      const destination = parentId ? studioEditLocation(dir, parentId, scope) : null
      // K3 — a `group` names the REST of its run. Same decoder, same guard,
      // same same-file filter as the anchor above; `applyStructuralEdit`
      // refuses when the filter dropped any of them, because a group that
      // quietly wrapped the subset that happened to be in this file would be
      // a write the user never asked for.
      const siblings = ('siblingNodeIds' in edit ? edit.siblingNodeIds : [])
        .map((nodeId) => studioEditLocation(dir, nodeId, scope))
        .filter((location): location is StudioEditLocation => location !== null && location.rel === target.rel)
      // IMG-10 — an insert's image imports name workspace FILES; the specifier
      // is spelled here, from the file being written, after the path guard.
      const assets = edit.kind === 'insert' ? resolveInsertAssetImports(dir, target.rel, edit) : null
      if (assets && !assets.ok) throw new StudioEditRefusalError(assets.reason, assets.message)
      const result = applyStructuralEdit(
        loc,
        assets ? assets.value : edit,
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
        ...(result.removed === undefined ? {} : { removed: [result.removed] }),
      }
    }
    case 'list-item': {
      // OD-8 — `loc` is the array literal's `[`, not an element: a `.map`
      // row's reorder/delete/duplicate/paste rewrites the array it iterates.
      const result = applyListItemEdit(loc, edit, project)
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      return { applied: true, ...(result.removed.length > 0 ? { removed: result.removed } : {}) }
    }
    case 'detach': {
      // P3-D (OD-7) — the import is retired by this batch's prune pass (see
      // `removesMarkup` below), which also REPORTS it; with the call site's
      // own bytes (`removed`) and what replaced it (`created`) that is the
      // whole of ⌘Z (`reinsert-detached`).
      const result = detachComponentInstance({ ...loc, workspaceRoot: dir, retireImport: false })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true, ...(result.created ? { created: [result.created] } : {}), removed: [result.removed] }
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
      const anchor = anchorId ? studioEditLocation(dir, anchorId, scope) : null
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
  const createdStylesheets: { nodeId: string; file: string }[] = []
  const promoteDetails: (StudioPromoteComponentDetail & { nodeId: string })[] = []
  const addSlotPropDetails: (StudioAddSlotPropDetail & { nodeId: string })[] = []
  // `store-13` — where each created element sat, measured from the END of its
  // file. See `resolveCreatedNodeIds` for why that anchor and not the line.
  const createdPositions: CreatedNodePosition[] = []
  // `store-14` — the same, for the elements a batch MOVED rather than made.
  const relocatedPositions: CreatedNodePosition[] = []
  // `store-15` — every `delete` edit's own discarded bytes, keyed by the
  // edit's own `nodeId` so a caller can pair a `removed` entry with the edit
  // that produced it.
  const removed: (DeletedJsxText & { nodeId: string })[] = []
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
    const brokenTarget = canvasLayerScope(edit) ?? syntaxRefusal(edit)
    if (brokenTarget) {
      refusals.push(brokenTarget)
      continue
    }
    syncProjectWithDisk(project)
    try {
      const outcome = applyStudioEdit(dir, edit, { moduleImports, project, scope })
      if (outcome.addSlotPropDetail) addSlotPropDetails.push({ nodeId: edit.nodeId, ...outcome.addSlotPropDetail })
      if (isSlotPreviewOutcome(outcome)) {
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
        if (outcome.promoteDetail) promoteDetails.push({ nodeId: edit.nodeId, ...outcome.promoteDetail })
        for (const text of outcome.removed ?? []) removed.push({ nodeId: edit.nodeId, ...text })
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

  const prunedImports = importPrune.prune()

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
    createdStylesheets: asSent(createdStylesheets),
    promoteDetails: asSent(promoteDetails),
    addSlotPropDetails: asSent(addSlotPropDetails),
    touchedFiles: [...touchedFiles],
    removed: asSent(removed),
    prunedImports,
    fingerprints: asSent(fingerprints),
    retargeted: identity.retargeted,
    createdNodeIds: resolveCreatedNodeIds(createdPositions, lineCountAfter),
    relocatedNodeIds: resolveCreatedNodeIds(relocatedPositions, lineCountAfter),
    listArrays: listArrayPositions.flatMap(({ nodeId, position }) =>
      resolveCreatedNodeIds(position, lineCountAfter).map((to) => ({ nodeId: sentId.get(nodeId) ?? nodeId, to })),
    ),
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
  options: StudioEditBatchOptions = {},
): Promise<StudioEditBatchResult> {
  return withProjectWriteLock(dir, () => applyStudioEditBatch(dir, edits, expect, options))
}

