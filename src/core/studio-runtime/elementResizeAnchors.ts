/**
 * elementResizeAnchors — a resize of a positioned layer writes the offsets
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
 * Shared by both kinds of frame (PA-8). A portal drag reads the authored
 * offsets off the store; a live (Tier 2) frame has no store, so the parent
 * sends WHICH offsets are authored with the target (`ResizeAnchors`,
 * `resizeTargetContext.ts`) and the frame reads their used values itself
 * ({@link resizeAnchorPlan}). A live W-drag on a right-anchored layer therefore
 * writes the width alone, exactly as a portal drag does.
 */
import type { ResizeBoxStart, ResizeStep } from './elementResizeRules'
import type { OffsetProperty, ResizeAnchors } from './resizeMessages'
import { inlineOffsetProperty } from './elementResizeMeasure'
import type { ResizeInlinePatch } from './elementResizeSizing'

/** One offset a gesture moves: `base + sign × delta`, in CSS px. */
export interface OffsetTerm {
  property: OffsetProperty
  /** `+1` when a move to visual right / down GROWS this offset (`left`, `top`), `-1` when it shrinks it (`right`, `bottom`). */
  sign: 1 | -1
  base: number
}

/** The offsets a layer is anchored by, with the values they have now. */
export interface OffsetPlan {
  horizontal: OffsetTerm[]
  vertical: OffsetTerm[]
}

/** The computed-style facts a term is read from — plain strings, so the rules are testable without a DOM. */
export interface OffsetStyle {
  direction: string
  left: string
  right: string
  top: string
  bottom: string
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The term for one offset: a logical inset IS one physical side for the element's direction. */
export function offsetTerm(property: OffsetProperty, style: OffsetStyle): OffsetTerm {
  const rtl = style.direction === 'rtl'
  const physical =
    property === 'insetInlineStart' ? (rtl ? 'right' : 'left')
      : property === 'insetInlineEnd' ? (rtl ? 'left' : 'right')
        : property
  if (physical === 'top' || physical === 'bottom') {
    return { property, sign: physical === 'top' ? 1 : -1, base: px(physical === 'top' ? style.top : style.bottom) }
  }
  return { property, sign: physical === 'left' ? 1 : -1, base: px(physical === 'left' ? style.left : style.right) }
}

/** The plan for `anchors`, the offsets' bases read from the element's computed style. */
export function resizeAnchorPlan(anchors: ResizeAnchors, style: OffsetStyle): OffsetPlan {
  const terms = (properties: readonly OffsetProperty[], fallback: OffsetProperty): OffsetTerm[] =>
    (properties.length > 0 ? properties : [fallback]).map((property) => offsetTerm(property, style))
  return {
    horizontal: terms(anchors.horizontal, inlineOffsetProperty(style.direction)),
    vertical: terms(anchors.vertical, 'top'),
  }
}

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

function termValue(term: OffsetTerm, startShift: number, endShift: number): number {
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
  plan: OffsetPlan | null,
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
