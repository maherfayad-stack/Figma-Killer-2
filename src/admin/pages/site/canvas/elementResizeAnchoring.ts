/**
 * elementResizeAnchoring — a resize of a positioned layer writes the offsets
 * its source ANCHORS it by (P5-E, IX-21).
 *
 * `elementResizeRules.ts` (shared with the live runtime's handles) keeps the
 * opposite edge still by moving `left` / `top` (IX-6d). That is right for a
 * layer anchored by `left` / `top`, and wrong for one anchored by `right` or
 * `bottom`: a W-handle drag on `right: 24px; width: 200px` wrote a `left`
 * beside the `right` (P2-D and P2-C found it), so the source carried both
 * and the next width change moved the wrong edge. Here the step the shared
 * rules produced is read back as EDGE movements, and those are written onto
 * the offsets the layer actually has (`planNudge` over `authoredOffsets`, the
 * same plan a nudge and a free move use):
 *
 *   - `left` / `top` (or `insetInlineStart` in LTR) follow the START edge;
 *   - `right` / `bottom` follow the END edge — a W drag on a right-anchored
 *     layer writes the width alone, an E drag moves `right` in by the growth;
 *   - `left` + `right` (a stretched layer) both follow their edges.
 *
 * Portal frames only, like the snapping: the live runtime's handles do not
 * have the node's authored styles on their side of the wire.
 */
import type { ResizeBoxStart, ResizeStep } from '@core/studio-runtime'
import type { NudgePlan, NudgeTerm } from './canvasNodeArrowMove'
import type { ResizeInlinePatch } from './elementResizeSizing'

/** The offset keys the shared rules may put in a patch — replaced wholesale here. */
const RULE_OFFSET_KEYS = ['left', 'insetInlineStart', 'top'] as const

/**
 * How far each visual edge moved in this step, CSS px, positive = right/down.
 * Read back from the shared rules' step: the start edge from the offset they
 * wrote, the end edge from that plus the growth.
 */
export function resizeEdgeShifts(start: ResizeBoxStart, step: ResizeStep): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const growX = step.width - Math.round(start.width)
  const growY = step.height - Math.round(start.height)
  const offsets = start.offsets
  if (!offsets || step.inline === null || step.top === null) return { left: 0, right: growX, top: 0, bottom: growY }
  const inlineDelta = step.inline - Math.round(offsets.inline)
  // Under RTL the rules' inline offset is the distance from the RIGHT side:
  // it shrinks by exactly as much as the right edge moves right.
  const left = offsets.inlineProperty === 'left' ? inlineDelta : -inlineDelta - growX
  const top = step.top - Math.round(offsets.top)
  return { left, right: left + growX, top, bottom: top + growY }
}

function termValue(term: NudgeTerm, startShift: number, endShift: number): number {
  // `sign: 1` is a start-side offset (left / top): it grows as that edge moves
  // right / down. `sign: -1` is an end-side one (right / bottom): it shrinks.
  return term.sign === 1 ? term.base + startShift : term.base - endShift
}

/**
 * `patch` (the shared rules' size + offsets, plus the sizing companions) with
 * its offsets replaced by the layer's authored ones. `plan` is `null` for a
 * flow element, which has no offsets and passes through untouched.
 */
export function anchorResizePatch(
  patch: ResizeInlinePatch | null,
  start: ResizeBoxStart,
  step: ResizeStep,
  plan: NudgePlan | null,
): ResizeInlinePatch | null {
  if (!patch || !plan || !start.offsets) return patch
  const next: Record<string, string | undefined> = { ...patch }
  for (const key of RULE_OFFSET_KEYS) delete next[key]
  const shifts = resizeEdgeShifts(start, step)
  for (const term of plan.horizontal) {
    const moved = term.sign === 1 ? shifts.left : shifts.right
    if (moved !== 0) next[term.property] = `${Math.round(termValue(term, shifts.left, shifts.right))}px`
  }
  for (const term of plan.vertical) {
    const moved = term.sign === 1 ? shifts.top : shifts.bottom
    if (moved !== 0) next[term.property] = `${Math.round(termValue(term, shifts.top, shifts.bottom))}px`
  }
  return Object.keys(next).length > 0 ? (next as ResizeInlinePatch) : null
}
