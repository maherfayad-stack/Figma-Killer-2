/**
 * layoutConversionActions (PA-7 / PA-8) — "Add auto layout" and "Remove auto
 * layout (keep positions)" as ONE store action: a container and all of its
 * children are restyled together, so the gesture is one write and one undo.
 *
 * When the children must also change ORDER (an absolute free frame becoming a
 * flow whose visual order differs from its source order), the reorder is the
 * structural move every other reorder is. It is written first and the restyle
 * parks behind it (`structuralCommitQueue`), running against the ids the
 * resync leaves — so that case is two honest undo entries, the move and the
 * layout, and the in-order case (the common one) is exactly one.
 *
 * What to write is decided by the caller from measurements
 * (`layoutConversion.ts`); {@link planLayoutConversion} only decides whether
 * every element it touches may take the write.
 */
import type { SequencedMove } from '@core/page-tree'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { resolveActiveTreeTarget } from './helpers'
import { applyInlineStylePatch } from './inlineStyleActions'
import { inlinedSourceInstanceCount } from './nodeIndex'
import { planLayoutConversion, type LayoutConversionWrite } from './layoutConversionPlan'
import { presentStructuralRefusal, STRUCTURAL_REFUSAL_TITLE } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

type LayoutConversionActions = Pick<SiteSlice, 'convertLayout'>

/** The moves that turn `current` into `target`, each against the order the one before leaves. */
export function reorderMoves(parentId: string, current: readonly string[], target: readonly string[]): SequencedMove[] {
  const working = [...current]
  const moves: SequencedMove[] = []
  target.forEach((nodeId, index) => {
    const from = working.indexOf(nodeId)
    if (from === index || from < 0) return
    working.splice(from, 1)
    working.splice(index, 0, nodeId)
    moves.push({ nodeId, parentId, index })
  })
  return moves
}

export function createLayoutConversionActions(helpers: SiteSliceHelpers): LayoutConversionActions {
  const { get, set, mutateTreesForNodeIds } = helpers

  return {
    convertLayout: (request) => {
      const index = get()
      const tree = resolveActiveTreeTarget(index)?.tree
      const parent = tree?.nodes[request.parentId]
      if (!tree || !parent) return 'noop'
      const writes: LayoutConversionWrite[] = [
        { nodeId: request.parentId, patch: request.parentPatch },
        ...request.childPatches,
      ]
      const facts = writes.flatMap((write) => {
        const node = tree.nodes[write.nodeId]
        return node ? [{ node, patch: write.patch }] : []
      })
      const plan = planLayoutConversion({ writes: facts, sharedCount: (nodeId) => inlinedSourceInstanceCount(index, nodeId) })
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.layoutConversion, plan.refusal.constraint, {
          nodeId: plan.refusal.remedyNodeId,
          getState: get,
          set,
        })
        return 'refused'
      }

      const applyStyles = (relocate: (nodeId: string) => string): boolean =>
        mutateTreesForNodeIds(
          writes.map((write) => relocate(write.nodeId)),
          (draft) => {
            let any = false
            for (const write of writes) {
              const node = draft.nodes[relocate(write.nodeId)]
              if (node && applyInlineStylePatch(node, write.patch)) any = true
            }
            return any
          },
        )

      const moves = request.order ? reorderMoves(request.parentId, parent.children, request.order) : []
      if (moves.length === 0) return applyStyles((nodeId) => nodeId) ? 'applied' : 'noop'

      get().moveNodesInSequence(moves)
      const after = resolveActiveTreeTarget(get())?.tree.nodes[request.parentId]
      // A refused reorder (it said why) leaves the children where they were: write nothing.
      if (!after || request.order!.some((nodeId, position) => after.children[position] !== nodeId)) return 'refused'
      const allIds = writes.map((write) => write.nodeId)
      if (!deferWhileStructuralCommitInFlight((relocate) => void applyStyles(relocate), allIds)) {
        applyStyles((nodeId) => nodeId)
      }
      return 'applied'
    },
  }
}
