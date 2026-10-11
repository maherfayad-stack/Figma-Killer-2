/**
 * canvasImageDropPlacement — P5-B (IMG-9): how big a dropped image is written,
 * and, for a ⌘/Ctrl-drop, where.
 *
 * ## Size: the file's own, never wider than where it lands
 *
 * The landing route reads the image's intrinsic size from its header bytes
 * (`imageDimensions.ts`), and the element is written with `width`/`height`
 * ATTRIBUTES — the HTML way to reserve an aspect ratio before the pixels
 * arrive, so the page does not shift when they do. A 4000 px photo dropped
 * into a 390 px phone frame must not write `width={4000}`, so the size is
 * CLAMPED to the drop container's content-box width with the aspect kept.
 * An unknown size (`null`) writes no attributes at all: guessing one would put
 * a number in the user's source that nothing measured.
 *
 * ## Position: K6's rule, not a second one
 *
 * A plain drop is FLOW — the image lands at an index among its siblings. A
 * ⌘/Ctrl-drop asks for a POSITION, and gets exactly what K6's ⌘-drag gives a
 * moved element (`canvasFreeMove.ts`): `position: absolute` plus the inline
 * offset and `top`, measured from the container's padding box (the box an
 * absolutely positioned child is placed against), and ONLY inside a
 * positioned container. A static container refuses with K6's own remedy
 * ("make it position: relative") — absolutely positioning into a static
 * parent would silently place the image against some distant ancestor. RTL
 * writes the logical `insetInlineStart`, K6's `inlineOffsetProperty`.
 *
 * The pure size and cascade maths (`clampImageSize`, `absolutePlacementStyle`)
 * live in the store-side leaf `imageDropShapes.ts`, which the store builds
 * props with; this module is the canvas half — the container measurement and
 * the K6 decision. Everything but {@link measureDropContainer} is pure.
 */
import {
  containingBlockOffsets,
  establishesContainingBlock,
  inlineOffsetProperty,
  type ContainingBlockBox,
} from '@core/studio-runtime'
import type { AbsoluteImagePlacement } from '@site/store/slices/site/imageDropShapes'
import type { ClientPoint } from './canvasDragSession'
import { presentedElementForNode } from './canvasNodeLookup'

/** What the drop needs to know about the container, read once at drop time. */
export interface DropContainerBox {
  /** Content-box width in CSS px — the widest an image can be without overflowing. */
  contentWidth: number
  /** The container's box in frame-viewport coordinates, for `containingBlockOffsets`. */
  block: ContainingBlockBox
  /** Does an absolute child of this container stay inside it (positioned, transformed, …)? */
  containsAbsolute: boolean
  /** Computed `direction`, for the inline offset property. */
  direction: string
}

/**
 * Read the container's box. One computed-style read and one rect read, on the
 * drop itself (never per `dragover`). `null` when the container renders no
 * element this can measure (a box-less host): the drop then writes no size
 * clamp and refuses a positioned drop rather than inventing a box.
 */
export function measureDropContainer(doc: Document, nodeId: string): DropContainerBox | null {
  const element = presentedElementForNode(doc, nodeId)
  const view = doc.defaultView
  if (!element || !view || typeof view.getComputedStyle !== 'function') return null
  const style = view.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  const px = (value: string) => {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  const borderLeft = px(style.borderLeftWidth)
  const borderRight = px(style.borderRightWidth)
  const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1
  const paddingWidth = Math.max(0, rect.width / scale - borderLeft - borderRight)
  return {
    contentWidth: Math.max(0, paddingWidth - px(style.paddingLeft) - px(style.paddingRight)),
    // Frame-viewport coordinates — the space the drop's candidate rects and
    // `indexLocalPoint` speak (a frame grows to its content, so it does not
    // scroll).
    block: {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      borderLeft,
      borderTop: px(style.borderTopWidth),
      borderRight,
      borderBottom: px(style.borderBottomWidth),
      scale,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    },
    containsAbsolute: establishesContainingBlock(style),
    direction: style.direction,
  }
}

export type AbsolutePlacementResolution =
  | { ok: true; placement: AbsoluteImagePlacement }
  | { ok: false; reason: 'static-parent' | 'unmeasured' }

/**
 * K6's rule for a ⌘-drop: the pointer's offset from the container's padding
 * box, written as `left`/`top` (or `insetInlineStart`/`top` under RTL), only
 * when the container is positioned. `point` is in frame-viewport coordinates
 * (`indexLocalPoint`'s space).
 */
export function resolveAbsolutePlacement(
  box: DropContainerBox | null,
  point: ClientPoint,
): AbsolutePlacementResolution {
  if (!box) return { ok: false, reason: 'unmeasured' }
  // A container that does not establish a containing block would hand the
  // absolute image to some distant ancestor.
  if (!box.containsAbsolute) return { ok: false, reason: 'static-parent' }
  const property = inlineOffsetProperty(box.direction)
  const offsets = containingBlockOffsets({ left: point.x, top: point.y, width: 0, height: 0 }, box.block)
  return {
    ok: true,
    placement: {
      property,
      inline: property === 'left' ? offsets.left : offsets.right,
      top: offsets.top,
    },
  }
}
