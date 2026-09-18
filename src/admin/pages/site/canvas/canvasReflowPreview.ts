/**
 * canvasReflowPreview — K6's open half (`canvas-19`): while a body drag is in
 * flight, the siblings that would MAKE ROOM for the drop slide out of the way.
 *
 * ## What this answers, and what it refuses to guess
 *
 * Given the drop target the session already resolved, it returns one
 * `CanvasReflowShift` per sibling whose box would move if the drop landed —
 * the sibling's CURRENT rect and the delta it would travel. Nothing else: it
 * resolves no target, reads no DOM, and paints nothing.
 *
 * Every number comes from the drag session's already-measured candidate index
 * (`canvasDragSession.ts`), so **the preview costs zero layout reads**. That is
 * not an optimisation, it is the only way this could exist at all: a reflow
 * preview that measured the page would measure it on every animation frame of
 * every drag, which is precisely the defect S2 removed.
 *
 * ## The packing model, and the three cases it stands down for
 *
 * A container's children are packed along ONE axis with a uniform gap — the
 * model every ordinary block flow and single-line flex row/column actually
 * obeys. The final order is computed the way `moveNode` computes it (remove
 * the dragged run first, then insert at the target index — that is what
 * `newIndex` counts), each remaining child is re-packed from the container's
 * own content start using its OWN extent, and the shift is the difference.
 * Heterogeneous child sizes are therefore exact; a uniform "everything moves
 * by one slot height" would not be.
 *
 * It returns nothing at all — no animation, no lie — when the model does not
 * hold:
 *
 *  - **a child with no measured rect** (a `display: contents` host, a text
 *    node, a fragment): the pack has no extent for it, and guessing one would
 *    move every later sibling by the wrong amount;
 *  - **children that are not monotonic along the axis** — a wrapped flex line,
 *    a multi-row grid, an absolutely-positioned child overlapping a sibling.
 *    Re-packing those in one dimension is simply the wrong geometry;
 *  - **a `reversed` parent** (`row-reverse` / `column-reverse` / an RTL row).
 *    DOM order and visual order disagree there, and the honest version needs
 *    the visual-order mapping this model does not carry.
 *
 * Silence is the correct output for all three: the drop line still says
 * exactly where the element lands, and no sibling claims to move somewhere it
 * would not.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import type { CanvasDropAxis, CanvasDropCandidate, CanvasRect } from './canvasDnd'

/** One sibling that would move, and how far. Frame-space, like every rect here. */
export interface CanvasReflowShift {
  nodeId: string
  /** Where the sibling is NOW — the box the preview is drawn over. */
  rect: CanvasRect
  /** How far it would travel if the drop landed, in frame-space pixels. */
  dx: number
  dy: number
}

export interface CanvasReflowInput {
  /** The tree the DROP is resolved against (the destination frame's, when they differ). */
  tree: NodeTree<PageNode>
  /** That same frame's measured candidates — never re-measured here. */
  candidates: readonly CanvasDropCandidate[]
  /** The container the drop landed in. */
  parentId: string
  /** Where among `parentId`'s children, counted AFTER the dragged run is removed (`moveNode`'s own reading). */
  index: number
  /** The dragged selection, in the tree that owns it. */
  draggedIds: readonly string[]
  /** How much room the dragged run needs along the target's axis, in frame space. */
  draggedExtent: number
  /**
   * The container the dragged run is leaving, when this drag can see it — the
   * same tree only. `null` for a cross-frame drop: the origin frame's layer is
   * not the one being painted (`canvasDragFrame.ts`'s own rule), so a shift
   * drawn for it would be drawn where nobody can see it.
   */
  originParentId: string | null
  /** Alt held: nothing leaves the origin list, so only the destination opens up. */
  copy: boolean
}

/**
 * How many siblings may animate at once. A drop into a 300-row list would
 * otherwise mint 300 overlay boxes for a preview that is legible from the
 * first dozen — and the pool that paints them is per frame, per drag.
 */
export const REFLOW_SHIFT_LIMIT = 12

/** The siblings that would move, or an empty array when the model does not hold. */
export function resolveCanvasReflowShifts(input: CanvasReflowInput): CanvasReflowShift[] {
  const rectByNodeId = new Map<string, CanvasDropCandidate>()
  for (const candidate of input.candidates) rectByNodeId.set(candidate.nodeId, candidate)

  const shifts: CanvasReflowShift[] = []
  packContainer(shifts, input, rectByNodeId, input.parentId, input.index)

  // The list the run is LEAVING closes up behind it. Skipped for a copy
  // (nothing leaves) and for a same-container reorder (already accounted for
  // by the pack above, which removed the run before inserting it).
  const origin = input.originParentId
  if (!input.copy && origin && origin !== input.parentId) {
    packContainer(shifts, input, rectByNodeId, origin, null)
  }

  return shifts.length > REFLOW_SHIFT_LIMIT ? shifts.slice(0, REFLOW_SHIFT_LIMIT) : shifts
}

