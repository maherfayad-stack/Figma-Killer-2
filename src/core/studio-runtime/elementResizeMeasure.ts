/**
 * elementResizeMeasure — the one DOM read a resize makes, at pointerdown:
 * what the element's CSS size, `box-sizing` insets and (if it has them)
 * offsets are. Shared by the portal-mode drag (`useElementResizeDrag.ts`) and
 * the in-frame runtime's (`resizeHandles.ts`), so the two hosts start every
 * drag from the same facts; the geometry that follows is
 * `elementResizeRules.ts`, which is pure.
 *
 * ## Why the computed `width`, not the rect
 *
 * `getBoundingClientRect()` is the border box AFTER the element's own
 * transforms — a `scale(1.1)` card measures 10% wider than the `width` its
 * source says. The computed `width` is the used CSS value, which is exactly
 * what the drag will write back, and padding + border are added to it only
 * when `box-sizing: content-box` puts them outside (IX-6a). The rect is the
 * fallback for the one case a computed `width` is not a length (`auto` on an
 * element that is not being rendered).
 */
import type { InlineOffsetProperty, ResizeBoxStart, ResizeOffsets } from './elementResizeRules'

/** True when this element already decides its own position through its offsets. */
export function isPositionedFreely(position: string): boolean {
  return position === 'absolute' || position === 'fixed'
}

/**
 * The property a positioned element's horizontal offset lives in: the logical
 * inline start under RTL (where it is the RIGHT edge), physical `left`
 * otherwise. `canvasFreeMove.ts` writes the same property for a free move, so
 * a resize and a move of one element never write two different offsets.
 */
export function inlineOffsetProperty(direction: string): InlineOffsetProperty {
  return direction === 'rtl' ? 'insetInlineStart' : 'left'
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function lengthOr(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readOffsets(element: HTMLElement, style: CSSStyleDeclaration): ResizeOffsets | null {
  if (!isPositionedFreely(style.position)) return null
  const inlineProperty = inlineOffsetProperty(style.direction)
  // For a positioned element the resolved value of an inset IS its used px
  // value, so `auto` only survives on an element that is not rendered —
  // where the offset box inside the containing block is the honest start.
  const inline = inlineProperty === 'left'
    ? lengthOr(style.left, element.offsetLeft)
    : lengthOr(style.insetInlineStart, 0)
  return { inlineProperty, inline, top: lengthOr(style.top, element.offsetTop) }
}

/** The element as a resize starts from it. `view` is the element's own window. */
export function readResizeBoxStart(view: Window, element: HTMLElement): ResizeBoxStart {
  const style = view.getComputedStyle(element)
  const contentBox = style.boxSizing !== 'border-box'
  const insetWidth = contentBox
    ? px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
    : 0
  const insetHeight = contentBox
    ? px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth)
    : 0
  const needsRect = !Number.isFinite(Number.parseFloat(style.width)) || !Number.isFinite(Number.parseFloat(style.height))
  const rect = needsRect ? element.getBoundingClientRect() : null
  return {
    width: lengthOr(style.width, Math.max(0, (rect?.width ?? 0) - insetWidth)),
    height: lengthOr(style.height, Math.max(0, (rect?.height ?? 0) - insetHeight)),
    insetWidth,
    insetHeight,
    offsets: readOffsets(element, style),
  }
}
