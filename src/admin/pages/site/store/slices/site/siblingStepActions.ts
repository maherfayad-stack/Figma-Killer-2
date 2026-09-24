/**
 * siblingStepActions — a multi-selection moved among its siblings as ONE
 * gesture: one history entry, one save batch (P2-C2, OD-16).
 *
 * Two actions, one engine:
 *
 *   - `stepSiblings(nodeIds, steps)` is the INTENT — "every selected layer, N
 *     places along its parent's order" — from the arrow keys, ⌥↑ / ⌥↓, ⌘[ / ⌘]
 *     and the palette's Move up / down. It plans with `planSiblingSteps`
 *     against the tree as it is when the gesture RUNS (a press queued behind
 *     an in-flight write re-plans against the resynced tree, never against
 *     stale indices);
 *   - `moveSiblings(moves)` applies an explicit batch of independent
 *     single-element moves. `stepSiblings` ends in it, and undo / redo
 *     re-issue a recorded batch through it (`structuralHistory.ts`).
 *
 * A batch of one is an ordinary `moveNodes` — the same entry shape (`move`),
 * the same undo, the same source write every drag makes. Two or more are
 * tagged `siblings`, whose undo is the inverse batch.
 *
 * Every move is gated by `planSourceMove` BEFORE anything mutates, all or
 * nothing: a selection where one move would be refused moves not at all,
 * because half a step is a canvas the file does not describe. The writes then
 * go out as one `/save` batch (`commitStudioMoves`), which P1-A fingerprints
 * and P1-F takes back if it does not land.
 */
import {
  invertSiblingMoves,
  moveNodes,
  planSiblingSteps,
  type SiblingMove,
  type SiblingStepRefusal,
} from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { commitStudioMoves } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { broadcastOptimisticMove } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import { STRUCTURAL_REFUSAL_TITLE, planSourceMove, presentStructuralRefusal } from './structuralSourceEdits'
import { tagStructuralGesture } from './structuralHistory'
import { trackStructuralTreeCommit } from './structuralCommitRollback'
import type { SiteSlice, SiteSliceHelpers } from './types'

type SiblingStepActions = Pick<SiteSlice, 'stepSiblings' | 'moveSiblings'>

/** What each planner refusal says — the one sentence, and the way out. */
const SIBLING_STEP_REFUSAL: Record<SiblingStepRefusal, string> = {
  'multi-row':
    'Several layers can move a grid row only one at a time for now: each would cross the same siblings. Select one layer, or use ← / → to step them together.',
  nested:
    'One of these layers sits inside something another one is moving past, so the two writes would overlap. Move them one level at a time.',
  locked: 'A selected layer is locked. Unlock it (⌘⇧L) to move the selection.',
}

export function createSiblingStepActions(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
  moveOne: SiteSlice['moveNodes'],
): SiblingStepActions {
  const { get, set, mutateActiveTree } = helpers

  const actions: SiblingStepActions = {
    stepSiblings: (nodeIds, steps) => {
      if (nodeIds.length === 0) return
      if (
        deferWhileStructuralCommitInFlight(
          (relocate) =>
            actions.stepSiblings(
              nodeIds.map(relocate),
              Object.fromEntries(Object.entries(steps).map(([parentId, step]) => [relocate(parentId), step])),
            ),
          [...nodeIds, ...Object.keys(steps)],
        )
      ) {
        return
      }
      const tree = readTree()
      if (!tree) return
      const plan = planSiblingSteps(tree, nodeIds, (parentId) => steps[parentId] ?? null)
      if (!plan.ok) {
        pushToast({ kind: 'info', title: STRUCTURAL_REFUSAL_TITLE.move, body: SIBLING_STEP_REFUSAL[plan.reason] })
        return
      }
      actions.moveSiblings(plan.moves)
    },

    moveSiblings: (moves) => {
      if (moves.length === 0) return
      if (moves.length === 1) {
        const [move] = moves as [SiblingMove]
        moveOne([move.nodeId], move.parentId, move.index)
        return
      }
      if (
        deferWhileStructuralCommitInFlight(
          (relocate) =>
            actions.moveSiblings(moves.map((move) => ({ ...move, nodeId: relocate(move.nodeId), parentId: relocate(move.parentId) }))),
          moves.flatMap((move) => [move.nodeId, move.parentId]),
        )
      ) {
        return
      }
      const tree = readTree()
      if (!tree) return
      // All or nothing, decided before the tree changes.
      const commits: { nodeId: string; anchorNodeId: string; position: 'before' | 'after' }[] = []
      for (const move of moves) {
        const plan = planSourceMove(tree, [move.nodeId], move.parentId, move.index)
        if (!plan.ok) {
          presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, plan.constraint, {
            ...(plan.nodeId ? { nodeId: plan.nodeId } : {}),
            getState: get,
            set,
          })
          return
        }
        const commit = plan.commit
        if (commit?.anchorNodeId && !commit.destinationParentNodeId) {
          commits.push({ nodeId: commit.nodeId, anchorNodeId: commit.anchorNodeId, position: commit.position })
        }
      }
      const topBefore = get()._historyPast.at(-1)
      // Independent moves (`planSiblingSteps`), so applying them in any order
      // against their recorded indices lands every one where it was planned.
      const moved = mutateActiveTree((draft) => {
        for (const move of moves) moveNodes(draft, [move.nodeId], move.parentId, move.index)
        return true
      })
      if (!moved) return
      for (const move of moves) broadcastOptimisticMove(move.nodeId, move.parentId, move.index)
      if (commits.length === 0) return // a CMS / Visual Component tree: patch-replay undo is exact
      const rollback = trackStructuralTreeCommit(helpers, topBefore, moves.map((move) => move.nodeId)) ?? undefined
      tagStructuralGesture(set, { gesture: 'siblings', undo: invertSiblingMoves(moves), redo: [...moves] })
      void commitStudioMoves(commits, rollback)
    },
  }

  return actions
}
