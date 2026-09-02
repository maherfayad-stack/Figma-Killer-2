/**
 * classNameWriteback — Track B2's client half: turns a `PageNode.classIds`
 * drift since the last save (`loadedValuesBaseline.ts`'s `collectClassIdsDrift`)
 * into `kind: 'class'` edits (`setJsxClassName`, `server/handlers/
 * studioEditSchemas.ts`) — the real write behind Phase 0 item 0.6's
 * honesty-only stopgap (`classAssignmentUnsavedNotice.ts`).
 *
 * Split out of `fsCodemodAdapter.ts` for the same reason `styleRuleWriteback.ts`
 * is its own file (`module-size-budgets`'s 700-line ceiling, and "one thing to
 * get right, tested on its own"): converting an id-based drift into a
 * JSX-editable class-token diff needs the rule registry (id -> class NAME)
 * that only `site.styleRules` carries.
 *
 * ## Not every drift is writable
 *
 * `hasWritableSourceLocation` is the exact per-node gate every other edit
 * kind asks before emitting a `prop`/`style`/`text` edit — a `.map` row or a
 * synthetic root (`index:body`) has no single JSX location a class token
 * could land on. Those drifts go into `unwritable`: the direct replacement
 * for Phase 0.6's blanket "class changes can't be written yet" toast, now
 * scoped to the genuinely unwritable subset instead of firing for every
 * class change in the project.
 *
 * An INLINED (shared-component) node id IS writable — the write lands on the
 * component's own file, exactly like any other prop/style edit on that node
 * — `isSharedSourceNodeId` (kind-agnostic on the id shape) already tells the
 * save route to reload afterwards for it, same as it always has.
 *
 * ## A pure reorder writes nothing
 *
 * Class token ORDER inside a `className` attribute has no effect on the
 * cascade — that is decided by declaration order in the stylesheet, not
 * attribute order — so a reorder-only drift (`addedClassIds`/`removedClassIds`
 * both empty, `reordered: true`) produces no edit and no toast. There is
 * nothing honest to persist.
 *
 * ## Per-token refusals are not decided here
 *
 * `setJsxClassName` (`@core/ast-codemods`) is the only place that has
 * actually read the `className` expression, so it is the only place that can
 * refuse (a CSS Modules binding, a dynamic template, a spread attribute, an
 * unrecognized function call). This module only ever PROPOSES the edit; the
 * refusal comes back from the server on `StudioEditBatchResult.refusals`
 * with `kind: 'class'`, surfaced by `fsCodemodAdapter.ts`'s existing
 * `REFUSAL_TITLES` toast loop exactly like `detach`/`swap`/`css` already are.
 */
import { getNodeDisplayName, hasWritableSourceLocation, type Page, type SiteDocument, type StyleRule } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { collectClassIdsDrift } from './loadedValuesBaseline'
import type { ClassAssignmentDriftDetail } from '@site/panels/classAssignmentUnsavedNotice'

/** One `kind: 'class'` edit, matching `server/handlers/studioEditSchemas.ts`'s `ClassEditSchema`. */
export interface ClassNameEditPayload {
  kind: 'class'
  nodeId: string
  add: string[]
  remove: string[]
}

export interface ClassNameEditPlan {
  edits: ClassNameEditPayload[]
  /** Drifts with no writable source location at all — genuinely can never be written from this node id. */
  unwritable: ClassAssignmentDriftDetail[]
}

/** Resolves class ids to their display names, dropping any id with no rule (shouldn't happen — a classId always comes from an assigned rule). */
function classNamesFor(ids: readonly string[], styleRules: Record<string, StyleRule>): string[] {
  const names: string[] = []
  for (const id of ids) {
    const name = styleRules[id]?.name
    if (name) names.push(name)
  }
  return names
}

/**
 * Diffs every node's `classIds` against the load-time baseline
 * (`collectClassIdsDrift`) and splits the result into `kind: 'class'` edits
 * ready to send, plus the subset with no writable source location at all —
 * see this module's doc for why those two lists, and why a reorder-only
 * drift appears in neither.
 */
export function collectClassNameEdits(
  pages: readonly Page[],
  styleRules: Record<string, StyleRule>,
  visualComponents: SiteDocument['visualComponents'],
): ClassNameEditPlan {
  const edits: ClassNameEditPayload[] = []
  const unwritable: ClassAssignmentDriftDetail[] = []

  for (const drift of collectClassIdsDrift(pages)) {
    if (drift.addedClassIds.length === 0 && drift.removedClassIds.length === 0) continue // reorder-only — nothing the cascade cares about

    const addedClassNames = classNamesFor(drift.addedClassIds, styleRules)
    const removedClassNames = classNamesFor(drift.removedClassIds, styleRules)

    if (!hasWritableSourceLocation(drift.nodeId)) {
      unwritable.push({
        nodeLabel: getNodeDisplayName(drift.node, registry.get(drift.node.moduleId), visualComponents),
        addedClassNames,
        removedClassNames,
        reordered: false,
      })
      continue
    }

    edits.push({ kind: 'class', nodeId: drift.nodeId, add: addedClassNames, remove: removedClassNames })
  }

  return { edits, unwritable }
}
