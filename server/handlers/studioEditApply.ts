/**
 * studioEditApply — applies ONE typed studio edit: `applyStudioEdit` and the
 * per-kind dispatch behind it. Split out of `studioWriteback.ts` (the batch
 * front door, which re-exports it) when that file reached the 700-line ceiling.
 */
import { join } from 'node:path'
import {
  createModuleImportPlan,
  
  detachComponentInstance,
  exposeLiteralAsProp,
  promoteOverrideToDefault,
  setImportSpecifier,
  setJsxClassName,
  setJsxProp,
  setJsxStyle,
  setJsxTagName,
  setJsxText,
  setStringLiteral,
  setStyledDeclaration,
  swapComponentInstance,
  
  type ModuleImportPlan } from '@core/ast-codemods'
import { callSitePosition, inlineDepth, inlineSegments } from '@core/page-tree'
import type { Project } from 'ts-morph'
import { applyCssEdit } from './studioCssWriteback'
import type { } from './studioPastedHtmlStyles'
import { applyRestoreEdit } from './studioBatchUndoJournal'
import { relativeImportSpecifier, resolveClassNameTokens, resolveContainedRefPath } from './studioEditTargets'
import {
  applySlotEdit } from './studioSlotWriteback'
import { dispatchStructuralEdit } from './studioStructuralDispatch'
import { applyVariantEdit } from './studioVariantWriteback'
import { applySvgAttrEdit } from './studioSvgWriteback'
import { applyListItemEdit } from './studioListItemWriteback'
import { applyUnrollListEdit } from './studioUnrollWriteback'
import { applyCanvasLayerEdit, isCanvasLayerEdit } from './studioCanvasLayerWriteback'
import {
  
  type StudioEdit,
  type StudioEditApplyOutcome } from './studioEditSchemas'
import {
  
  
  refusalFromCodemodError,
  StudioEditRefusalError } from './studioEditRefusals'