/**
 * Re-pack one container and append every child that moves.
 *
 * `insertAt` is `null` for the container the run is only LEAVING — there is no
 * placeholder to make room for there, just a hole to close.
 */
function packContainer(
  out: CanvasReflowShift[],
  input: CanvasReflowInput,
  rectByNodeId: Map<string, CanvasDropCandidate>,
  parentId: string,
  insertAt: number | null,
): void {
  const parent = input.tree.nodes[parentId]
  if (!parent) return
  const childIds = parent.children
  if (childIds.length === 0) return

  const measured: CanvasDropCandidate[] = []
  for (const childId of childIds) {
    const candidate = rectByNodeId.get(childId)
    // A child with no box of its own (see this module's doc) — stand down for
    // the whole container rather than pack around a hole of unknown size.
    if (!candidate) return
    // DOM order and visual order disagree here; the pack is DOM-ordered.
    if (candidate.reversed) return
    measured.push(candidate)
  }

  // Every child of one container reports the same axis — it is the PARENT's
  // layout direction (`resolveCanvasInsertionAxis`), not the child's own.
  const axis = measured[0]!.axis
  if (!isMonotonicAlongAxis(measured, axis)) return

  const gap = packingGap(measured, axis)
  const contentStart = axisStart(measured[0]!.rect, axis)

  const removed = input.copy ? new Set<string>() : new Set(input.draggedIds)
  const remaining: CanvasDropCandidate[] = []
  for (const candidate of measured) {
    if (!removed.has(candidate.nodeId)) remaining.push(candidate)
  }

  // `moveNode` removes first and then splices at `newIndex`, so the index
  // counts THIS list, not the one that still holds the dragged run.
  const placeholderAt = insertAt === null ? -1 : clamp(insertAt, 0, remaining.length)

  let cursor = contentStart
  for (let i = 0; i <= remaining.length; i++) {
    if (i === placeholderAt) cursor += input.draggedExtent + gap
    const candidate = remaining[i]
    if (!candidate) break
    const delta = cursor - axisStart(candidate.rect, axis)
    cursor += axisExtent(candidate.rect, axis) + gap
    // A sub-pixel delta is a rounding artefact of the measured rects, not a
    // reflow — animating it would jitter every sibling on every frame.
    if (Math.abs(delta) < 0.5) continue
    out.push({
      nodeId: candidate.nodeId,
      rect: candidate.rect,
      dx: axis === 'horizontal' ? delta : 0,
      dy: axis === 'horizontal' ? 0 : delta,
    })
  }
}

/**
 * The gap between two consecutive children, read off the FIRST pair.
 *
 * One number for the whole container on purpose: a flex `gap` or a uniform
 * margin is the case this model is for, and averaging a list whose spacing is
 * genuinely irregular would produce a shift that is wrong everywhere instead
 * of right at the top. A single child has no spacing to observe, so it packs
 * with none.
 */
function packingGap(children: readonly CanvasDropCandidate[], axis: CanvasDropAxis): number {
  const first = children[0]
  const second = children[1]
  if (!first || !second) return 0
  const gap = axisStart(second.rect, axis) - (axisStart(first.rect, axis) + axisExtent(first.rect, axis))
  return gap > 0 ? gap : 0
}

/**
 * Whether the children genuinely lie in one line along `axis`, in DOM order.
 * A wrapped flex line or a grid row fails this, and so does an
 * absolutely-positioned child sitting on top of a sibling — all three are
 * layouts a one-dimensional re-pack would describe incorrectly.
 */
function isMonotonicAlongAxis(children: readonly CanvasDropCandidate[], axis: CanvasDropAxis): boolean {
  for (let i = 1; i < children.length; i++) {
    const previous = children[i - 1]!.rect
    const current = children[i]!.rect
    // Half a pixel of tolerance: rects come from `getBoundingClientRect`
    // divided by the canvas scale, so exact edge contact lands just either
    // side of equality.
    if (axisStart(current, axis) + 0.5 < axisStart(previous, axis) + axisExtent(previous, axis)) return false
  }
  return true
}

function axisStart(rect: CanvasRect, axis: CanvasDropAxis): number {
  return axis === 'horizontal' ? rect.left : rect.top
}

function axisExtent(rect: CanvasRect, axis: CanvasDropAxis): number {
  return axis === 'horizontal' ? rect.width : rect.height
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
