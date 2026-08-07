import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import { getParent, isAncestor } from './selectors'

export type PageTreeDropPosition = 'before' | 'after' | 'inside'
type PageTreeDropZone = PageTreeDropPosition

export interface PageTreeDropTarget {
  /** The pivot drag id: the row/handle the user grabbed. */
  draggedId: string
  /** Every dragged id when this is a multi-drag; `[draggedId]` for single. */
  draggedIds: string[]
  parentId: string
  index: number
  position: PageTreeDropPosition
  slot: 'default'
  overId: string
}

interface ResolvePageTreeDropTargetInput {
  tree: NodeTree<PageNode>
  /** The pivot id: the node the user grabbed. */
  draggedId: string
  /**
   * All ids being dragged. Defaults to `[draggedId]` for single-drag callers.
   * Cycle, lock, and no-self-drop checks consider every id in this list.
   */
  draggedIds?: string[]
  overId: string
  zone: PageTreeDropZone
  canHaveChildren: (moduleId: string) => boolean
}

export function resolvePageTreeDropTarget({
  tree,
  draggedId,
  draggedIds: draggedIdsInput,
  overId,
  zone,
  canHaveChildren,
}: ResolvePageTreeDropTargetInput): PageTreeDropTarget | null {
  const dragged = tree.nodes[draggedId]
  const over = tree.nodes[overId]
  if (!dragged || !over) return null

  const draggedIds = draggedIdsInput ?? [draggedId]

  for (const id of draggedIds) {
    if (id === tree.rootNodeId) return null
    const node = tree.nodes[id]
    if (!node) return null
    if (node.locked) return null
  }

  if (draggedIds.includes(overId)) return null

  if (zone === 'inside') {
    if (!canHaveChildren(over.moduleId)) return null

    // Slot instances under a VC ref are structural and locked, but their
    // children are the user-authored slot fill. Allow drops into those slots;
    // keep every other locked node closed.
    if (over.locked && over.moduleId !== 'base.slot-instance') return null

    // A visual-component-ref's direct children are managed slot-instance nodes.
    // User-authored content must enter through one of those slot instances.
    if (over.moduleId === 'base.visual-component-ref') return null

    for (const id of draggedIds) {
      if (isAncestor(tree, id, overId)) return null
    }

    const index = normalizeIndexAfterRemoval(tree, draggedIds, overId, over.children.length)
    return noOpTarget(tree, draggedIds, overId, index)
      ? null
      : {
          draggedId,
          draggedIds,
          parentId: overId,
          index,
          position: 'inside',
          slot: 'default',
          overId,
        }
  }

  if (overId === tree.rootNodeId) return null
  const parent = getParent(tree, overId)
  if (!parent) return null
  if (parent.locked) return null

  // Direct children of a visual-component-ref are slot instances owned by
  // syncSlotInstances; do not allow arbitrary siblings under that parent.
  if (parent.moduleId === 'base.visual-component-ref') return null

  for (const id of draggedIds) {
    if (isAncestor(tree, id, parent.id)) return null
  }

  const overIndex = parent.children.indexOf(overId)
  if (overIndex === -1) return null

  const rawIndex = zone === 'before' ? overIndex : overIndex + 1
  const index = normalizeIndexAfterRemoval(tree, draggedIds, parent.id, rawIndex)

  return noOpTarget(tree, draggedIds, parent.id, index)
    ? null
    : {
        draggedId,
        draggedIds,
        parentId: parent.id,
        index,
        position: zone,
        slot: 'default',
        overId,
      }
}

/**
 * `moveNodes` (mutations.ts) detaches EVERY id in `draggedIds` from its
 * current parent before splicing into the new one (top-down, all at once —
 * see mutations.ts:580-587). A raw drop index computed against the
 * PRE-removal children array must therefore be discounted by every dragged
 * sibling that sits at an index below it in `parentId`'s children today, not
 * just the pivot (`draggedIds[0]`) — discounting only the pivot under-shifts
 * the index by (removedBefore - 1) for an n>1 drag, landing the group too far
 * to the right (G10).
 */
function normalizeIndexAfterRemoval(
  tree: NodeTree<PageNode>,
  draggedIds: string[],
  parentId: string,
  rawIndex: number,
): number {
  let removedBefore = 0
  for (const draggedId of draggedIds) {
    const currentParent = getParent(tree, draggedId)
    if (!currentParent || currentParent.id !== parentId) continue
    const currentIndex = currentParent.children.indexOf(draggedId)
    if (currentIndex !== -1 && currentIndex < rawIndex) removedBefore++
  }
  return rawIndex - removedBefore
}

/**
 * Whether landing `draggedIds` at `index` inside `parentId` would leave
 * `parentId.children` byte-for-byte unchanged (a drop back onto its own
 * current position).
 *
 * **Must simulate the WHOLE group, not just the pivot (companion bug to
 * G10).** The single-drag version this replaced compared only the pivot's
 * OWN pre-move index against `index` — a comparison that is only meaningful
 * when exactly one node is removed, because then "pivot's original slot
 * number" and "pivot's post-removal target slot number" describe the SAME
 * bijection. For an n>1 drag those are indices into arrays of DIFFERENT
 * length (the full children list vs. the list with every dragged sibling
 * already removed), so they can coincide NUMERICALLY by pure accident on a
 * real, order-changing move — exactly what G10's fix (which makes `index`
 * finally correct) surfaced: a group of 2 landing at the tail of a 4-item
 * list can compute the same integer as the pivot's own original index,
 * false-positive-canceling a real reorder. Mirrors `moveNodes`'
 * (`mutations.ts`) own detach-then-splice arithmetic exactly, and
 * `sourceStructure.ts`'s `simulateStructuralReorder` (the source-writeback
 * preview's identical twin, kept in sync by hand — see that function's doc).
 */
function noOpTarget(
  tree: NodeTree<PageNode>,
  draggedIds: readonly string[],
  parentId: string,
  index: number,
): boolean {
  const parent = tree.nodes[parentId]
  if (!parent) return false
  const moving = draggedIds.filter((id) => parent.children.includes(id))
  if (moving.length === 0) return false
  const without = parent.children.filter((id) => !moving.includes(id))
  const at = Math.max(0, Math.min(index, without.length))
  const next = [...without.slice(0, at), ...moving, ...without.slice(at)]
  return next.length === parent.children.length && next.every((id, i) => id === parent.children[i])
}
