/**
 * canvasFrameSelectionPlan (PA-6) — the pure half of Frame selection (⌥⌘G):
 * given what was measured, the inline style the new frame is written with and
 * the patch each member needs so nothing moves on screen — or the sentence
 * saying why there is no honest frame.
 *
 * ## Two kinds of selection
 *
 * **Placed layers** (every member `position: absolute`). The frame is
 * `position: absolute` at the union of the members' rects, measured against
 * the parent's REAL padding box (`containingBlockOffsets`), with that union's
 * size. Every member's authored offsets are rebased by the frame's own: a
 * `left` loses the frame's left inset, a `right` the frame's right inset
 * (`planNudge` names which properties the source authored, so a right-anchored
 * layer stays right-anchored). The frame becomes the members' containing
 * block, so they keep their place and, unlike a flow, keep following their
 * edges when it resizes.
 *
 * **Flowed layers** (none absolute). The frame is a plain container in the
 * members' place (OD-P3): no pixel is frozen. Inside an auto-layout parent it
 * carries that parent's flex layout so the members keep running the same way.
 * Three things cannot be kept exactly and refuse by name instead: a grid
 * parent, a parent that spaces its items (`justify-content: space-*`, which a
 * shrink-wrapped frame cannot reproduce), and a member that grows to fill
 * (`flex-grow`).
 *
 * A selection that mixes the two refuses: one container cannot be both placed
 * and laid out. A `fixed` or percentage / `calc()` / `var()`-positioned layer
 * refuses too — rewriting it to pixels would freeze what the user made
 * responsive.
 */
import {
  containingBlockOffsets,
  inlineOffsetProperty,
  isAutoLayoutDisplay,
  isOutOfFlow,
  autoLayoutFamily,
  type BoxRect,
  type ContainingBlockBox,
  type OffsetProperty,
} from '@core/studio-runtime'
import { planNudge, type ArrowTargetStyle } from './canvasNodeArrowMove'

/** One selected layer, as measured. */
export interface FrameMemberFacts {
  nodeId: string
  /** Frame-space border-box rect. */
  rect: BoxRect
  style: ArrowTargetStyle
  /** Computed `flex-grow`. */
  flexGrow: string
  /** The offsets the layer's source sets (`authoredOffsets`). */
  authored: ReadonlySet<OffsetProperty>
  /** The authored offsets whose value is not a plain length — a percentage, `calc()`, `var()`. */
  expressive: ReadonlySet<OffsetProperty>
}

/** The members' shared parent, as measured. */
export interface FrameParentFacts {
  /** Its box in the SAME space as the members' rects. */
  box: ContainingBlockBox
  /** Does it contain absolute children (positioned, transformed, …)? */
  containsAbsolute: boolean
  direction: string
  display: string
  flexDirection: string
  flexWrap: string
  columnGap: string
  rowGap: string
  alignItems: string
  justifyContent: string
}

export type FrameSelectionPlan =
  | {
      ok: true
      /** The frame's own inline style, in the order it is written. */
      wrapperStyle: Record<string, string>
      /** One patch per member, aligned with the input members (`null` removes a key). */
      memberStyles: Record<string, string | null>[]
    }
  | { ok: false; message: string }

const refuse = (message: string): FrameSelectionPlan => ({ ok: false, message })

const px = (value: number) => `${Math.round(value)}px`

/** The physical side an offset property names for a given direction. */
function physicalSide(property: OffsetProperty, direction: string): 'left' | 'right' | 'top' | 'bottom' {
  const rtl = direction === 'rtl'
  switch (property) {
    case 'insetInlineStart':
      return rtl ? 'right' : 'left'
    case 'insetInlineEnd':
      return rtl ? 'left' : 'right'
    default:
      return property
  }
}

function union(rects: readonly BoxRect[]): BoxRect {
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.left + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
  return { left, top, width: right - left, height: bottom - top }
}

