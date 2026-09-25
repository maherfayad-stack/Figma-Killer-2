/**
 * moveSequenceActions — several elements moved as ONE gesture: one history
 * entry, one source write (P2-C2's OD-16 step, generalised by P3-D).
 *
 * Two actions, one engine:
 *
 *   - `stepSiblings(nodeIds, steps)` is the arrow-key INTENT — "every selected
 *     layer, N places along its parent's order" — from the arrow keys, ⌥↑ /
 *     ⌥↓, ⌘[ / ⌘] and the palette's Move up / down. It plans with
 *     `planSiblingSteps` against the tree as it is when the gesture RUNS (a
 *     press queued behind an in-flight write re-plans against the resynced
 *     tree, never against stale indices);
 *   - `moveNodesInSequence(moves)` applies an ordered list of single-element
 *     moves, each against the tree the previous one left
 *     (`@core/page-tree`'s `moveSequence.ts`). A multi-selection drag
 *     (`moveNodes` with several ids — ERR-7) arrives here through
 *     `planMoveSequence`, `stepSiblings` ends here, and undo / redo re-issue a
 *     recorded sequence through it.
 *
 * Every step is planned (`planSourceMove`) against the SCRATCH tree the steps
 * before it leave, all or nothing, before anything mutates: a drag where one
 * step would be refused moves nothing, because half a gesture is a canvas the
 * file does not describe. The steps then go out as one `/save` SEQUENCE
 * (`commitStudioSequence` → the server's `studioEditSequence.ts`), which
 * re-addresses each step against the file the previous one left and restores
 * every file if any step is refused.
 *
 * A sequence of one is an ordinary `moveNodes` — the same entry shape
 * (`move`), the same undo, the same write every single drag makes. Two or
 * more are tagged `moves`, whose undo is `invertMoveSequence`.
 */
import {
  createScratchTree,
  invertMoveSequence,
  moveNodes,
  moveOnScratch,
  planSiblingSteps,
  type SequencedMove,
  type SiblingStepRefusal,
  type StructuralMoveCommit,
} from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { commitStudioSequence } from '@site/studio/studioStructuralCommits'
import type { StructuralEditPayload } from '@site/studio/structuralUndoPlan'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { broadcastOptimisticMove } from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'
import { STRUCTURAL_REFUSAL_TITLE, planSourceMove, presentStructuralRefusal } from './structuralSourceEdits'
import { tagStructuralGesture } from './structuralHistory'
import { trackStructuralTreeCommit } from './structuralCommitRollback'
import type { SiteSlice, SiteSliceHelpers } from './types'

type MoveSequenceActions = Pick<SiteSlice, 'stepSiblings' | 'moveNodesInSequence'>

/** What each planner refusal says — the one sentence, and the way out. */
const SIBLING_STEP_REFUSAL: Record<SiblingStepRefusal, string> = {
  'multi-row':
    'Several layers can move a grid row only one at a time for now: each would cross the same siblings. Select one layer, or use ← / → to step them together.',
  nested:
    'One of these layers sits inside something another one is moving past, so the two writes would overlap. Move them one level at a time.',
  locked: 'A selected layer is locked. Unlock it (⌘⇧L) to move the selection.',
}

/**
 * The edit a planned move is written as: a reorder names its sibling, a
 * same-file reparent its new container, and (ERR-16) a move into a container
 * written in ANOTHER file is a `transplant`, which carries the imports and
 * checks the scope the markup needs there. `null` when nothing is written
 * (an ordinary CMS tree, or a step that changes no order).
 */
export function moveEditOf(commit: StructuralMoveCommit): StructuralEditPayload | null {
  const anchor = commit.anchorNodeId ? { anchorNodeId: commit.anchorNodeId, position: commit.position } : {}
  if (commit.destinationParentNodeId) {
    return {
      kind: commit.crossFile ? 'transplant' : 'reparent',
      nodeId: commit.nodeId,
      parentNodeId: commit.destinationParentNodeId,
      ...anchor,
    }
  }
  return commit.anchorNodeId ? { kind: 'move', nodeId: commit.nodeId, ...anchor } : null
}

export function createMoveSequenceActions(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
  moveOne: SiteSlice['moveNodes'],
): MoveSequenceActions {
  const { get, set, mutateActiveTree } = helpers

  const actions: MoveSequenceActions = {
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
      actions.moveNodesInSequence(plan.moves)
    },

    moveNodesInSequence: (moves) => {
      if (moves.length === 0) return
      if (moves.length === 1) {
        const [move] = moves as [SequencedMove]
        moveOne([move.nodeId], move.parentId, move.index)
        return
      }
      if (
        deferWhileStructuralCommitInFlight(
          (relocate) =>
            actions.moveNodesInSequence(moves.map((move) => ({ ...move, nodeId: relocate(move.nodeId), parentId: relocate(move.parentId) }))),
          moves.flatMap((move) => [move.nodeId, move.parentId]),
        )
      ) {
        return
      }
      const tree = readTree()
      if (!tree) return
      // Every step against the tree the steps before it leave — all or
      // nothing, decided before the real tree changes.
      const scratch = createScratchTree(tree)
      const edits: StructuralEditPayload[] = []
      for (const move of moves) {
        const plan = planSourceMove(scratch, [move.nodeId], move.parentId, move.index)
        if (!plan.ok) {
          presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, plan.constraint, {
            ...(plan.nodeId ? { nodeId: plan.nodeId } : {}),
            // OD-7 — every id the sequence names goes through the map.
            retry: (mapId) =>
              actions.moveNodesInSequence(moves.map((step) => ({ ...step, nodeId: mapId(step.nodeId), parentId: mapId(step.parentId) }))),
            getState: get,
            set,
          })
          return
        }
        const edit = plan.commit ? moveEditOf(plan.commit) : null
        if (edit) edits.push(edit)
        moveOnScratch(scratch, move)
      }
      const undo = invertMoveSequence(tree, moves)
      const topBefore = get()._historyPast.at(-1)
      const moved = mutateActiveTree((draft) => {
        for (const move of moves) moveNodes(draft, [move.nodeId], move.parentId, move.index)
        return true
      })
      if (!moved) return
      for (const move of moves) broadcastOptimisticMove(move.nodeId, move.parentId, move.index)
      if (edits.length === 0) return // a CMS / Visual Component tree: patch-replay undo is exact
      const rollback = trackStructuralTreeCommit(helpers, topBefore, moves.map((move) => move.nodeId)) ?? undefined
      tagStructuralGesture(set, { gesture: 'moves', undo, redo: [...moves] })
      void commitStudioSequence(edits, 'Move refused', rollback ? { rollback } : {})
    },
  }

  return actions
}
