/**
 * groupResize — the geometry of resizing a multi-selection as one box
 * (P5-F, IX-6g). Penpot's group resize (`transforms.cljs:151`), in CSS terms.
 *
 * ## The model
 *
 * The handles sit on the UNION of the selected layers' border boxes. A drag
 * resizes that union exactly as a single element's handles resize one box —
 * the same `resizeElementBox` rules, so ⇧ keeps the ratio, ⌥ resizes about
 * the centre and the floor is the same — and every member then scales WITH
 * the union: its border box keeps the same proportion of the union's width
 * and height, at the same relative position.
 *
 * ## What each layer can honestly be told
 *
 * Every member is written through the single-element pipeline, so each write
 * is the one a user would get resizing that layer alone to that size:
 *
 *  - its SIZE always — `width` / `height` converted through its own
 *    `box-sizing` (IX-6a) and its own Fixed companions (IX-6b);
 *  - its POSITION only when it is `position: absolute | fixed` — through the
 *    offsets its source anchors it by (IX-21). A flow layer's position is
 *    layout's to decide; writing an offset onto it would be a dead
 *    declaration (see `canvasFreeMove.ts`'s module doc), so a flow layer is
 *    resized in place and the row reflows around it — which is what the
 *    preview shows, because the preview IS the patch.
 *
 * Pure: plain numbers in, a `ResizeStep` per member out.
 */
import {
  MIN_ELEMENT_SIZE,
  resizeElementBox,
  type ResizeBoxStart,
  type ResizeHandle,
  type ResizeModifiers,
  type ResizeStep,
} from '@core/studio-runtime'
import type { SnapRect } from './boardSnapping'

/** One selected layer at pointerdown: its border box (frame-document px) and its CSS box. */
export interface GroupResizeMember {
  nodeId: string
  rect: SnapRect
  start: ResizeBoxStart
}

/** The union of the members' border boxes — where the group's handles sit. */
export function groupUnionRect(rects: readonly SnapRect[]): SnapRect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The union box after a drag of `handle` by (`dx`, `dy`): the single-element
 * rules applied to a box with no padding, no border and a `left`/`top` of its
 * own position, so the handle's opposite edge (or, with ⌥, the centre) stays
 * put.
 */
export function resizeGroupBox(
  handle: ResizeHandle,
  union: SnapRect,
  dx: number,
  dy: number,
  modifiers: ResizeModifiers,
): SnapRect {
  const start: ResizeBoxStart = {
    width: union.width,
    height: union.height,
    insetWidth: 0,
    insetHeight: 0,
    offsets: { inlineProperty: 'left', inline: union.x, top: union.y },
  }
  const step = resizeElementBox(handle, start, dx, dy, modifiers, MIN_ELEMENT_SIZE)
  return { x: step.inline ?? union.x, y: step.top ?? union.y, width: step.width, height: step.height }
}

/**
 * One member's step when the union goes from `union` to `next`: its border
 * box scaled by the union's scale on each axis, about the union's origin, and
 * expressed as that member's own CSS size and — when it is positioned —
 * offsets. An axis the union did not change is left exactly as the member's
 * start, so a sub-pixel rect never writes a width nobody dragged.
 */
export function memberResizeStep(member: GroupResizeMember, union: SnapRect, next: SnapRect): ResizeStep {
  const { rect, start } = member
  const scaleX = union.width > 0 ? next.width / union.width : 1
  const scaleY = union.height > 0 ? next.height / union.height : 1
  const changedX = next.width !== union.width
  const changedY = next.height !== union.height

  const boxWidth = rect.width * scaleX
  const boxHeight = rect.height * scaleY
  const width = changedX ? Math.max(0, Math.round(boxWidth - start.insetWidth)) : Math.round(start.width)
  const height = changedY ? Math.max(0, Math.round(boxHeight - start.insetHeight)) : Math.round(start.height)

  if (!start.offsets) return { width, height, inline: null, top: null }

  const nextLeft = next.x + (rect.x - union.x) * scaleX
  const nextTop = next.y + (rect.y - union.y) * scaleY
  const leftShift = changedX || next.x !== union.x ? nextLeft - rect.x : 0
  const topShift = changedY || next.y !== union.y ? nextTop - rect.y : 0
  // Under RTL the inline offset is measured from the containing block's RIGHT
  // side: it shrinks by exactly as much as the right edge moves right.
  const rightShift = leftShift + (width - Math.round(start.width))
  const { inlineProperty, inline, top } = start.offsets
  const nextInline = inlineProperty === 'left' ? inline + leftShift : inline - rightShift
  return { width, height, inline: Math.round(nextInline), top: Math.round(top + topShift) }
}
