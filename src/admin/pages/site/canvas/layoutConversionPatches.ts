/**
 * layoutConversionPatches (PA-7 / PA-8) — the pure half of "Add auto layout"
 * and "Remove auto layout (keep positions)": from what the live frame measured
 * about a container and its children, the inline-style patch for each element
 * and the order the children end up in. No DOM, no store; `layoutConversion.ts`
 * measures and `convertLayout` writes.
 *
 * Both directions are judged by the same property: nothing moves. Add reads
 * direction / gap / padding / alignment / wrap off the rects
 * (`inferAutoLayout`); Remove writes the offsets the rects already have.
 *
 * Offsets measure from the container's PADDING box and place a child's MARGIN
 * edge, so a container's border and a child's margin are taken off the rects.
 */
import { inferAutoLayout, isOutOfFlow, type LayoutRect } from '@core/studio-runtime'

type StylePatch = Record<string, string | null>

export interface BoxSides {
  top: number
  right: number
  bottom: number
  left: number
}

/** What one measured element contributes. Rects share one coordinate space, in CSS px. */
export interface MeasuredBox {
  nodeId: string
  /** Border box. */
  rect: LayoutRect
  position: string
  display: string
  boxSizing: string
  margin: BoxSides
  padding: BoxSides
  border: BoxSides
  /** The element's own inline style as authored (a class-set value is not in it). */
  inline: Readonly<Record<string, unknown>>
}

export interface ConversionPlan {
  parentPatch: StylePatch
  childPatches: Array<{ nodeId: string; patch: StylePatch }>
  /** Children in their new order; absent when the source order already is it. */
  order?: string[]
  /** Every child is predicted within a pixel of where it is now. */
  exact: boolean
}

const hasBox = (box: MeasuredBox) => box.rect.width + box.rect.height > 0 && box.display !== 'none' && box.display !== 'contents'
const px = (value: number) => `${Math.round(value * 100) / 100}px`
const whole = (value: number) => `${Math.round(value)}px`
const sum = (sides: BoxSides) => sides.top + sides.right + sides.bottom + sides.left

function paddingBox(parent: MeasuredBox): LayoutRect {
  return {
    x: parent.rect.x + parent.border.left,
    y: parent.rect.y + parent.border.top,
    width: parent.rect.width - parent.border.left - parent.border.right,
    height: parent.rect.height - parent.border.top - parent.border.bottom,
  }
}

/** The `width` / `height` that reproduce this box: the border box, less what a content-box size leaves out. */
function specifiedSize(box: MeasuredBox): { width: number; height: number } {
  if (box.boxSizing === 'border-box') return { width: box.rect.width, height: box.rect.height }
  return {
    width: box.rect.width - box.padding.left - box.padding.right - box.border.left - box.border.right,
    height: box.rect.height - box.padding.top - box.padding.bottom - box.border.top - box.border.bottom,
  }
}

/** The inline keys that put an out-of-flow child where it is; clearing them returns it to flow. */
const CHILD_PLACEMENT_KEYS = ['left', 'top', 'right', 'bottom', 'insetInlineStart', 'translate'] as const

/** Return an absolutely placed child to flow. A `position` a class sets cannot be cleared inline, so it is overridden. */
function intoFlow(child: MeasuredBox): StylePatch {
  const patch: StylePatch = { position: 'position' in child.inline ? null : 'static' }
  for (const key of CHILD_PLACEMENT_KEYS) if (key in child.inline) patch[key] = null
  return patch
}

const PADDING_KEYS: ReadonlyArray<readonly [keyof BoxSides, string]> = [
  ['top', 'paddingTop'],
  ['right', 'paddingRight'],
  ['bottom', 'paddingBottom'],
  ['left', 'paddingLeft'],
]

/** Add auto layout: flex in the inferred direction, children laid out where they already are. */
export function planAddAutoLayout(parent: MeasuredBox, children: readonly MeasuredBox[]): ConversionPlan {
  const measured = children.filter(hasBox)
  const free = measured.length > 0 && measured.every((child) => isOutOfFlow(child.position))
  // A badge pinned over a flow container stays pinned: only in-flow children set the layout.
  const laidOut = free ? measured : measured.filter((child) => !isOutOfFlow(child.position))
  const inferred = inferAutoLayout(laidOut.map((child) => child.rect), paddingBox(parent))

  const parentPatch: StylePatch = {
    display: 'flex',
    flexDirection: inferred.direction,
    flexWrap: inferred.wrap ? 'wrap' : null,
    alignItems: inferred.align,
    alignContent: inferred.wrap ? 'flex-start' : null,
    gap: inferred.wrap && inferred.lineGap !== inferred.gap ? `${inferred.lineGap}px ${inferred.gap}px` : px(inferred.gap),
  }

  // Padding the container already has is not rewritten; padding it needs is.
  const needed = PADDING_KEYS.filter(([side]) => Math.abs(inferred.padding[side] - parent.padding[side]) > 0.5)
  if (needed.length > 0) {
    const shorthand = 'padding' in parent.inline
    for (const [side, key] of shorthand ? PADDING_KEYS : needed) parentPatch[key] = whole(inferred.padding[side])
    if (shorthand) parentPatch.padding = null
    // Padding a content-box container adds to its size; a border-box one keeps it. Only a
    // container with no padding or border yet can switch without changing its size.
    if (parent.boxSizing === 'content-box' && sum(parent.padding) === 0 && sum(parent.border) === 0) {
      parentPatch.boxSizing = 'border-box'
    }
  }

  const childPatches = free
    ? measured.map((child) => ({ nodeId: child.nodeId, patch: intoFlow(child) }))
    : []

  const sourceOrder = children.map((child) => child.nodeId)
  let order: string[] | undefined
  if (free) {
    const visual = inferred.order.map((index) => measured[index]!.nodeId)
    const rest = sourceOrder.filter((nodeId) => !visual.includes(nodeId))
    const target = [...visual, ...rest]
    if (target.some((nodeId, index) => sourceOrder[index] !== nodeId)) order = target
  }
  return { parentPatch, childPatches, ...(order ? { order } : {}), exact: inferred.exact }
}

/** Remove auto layout: every in-flow child becomes absolute at the offsets it has now. */
export function planFreezePositions(parent: MeasuredBox, children: readonly MeasuredBox[]): ConversionPlan {
  const origin = paddingBox(parent)
  const childPatches = children.filter((child) => hasBox(child) && !isOutOfFlow(child.position)).map((child) => {
    const size = specifiedSize(child)
    const patch: StylePatch = {
      position: 'absolute',
      left: whole(child.rect.x - origin.x - child.margin.left),
      top: whole(child.rect.y - origin.y - child.margin.top),
      right: null,
      bottom: null,
      insetInlineStart: null,
      width: px(size.width),
      height: px(size.height),
    }
    return { nodeId: child.nodeId, patch }
  })

  const parentPatch: StylePatch = {
    // A layout set by a class cannot be cleared inline, so it is overridden.
    display: 'display' in parent.inline ? null : 'block',
    flexDirection: null,
    flexWrap: null,
    flexFlow: null,
    justifyContent: null,
    alignItems: null,
    alignContent: null,
    gap: null,
    rowGap: null,
    columnGap: null,
  }
  if (parent.position === 'static') parentPatch.position = 'relative'
  // With nothing in flow the container would collapse: keep the size it has.
  const size = specifiedSize(parent)
  if (!('height' in parent.inline)) parentPatch.height = px(size.height)
  if (parent.display === 'inline-flex' && !('width' in parent.inline)) parentPatch.width = px(size.width)
  return { parentPatch, childPatches, exact: true }
}
