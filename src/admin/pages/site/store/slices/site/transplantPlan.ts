/**
 * transplantPlan - the plan behind a drag that crossed a board frame (D2 G3):
 * whether one element may leave the page it is written in and land in a
 * container on another page, dressed as the `EditConstraint` a refusal needs.
 *
 * Split out of `structuralSourceEdits.ts`, which keeps every other plan.
 */
import {
  describeStructuralRefusal,
  previewStructuralTransplant,
  type EditConstraintAction,
  type NodeTree,
  type PageNode,
  type StructuralTransplantCommit,
} from '@core/page-tree'
import type { StructuralPlan } from './structuralSourceEdits'

/**
 * D2 G3 — whether ONE element may leave the page it is written in and land in
 * a container on ANOTHER page (a cross-frame drop), and if so where.
 *
 * A thin wrapper over `previewStructuralTransplant` (`@core/page-tree`), for
 * exactly the reason `planSourceMove` is one over `previewStructuralMove`: the
 * rule is pure and belongs next to the other structural rules, and the only
 * thing the store adds is the `EditConstraint` dressing, which needs the NODE
 * in hand to derive `origin` (the `rel:line:col` a "show me" button jumps to).
 *
 * `commit` is never `null` on success. Unlike every other plan here there is
 * no "ordinary CMS tree" branch to fall through to: a cross-PAGE move has no
 * in-memory equivalent at all — the two trees are two files — so either the
 * source can take the write or the gesture refuses.
 */
export function planSourceTransplant(
  originTree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  destinationTree: NodeTree<PageNode>,
  newParentId: string,
  newIndex: number,
  copy: boolean,
): StructuralPlan<StructuralTransplantCommit> {
  const preview = previewStructuralTransplant({
    originTree,
    nodeIds,
    destinationTree,
    newParentId,
    newIndex,
    copy,
  })
  if (preview.ok) return { ok: true, commit: preview.commit }
  // The node the refusal is about — either end of the gesture, since a
  // transplant can be refused for what the CONTAINER is as well as for what
  // the moved element is. `previewStructuralTransplant` names which.
  const node = preview.nodeId === undefined
    ? undefined
    : (originTree.nodes[preview.nodeId] ?? destinationTree.nodes[preview.nodeId])
  const constraint = describeStructuralRefusal({ refusal: preview.refusal, ...(node ? { node } : {}) })
  return {
    ok: false,
    constraint: offersCopyInstead(originTree, nodeIds, destinationTree, newParentId, newIndex, copy)
      ? { ...constraint, actions: [...constraint.actions, DUPLICATE_INTO_FRAME_ACTION] }
      : constraint,
    ...(node ? { nodeId: node.id } : {}),
  }
}

/**
 * D2 G3's one remedy: the refused MOVE, re-issued as a copy.
 *
 * The label says what the button does rather than naming the mechanism,
 * because a user who has just been told "moving this would change every place
 * it is used" is being offered the thing that does not.
 */
const DUPLICATE_INTO_FRAME_ACTION: EditConstraintAction = {
  label: 'Duplicate into frame instead',
  kind: 'duplicate-into-frame',
}

/**
 * Whether the SAME gesture with Alt held would be allowed — the only honest
 * basis for offering "Duplicate into frame instead".
 *
 * It re-asks `previewStructuralTransplant`, the identical function that just
 * refused, rather than testing the refusal's reason against a list here: the
 * rule about which refusals a copy escapes belongs in the engine
 * (`copyEscapesOriginRefusal`), and a second copy of it in the store is exactly
 * the hand-kept-in-sync duplication `planSourceMove`'s own doc was written to
 * stop repeating. A gesture that was ALREADY a copy has nothing to offer — it
 * refused with Alt already held.
 */
function offersCopyInstead(
  originTree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  destinationTree: NodeTree<PageNode>,
  newParentId: string,
  newIndex: number,
  copy: boolean,
): boolean {
  if (copy) return false
  return previewStructuralTransplant({
    originTree,
    nodeIds,
    destinationTree,
    newParentId,
    newIndex,
    copy: true,
  }).ok
}