export function planFrameSelection(members: readonly FrameMemberFacts[], parent: FrameParentFacts): FrameSelectionPlan {
  if (members.length === 0) return refuse('Select the layers to put in a frame.')
  if (members.some((member) => member.style.position === 'fixed')) {
    return refuse('A fixed layer is placed by the window, not by its container, so a frame around it would not hold it. Frame the layers that scroll with the page.')
  }
  const placed = members.filter((member) => isOutOfFlow(member.style.position))
  if (placed.length === 0) return planFlowFrame(members, parent)
  if (placed.length !== members.length) {
    return refuse('These layers are a mix of placed ones (absolute) and ones that sit in the flow, and one frame cannot be both. Select either the placed layers or the flowing ones.')
  }
  return planPlacedFrame(members, parent)
}

function planPlacedFrame(members: readonly FrameMemberFacts[], parent: FrameParentFacts): FrameSelectionPlan {
  if (!parent.containsAbsolute) {
    return refuse('These layers are positioned against an element further up, not their own container, so the frame would not sit where they are. Make their container position: relative first.')
  }
  const box = union(members.map((member) => member.rect))
  const offsets = containingBlockOffsets(box, parent.box)
  const inline = inlineOffsetProperty(parent.direction)
  const wrapperStyle: Record<string, string> = {
    position: 'absolute',
    [inline]: px(inline === 'left' ? offsets.left : offsets.right),
    top: px(offsets.top),
    width: px(box.width),
    height: px(box.height),
  }

  const memberStyles: Record<string, string | null>[] = []
  for (const member of members) {
    const plan = planNudge(member.style, member.authored)
    const patch: Record<string, string | null> = {}
    for (const term of [...plan.horizontal, ...plan.vertical]) {
      if (member.expressive.has(term.property)) {
        return refuse(`A layer in the selection is positioned with a percentage or an expression (${term.property}), and rewriting it to pixels would stop it following its container. Position it in pixels first, or frame the others.`)
      }
      patch[term.property] = px(term.base - offsets[physicalSide(term.property, member.style.direction)])
    }
    memberStyles.push(patch)
  }
  return { ok: true, wrapperStyle, memberStyles }
}

function planFlowFrame(members: readonly FrameMemberFacts[], parent: FrameParentFacts): FrameSelectionPlan {
  const memberStyles = members.map((): Record<string, string | null> => ({}))
  if (!isAutoLayoutDisplay(parent.display)) return { ok: true, wrapperStyle: {}, memberStyles }
  if (autoLayoutFamily(parent.display) === 'grid') {
    return refuse('These layers are cells of a grid, and a frame around some of them would take them out of their grid cells. Frame the whole grid, or use Group on layers in flow.')
  }
  if (/^space-/.test(parent.justifyContent)) {
    return refuse('The container spaces these layers across its width (justify-content), which a frame around some of them cannot keep. Change the spacing to a fixed gap first.')
  }
  if (members.some((member) => Number.parseFloat(member.flexGrow) > 0)) {
    return refuse('A layer in the selection grows to fill its container (flex-grow), and a frame around it would stop it filling. Set its width first.')
  }
  const wrapperStyle: Record<string, string> = { display: parent.display }
  if (parent.flexDirection && parent.flexDirection !== 'row') wrapperStyle.flexDirection = parent.flexDirection
  if (parent.flexWrap && parent.flexWrap !== 'nowrap') wrapperStyle.flexWrap = parent.flexWrap
  const rowGap = parent.rowGap === 'normal' ? '' : parent.rowGap
  const columnGap = parent.columnGap === 'normal' ? '' : parent.columnGap
  if (rowGap && rowGap === columnGap) wrapperStyle.gap = rowGap
  else {
    if (rowGap) wrapperStyle.rowGap = rowGap
    if (columnGap) wrapperStyle.columnGap = columnGap
  }
  if (parent.alignItems && parent.alignItems !== 'normal') wrapperStyle.alignItems = parent.alignItems
  return { ok: true, wrapperStyle, memberStyles }
}
