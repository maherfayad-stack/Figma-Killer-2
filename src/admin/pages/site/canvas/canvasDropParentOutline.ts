/**
 * canvasDropParentOutline — which container a before/after drop lands IN
 * (P2-E / IX-24).
 *
 * A drop line says "between these two". In nested flex rows it does not say
 * between them INSIDE WHICH container: a line at the end of an inner row and
 * a line at the start of the next outer row can sit on the same pixels. An
 * "inside" drop already outlines its container (the drop box IS the parent),
 * so only the before/after positions need a second answer. Penpot draws the
 * target frame's outline while you move over it (`transforms.cljs:752-761`).
 *
 * The rect comes from the candidate index the drop was resolved against —
 * the same rects, the same space, already measured this gesture — so this is
 * a lookup, never a layout read. A parent with no candidate (hidden, or not
 * rendered in this frame) gets no outline rather than a guessed one.
 */
import type { CanvasDropCandidate, CanvasRect } from './canvasDnd'
import type { PageTreeDropPosition } from '@core/page-tree'

interface DropTargetLike {
  parentId: string
  position: PageTreeDropPosition
}

/**
 * The rect to outline for `target`, or `null` for an "inside" drop (the drop
 * box already is the parent) and for a parent the index does not hold.
 */
export function dropParentOutlineRect(
  target: DropTargetLike | null,
  candidates: readonly CanvasDropCandidate[],
): CanvasRect | null {
  if (!target || target.position === 'inside') return null
  return candidates.find((candidate) => candidate.nodeId === target.parentId)?.rect ?? null
}
