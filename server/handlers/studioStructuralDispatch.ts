/**
 * studioStructuralDispatch — how the STRUCTURAL kinds enter their codemods
 * from `studioWriteback.ts`'s dispatcher: `transplant` and the `move` /
 * `delete` / `reinsert-source` / `insert` / `duplicate` / `wrap` / `group` /
 * `ungroup` / `reparent` family.
 *
 * Their shared job is decoding the ENDS a value edit does not have — an
 * anchor sibling, a destination container, a group's other members — each
 * through the same `studioEditLocation` guard as the edit's own `nodeId`, with
 * the same-file filter every kind but `transplant` applies. Split out of
 * `studioWriteback.ts` (`module-size-budgets`' 700-line ceiling, reached when
 * P5-D added `svg-attr`) along that line: the dispatcher keeps the value
 * kinds, which decode one location and hand it straight to a codemod; this
 * module owns the kinds that decode several.
 */
import { join } from 'node:path'
import { applyStructuralEdit, applyTransplantEdit } from './studioStructuralWriteback'
import { studioEditLocation, type SourceTargetScope, type StudioEditLocation } from './studioEditRouting'
import { StudioEditRefusalError } from './studioEditRefusals'
import type { StudioEdit, StudioEditApplyOutcome } from './studioEditSchemas'

export type StructuralDispatchEdit = Extract<
  StudioEdit,
  { kind: 'transplant' | 'move' | 'delete' | 'reinsert-source' | 'insert' | 'duplicate' | 'wrap' | 'group' | 'ungroup' | 'reparent' }
>

/** Apply one structural edit whose own `nodeId` decoded to `target` (`loc` is its absolute form). */
export function dispatchStructuralEdit(
  dir: string,
  edit: StructuralDispatchEdit,
  loc: { file: string; line: number; col: number },
  target: StudioEditLocation,
  scope: SourceTargetScope | undefined,
): StudioEditApplyOutcome {
  switch (edit.kind) {
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
        ...(result.removed === undefined ? {} : { removed: [result.removed] }),
      }
    }
  }
}
