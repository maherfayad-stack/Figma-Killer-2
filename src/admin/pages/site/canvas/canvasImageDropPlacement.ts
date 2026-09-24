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
 * Everything but {@link measureDropContainer} is pure.
 */
import { inlineOffsetProperty, type InlineOffsetProperty } from '@core/studio-runtime'
import type { ClientPoint } from './canvasDragSession'
import { presentedElementForNode } from './canvasNodeLookup'

/** What the drop needs to know about the container, read once at drop time. */
export interface DropContainerBox {
  /** Content-box width in CSS px — the widest an image can be without overflowing. */
  contentWidth: number
  /** The padding box's top-left, in frame-viewport coordinates. */
  paddingOrigin: ClientPoint
  /** Padding-box width, to mirror an RTL inline offset from the right edge. */
  paddingWidth: number
  /** Computed `position` — `static` means an absolutely placed child would escape it. */
  position: string
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
  const borderTop = px(style.borderTopWidth)
  const paddingWidth = Math.max(0, rect.width - borderLeft - borderRight)
  return {
    contentWidth: Math.max(0, paddingWidth - px(style.paddingLeft) - px(style.paddingRight)),
    // Frame-viewport coordinates — the space the drop's candidate rects and
    // `indexLocalPoint` speak (a frame grows to its content, so it does not
    // scroll).
    paddingOrigin: { x: rect.left + borderLeft, y: rect.top + borderTop },
    paddingWidth,
    position: style.position,
    direction: style.direction,
  }
}

/**
 * The `width`/`height` attributes a dropped image is written with: its
 * intrinsic size, scaled down (never up) to `maxWidth` with the aspect kept,
 * rounded to whole pixels. `null` when either dimension is unknown.
 */
export function clampImageSize(
  intrinsic: { width: number | null; height: number | null },
  maxWidth: number | null,
): { width: number; height: number } | null {
  const { width, height } = intrinsic
  if (width === null || height === null || width <= 0 || height <= 0) return null
  if (maxWidth === null || maxWidth <= 0 || width <= maxWidth) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const scale = maxWidth / width
  return { width: Math.round(maxWidth), height: Math.max(1, Math.round(height * scale)) }
}

/** Where a ⌘-dropped image goes, in the container's own space. */
export interface AbsoluteImagePlacement {
  property: InlineOffsetProperty
  inline: number
  top: number
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
  // `static` is the only value that fails to establish a containing block for
  // an absolute child; `relative`/`absolute`/`fixed`/`sticky` all do.
  if (box.position === 'static') return { ok: false, reason: 'static-parent' }
  const property = inlineOffsetProperty(box.direction)
  const fromLeft = point.x - box.paddingOrigin.x
  return {
    ok: true,
    placement: {
      property,
      inline: Math.round(property === 'left' ? fromLeft : box.paddingWidth - fromLeft),
      top: Math.round(point.y - box.paddingOrigin.y),
    },
  }
}

/**
 * The `style={{…}}` object the Nth ⌘-dropped image is written with: K6's
 * `position: absolute` plus the offsets. Several images cascade down-and-inward
 * by a fixed step, the way a stack of pasted pictures lands, rather than all
 * sitting exactly on top of each other where only the last could be seen.
 */
export function absolutePlacementStyle(
  placement: AbsoluteImagePlacement,
  cascadeStep: number,
): Record<string, string> {
  const offset = cascadeStep * IMAGE_CASCADE_STEP_PX
  return {
    position: 'absolute',
    [placement.property]: `${placement.inline + offset}px`,
    top: `${placement.top + offset}px`,
  }
}

/** How far each further ⌘-dropped image is offset from the one before it. */
export const IMAGE_CASCADE_STEP_PX = 24
