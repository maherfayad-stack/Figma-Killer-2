/**
 * canvasTransplantDrop - where a drag that crossed into ANOTHER frame lands.
 *
 * Split out of `canvasDnd.ts` (module-size ceiling): the same-frame resolvers
 * stay there, and this module is their cross-frame counterpart. It asks the
 * destination the question an insertion asks - "which container, and where
 * among its children" - through the same helpers (`resolvePageTreeInsertionTarget`,
 * `nearestFlowIndex`, `flowGapLine`), so a drop released between two siblings
 * lands between them, with the same line, in either frame.
 */
import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import {
  explainGestureConstraint,
  previewStructuralTransplant,
  type PageTreeDropPosition,
  type StructuralTransplantPreview,
} from '@core/page-tree'
import {
  findCanvasDropCandidate,
  flowGapLine,
  getCanvasDropZone,
  nearerSiblingSide,
  nearestFlowIndex,
  resolvePageTreeInsertionTarget,
  type CanvasDropCandidate,
  type CanvasInsertionTarget,
  type CanvasInvalidDropTarget,
  type CanvasPoint,
} from './canvasDnd'

/**
 * Where a cross-frame drop would land, in the DESTINATION tree's own terms.
 * Structurally identical to {@link CanvasInsertionTarget} because the question
 * is the same one — see `resolveCanvasTransplantTarget` — and named separately
 * because a reader tracing a DRAG should not have to know that.
 */
export type CanvasTransplantTarget = CanvasInsertionTarget

export interface CanvasTransplantResolution {
  target: CanvasTransplantTarget | null
  invalid: CanvasInvalidDropTarget | null
}

interface ResolveCanvasTransplantTargetInput {
  /** The tree the dragged element is written in. */
  originTree: NodeTree<PageNode>
  /** The tree the pointer is currently over — a DIFFERENT page. */
  destinationTree: NodeTree<PageNode>
  /** The dragged selection, in the origin tree's terms. */
  draggedIds: readonly string[]
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (node: PageNode) => boolean
  /** Alt held: the drop copies across frames instead of moving. */
  copy: boolean
  /** Live canvas zoom (1 = 100%). See `getCanvasDropZone`. Defaults to 1. */
  zoom?: number
}

/**
 * D2 G3 — where a drag that crossed into ANOTHER frame would land, and
 * whether it would be refused.
 *
 * **Resolution is an INSERT's question, not a move's.** The dragged element is
 * not in this tree at all, so `resolvePageTreeDropTarget`'s cycle and
 * self-drop guards have nothing to check and its `draggedIds` have no meaning
 * here. What the destination is being asked is exactly what the picker asks —
 * "which container, and where among its children" — which is
 * `resolveCanvasInsertionTarget`, already built for that question.
 *
 * **The verdict is `previewStructuralTransplant`'s**, and it is asked WHILE
 * THE POINTER IS STILL DOWN for the reason `resolveCanvasDropTarget` documents
 * for its own preview: a refusal that only arrives as a toast after release
 * reaches the user once they have let go and moved on. The store's own gate
 * (`transplantNodes`) remains the sole commit-time authority; this is a
 * preview of it, never a replacement.
 */
export function resolveCanvasTransplantTarget({
  originTree,
  destinationTree,
  draggedIds,
  candidates,
  point,
  canHaveChildren,
  copy,
  zoom = 1,
}: ResolveCanvasTransplantTargetInput): CanvasTransplantResolution {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return { target: null, invalid: null }

  const zone = getCanvasDropZone(candidate, point, zoom)
  const verdict = resolveTransplantDropOver({
    originTree,
    destinationTree,
    draggedIds,
    overId: candidate.nodeId,
    zone,
    nearerSide: nearerSiblingSide(candidate, point),
    // The same question `resolveCanvasInsertionTarget` asks of a press in a
    // container's own space: among which children, not always after the last.
    indexAmongChildren: (containerId) => nearestFlowIndex(destinationTree, containerId, candidates, point),
    canHaveChildren,
    copy,
  })
  if (!verdict.target) {
    return { target: null, invalid: { overId: candidate.nodeId, rect: candidate.rect, axis: candidate.axis } }
  }
  if (verdict.preview && !verdict.preview.ok) {
    const preview = verdict.preview
    // The refusal names one end of the gesture; the chip is rendered beside
    // the pointer either way, so the node it is dressed against is whichever
    // `previewStructuralTransplant` says it is about.
    const about =
      (preview.nodeId === undefined
        ? undefined
        : (originTree.nodes[preview.nodeId] ?? destinationTree.nodes[preview.nodeId])) ??
      originTree.nodes[draggedIds[0] ?? ''] ?? { id: draggedIds[0] ?? '' }
    const constraint = explainGestureConstraint(preview, about)
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
        ...(constraint ? { constraint } : {}),
      },
    }
  }

  const { target } = verdict
  const gap =
    target.position === 'inside' && target.overId === target.parentId
      ? flowGapLine(destinationTree, target.parentId, candidates, target.index, candidate)
      : null
  return {
    target: {
      ...target,
      rect: candidate.rect,
      axis: candidate.axis,
      ...(candidate.reversed ? { reversed: true } : {}),
      ...(gap ? { gap } : {}),
    },
    invalid: null,
  }
}

interface ResolveTransplantDropOverInput {
  originTree: NodeTree<PageNode>
  destinationTree: NodeTree<PageNode>
  draggedIds: readonly string[]
  /** The destination node the pointer is over. */
  overId: string
  zone: PageTreeDropPosition
  /** Which side a drop on the middle of a leaf lands on; a caller with no pointer keeps the append convention. */
  nearerSide?: 'before' | 'after'
  /**
   * Where among a container's children a press in its OWN space lands, or
   * `null` when none were measured. A caller with no geometry (the Layers
   * panel) omits it and keeps the append.
   */
  indexAmongChildren?: (containerId: string) => number | null
  canHaveChildren: (node: PageNode) => boolean
  copy: boolean
}

/**
 * The ONE cross-page drop question, asked by the canvas (pointer over a frame)
 * and by the Layers panel (pointer over another page's row): given the node
 * under the pointer and the zone of it, which container and index in the
 * DESTINATION tree, and would `transplantNodes` accept it?
 *
 * `target` is `null` when the destination has no valid position there at all;
 * `preview` is the store gate's own verdict for a position that exists, and a
 * refusal in it carries the sentence both surfaces show while the pointer is
 * down. Geometry (rects, axis) is deliberately not part of this: it is the
 * canvas's.
 */
export function resolveTransplantDropOver({
  originTree,
  destinationTree,
  draggedIds,
  overId,
  zone,
  nearerSide,
  indexAmongChildren,
  canHaveChildren,
  copy,
}: ResolveTransplantDropOverInput): {
  target: Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null
  preview: StructuralTransplantPreview | null
} {
  const resolved = resolvePageTreeInsertionTarget({
    tree: destinationTree,
    overId,
    zone,
    nearerSide,
    canHaveChildren,
  })
  if (!resolved) return { target: null, preview: null }
  const amongChildren =
    resolved.position === 'inside' && resolved.overId === resolved.parentId
      ? indexAmongChildren?.(resolved.parentId)
      : null
  const target = amongChildren == null ? resolved : { ...resolved, index: amongChildren }
  const preview = previewStructuralTransplant({
    originTree,
    nodeIds: draggedIds,
    destinationTree,
    newParentId: target.parentId,
    newIndex: target.index,
    copy,
  })
  return { target, preview }
}

