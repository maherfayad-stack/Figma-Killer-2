/**
 * siblingSteps — "move the selection N places among its siblings", as the
 * smallest set of SINGLE-ELEMENT moves that produces it (P2-C2, OD-16).
 *
 * ## Why single-element moves
 *
 * A source reorder is written one element at a time (`moveJsxElement`: "put
 * this element before/after that one"), and `refuseStructuralEdit` refuses a
 * multi-element reorder outright, because N elements written against anchors
 * the previous write already moved have no single honest target. But most
 * multi-selection steps do not need N elements to move:
 *
 *   - a run of k ≥ 2 contiguous selected siblings stepping one place is the
 *     ONE unselected neighbour on that side jumping over the run;
 *   - a single selected element stepping N places (a grid row) is that
 *     element moving N places.
 *
 * Each move touches only its own REGION — the run plus the element that
 * crosses it. Regions never overlap (every unselected sibling neighbours at
 * most one run in a given direction), and a region never contains another
 * run's parent (checked below), so the moves are independent: each is valid
 * against the tree as it was, in any order, and a save batch applied
 * bottom-to-top (`orderStudioEditsForApply`) cannot shift a pending one's
 * line. That is what makes a whole multi-selection step ONE write and ONE
 * undo entry, and its inverse the same shape.
 *
 * ## What does not move
 *
 *   - a run already at the end it is stepping towards, or a single layer
 *     whose step would pass the end (Figma's clamp) — the
 *     other runs still move, and nothing overtakes anything;
 *   - a descendant of another selected layer (it rides with its ancestor);
 *   - a parent the caller gives no step for (an arrow across its axis).
 *
 * ## What refuses
 *
 *   - `multi-row` — a run of 2+ stepping more than one place (a grid row),
 *     or two single layers whose grid-row moves cross the same siblings.
 *     That is k elements crossing the run, all in one region; it is P3-D's
 *     chained queue, not an independent batch;
 *   - `nested` — one run's region contains another run's parent, so one
 *     write would change the bytes the other is written against;
 *   - `locked` — a selected layer is locked (the layer lock, `node.locked`).
 */
import type { NodeTree } from './treeSchema'
import type { PageNode } from './pageNode'

/** One element moved within its own parent: `index` is where it lands, counted after it is detached (`moveNode`'s convention). */
export interface SiblingMove {
  nodeId: string
  parentId: string
  index: number
  /** Where it sat before — the inverse move's `index`. */
  fromIndex: number
}

export type SiblingStepRefusal = 'multi-row' | 'nested' | 'locked'

export type SiblingStepPlan =
  | { ok: true; moves: SiblingMove[] }
  | { ok: false; reason: SiblingStepRefusal }

/**
 * The selected ids that move on their own: present, not the root, and not
 * inside another selected node. Order follows `nodeIds`.
 */
export function topLevelSelection(tree: NodeTree<PageNode>, nodeIds: readonly string[]): string[] {
  // The root never moves, so it carries nothing: a selection holding it
  // still moves its other members.
  const selected = new Set(nodeIds.filter((id) => id !== tree.rootNodeId))
  return nodeIds.filter((id) => {
    const node = tree.nodes[id]
    if (!node || id === tree.rootNodeId) return false
    let parentId = node.parentId
    while (parentId) {
      if (selected.has(parentId)) return false
      parentId = tree.nodes[parentId]?.parentId ?? null
    }
    return true
  })
}

/** True when `nodeId` is `ancestorId` or sits inside it. */
function isSelfOrDescendant(tree: NodeTree<PageNode>, nodeId: string, ancestorId: string): boolean {
  let current: string | null | undefined = nodeId
  while (current) {
    if (current === ancestorId) return true
    current = tree.nodes[current]?.parentId
  }
  return false
}

interface Run {
  parentId: string
  start: number
  end: number
}

/**
 * The single-element moves that step every selected layer `stepOf(parentId)`
 * places among its siblings (negative = towards the first child). A parent
 * whose step is `null` or `0` does not move.
 */
export function planSiblingSteps(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  stepOf: (parentId: string) => number | null,
): SiblingStepPlan {
  const selection = topLevelSelection(tree, nodeIds)
  if (selection.some((id) => tree.nodes[id]?.locked === true)) return { ok: false, reason: 'locked' }

  const byParent = new Map<string, number[]>()
  for (const id of selection) {
    const parentId = tree.nodes[id]?.parentId
    if (!parentId) continue
    const index = tree.nodes[parentId]?.children.indexOf(id) ?? -1
    if (index < 0) continue
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), index])
  }

  const moves: SiblingMove[] = []
  const regions: { run: Run; low: number; high: number; memberIds: string[] }[] = []
  for (const [parentId, indices] of byParent) {
    const step = stepOf(parentId)
    if (!step) continue
    const children = tree.nodes[parentId]!.children
    const sorted = [...indices].sort((a, b) => a - b)
    const runs: Run[] = []
    for (const index of sorted) {
      const last = runs.at(-1)
      if (last && index === last.end + 1) last.end = index
      else runs.push({ parentId, start: index, end: index })
    }
    for (const run of runs) {
      const length = run.end - run.start + 1
      if (length === 1) {
        // One element: it moves itself, however far. A step past either end
        // (the last grid row stepping down) moves nothing — it is not a
        // shorter step.
        const target = run.start + step
        if (target < 0 || target > children.length - 1) continue
        if (target === run.start) continue
        moves.push({ nodeId: children[run.start]!, parentId, index: target, fromIndex: run.start })
        const low = Math.min(run.start, target)
        const high = Math.max(run.start, target)
        regions.push({ run, low, high, memberIds: children.slice(low, high + 1) })
        continue
      }
      if (Math.abs(step) !== 1) return { ok: false, reason: 'multi-row' }
      // The neighbour on the stepping side jumps over the run.
      const neighbourIndex = step > 0 ? run.end + 1 : run.start - 1
      const neighbourId = children[neighbourIndex]
      if (neighbourId === undefined) continue
      moves.push(
        step > 0
          ? { nodeId: neighbourId, parentId, index: run.start, fromIndex: neighbourIndex }
          : { nodeId: neighbourId, parentId, index: run.end, fromIndex: neighbourIndex },
      )
      const low = Math.min(run.start, neighbourIndex)
      const high = Math.max(run.end, neighbourIndex)
      regions.push({ run, low, high, memberIds: children.slice(low, high + 1) })
    }
  }

  for (const region of regions) {
    for (const other of regions) {
      if (other === region) continue
      if (other.run.parentId === region.run.parentId) {
        // Two single layers a grid row apart cross the same siblings: their
        // regions overlap, and the two moves are no longer independent.
        if (other.low <= region.high && region.low <= other.high) return { ok: false, reason: 'multi-row' }
        continue
      }
      // No region may hold another moving parent: one write would change the
      // bytes the other is written against.
      if (region.memberIds.some((memberId) => isSelfOrDescendant(tree, other.run.parentId, memberId))) {
        return { ok: false, reason: 'nested' }
      }
    }
  }
  return { ok: true, moves }
}

/** The moves that take `moves` back, in the same independent-batch shape. */
export function invertSiblingMoves(moves: readonly SiblingMove[]): SiblingMove[] {
  return moves.map((move) => ({ ...move, index: move.fromIndex, fromIndex: move.index }))
}