import {
  canonicalSourceRel,
  
  
  
  
  studioEditLocation,
  
  type SourceTargetScope } from './studioEditRouting'

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
      ...(outcome.styleLanding ? { styleLanding: outcome.styleLanding } : {}) }
  }

  // P3-F — a restore names a journal entry, never a location.
  if (edit.kind === 'restore') return applyRestoreEdit(dir, edit)
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
      setJsxProp({ ...loc, prop, value: edit.value, ...(edit.unbind ? { unbind: true } : {}), project })
      return { applied: true }
    }
    case 'text':
      setJsxText({ ...loc, text: edit.text, ...(edit.unbind ? { unbind: true } : {}), project })
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
        project })
      if (!outcome.ok) throw new StudioEditRefusalError(outcome.reason, outcome.message)
      // `changed: false` means the template already says exactly this — the
      // requested state IS the state on disk, so reporting a skip would toast
      // the user about a no-op (`applyCssEdit`'s `unset` precedent).
      return { applied: true, styleLanding: { rung: outcome.landing, file: target.rel } }
    }
    case 'style':
      // `style-03` — `JsxStyleTargetError` refuses `style-target`
      // (`studioEditRefusals.ts`). Since P3-C (WB-17) that is only a removal
      // from an expression `style`, a value that is not an object, or a
      // shorthand key: a spread or an identifier is written, not refused.
      setJsxStyle({ ...loc, style: edit.style, ...(edit.remove ? { remove: edit.remove } : {}), project })
      return { applied: true, styleLanding: { rung: 'inline', file: target.rel } }
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
      setStringLiteral({ ...loc, value: edit.text, expected: edit.expected, project })
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
    case 'transplant':
    case 'move':
    case 'delete':
    case 'insert':
    case 'duplicate':
    case 'wrap':
    case 'group':
    case 'ungroup':
    case 'reparent':
      return dispatchStructuralEdit(dir, edit, loc, target, scope)
    case 'svg-attr': {
      // P5-D SVG-4 — one element inside an inline `<svg>` (`studioSvgWriteback.ts`).
      const result = applySvgAttrEdit(loc, edit, project)
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      return { applied: true }
    }
    case 'list-item': {
      // OD-8 — `loc` is the array's `[`: a row's reorder/delete/duplicate rewrites it.
      const result = applyListItemEdit(loc, edit, project)
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      return { applied: true }
    }
    case 'unroll-list': { // G-9 — `loc` is the row template; the array goes through the same path guard
      const result = applyUnrollListEdit(loc, target.rel, studioEditLocation(dir, edit.array, scope), edit, project)
      if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
      return { applied: true, created: result.created }
    }
    case 'detach': {
      // P3-D (OD-7) — the import is retired by this batch's prune pass
      // (`studioBatchImportPrune.ts`); ⌘Z is the undo journal's `restore`.
      const result = detachComponentInstance({ ...loc, workspaceRoot: dir, retireImport: false, ...(edit.dryRun ? { dryRun: edit.dryRun } : {}) })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      const { written, lossy, branchNote, movedHooks, perRow } = result
      const detachDetail = { written, lossy, movedHooks, perRow, ...(branchNote ? { branchNote } : {}) }
      return { applied: written, detachDetail, ...(result.created ? { created: [result.created] } : {}) }
    }
    case 'expose-prop': {
      // P5-C (DET-7) — two files: the component (this id's tail, `loc`) and
      // the ONE call site (its head). G-2b: an element deeper than one call
      // site also names the call site inside each component on the way down
      // (`page~Card~Badge`); each is decoded on its own, so each file is
      // contained on its own, and the codemod threads the value through them.
      if (inlineDepth(edit.nodeId) < 1) {
        throw new StudioEditRefusalError('not-in-component', 'That element is not part of a component. Select an element inside a component to make it a prop.')
      }
      const sites = inlineSegments(edit.nodeId).slice(0, -1).map((segment) => studioEditLocation(dir, segment, scope))
      const [callSite, ...inner] = sites
      if (!callSite || inner.some((site) => site === null)) return { applied: false, unwritable: 'no-source-location' }
      const result = exposeLiteralAsProp({
        callSiteFile: join(dir, callSite.rel),
        callSiteLine: callSite.line,
        callSiteCol: callSite.col,
        via: inner.flatMap((site) => (site ? [{ file: join(dir, site.rel), line: site.line, col: site.col }] : [])),
        elementFile: loc.file,
        line: loc.line,
        col: loc.col,
        workspaceRoot: dir,
        overrides: edit.overrides.map(({ target, propName, value }) => ({ target, propName, ...(value !== undefined ? { value } : {}) })) })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true }
    }
    case 'promote-override': {
      // OD-19 — "Apply to all": the same two files as `expose-prop`, addressed
      // the same way (call site = the id's head, component file = its tail,
      // both through `studioEditLocation`); the codemod checks the file the
      // call site's import resolves to is the tail's.
      if (inlineDepth(edit.nodeId) !== 1) {
        throw new StudioEditRefusalError('not-in-component', 'Only an instance placed on this page can apply a value everywhere. Select that instance and try again.')
      }
      const callSite = studioEditLocation(dir, callSitePosition(edit.nodeId), scope)
      if (!callSite) return { applied: false, unwritable: 'no-source-location' }
      const result = promoteOverrideToDefault({
        callSiteFile: join(dir, callSite.rel),
        callSiteLine: callSite.line,
        callSiteCol: callSite.col,
        componentFile: loc.file,
        workspaceRoot: dir,
        propNames: edit.propNames })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return { applied: true }
    }
    case 'swap': {
      const result = swapComponentInstance({
        ...loc,
        workspaceRoot: dir,
        newComponentName: edit.newComponentName,
        newComponentSource: edit.newComponentSource,
        newComponentFile: edit.newComponentFile })
      if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return {
        applied: true,
        swapDetail: { removedProps: result.removedProps, unfilledRequiredProps: result.unfilledRequiredProps } }
    }
    case 'add-variant':
    case 'remove-variant':
    case 'add-component-prop': {
      // CV-3 — the component's definition: `loc` is its declaration, the rest is re-read from disk.
      const result = applyVariantEdit(dir, edit, target, (rel) => canonicalSourceRel(dir, rel))
      if ('refusal' in result) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
      return result
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
        ...(result.addSlotPropDetail ? { addSlotPropDetail: result.addSlotPropDetail } : {}) }
    }
  }
}
