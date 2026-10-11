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
 * A plain drop is FLOW — the image lands at an index among its siblings —
 * except into a FREE FRAME, whose children are all placed by their own insets
 * (`resolvePlacement`, PA-3): there it lands absolute at the pointer. A
 * ⌘/Ctrl-drop asks for a POSITION anywhere, and gets exactly what K6's ⌘-drag gives a
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
 * the placement kind. The decision itself is `canvasNewLayerPlacement.ts`'s. Everything but {@link measureDropContainer} is pure.
 */
import { establishesContainingBlock } from '@core/studio-runtime'
import { placementKindOfElement, type NewLayerParent } from './canvasNewLayerPlacement'
import { presentedElementForNode } from './canvasNodeLookup'

/** What the drop needs to know about the container, read once at drop time. */
export interface DropContainerBox extends NewLayerParent {
  /** Content-box width in CSS px — the widest an image can be without overflowing. */
  contentWidth: number
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
    kind: placementKindOfElement(view, element),
    containsAbsolute: establishesContainingBlock(style),
    direction: style.direction,
  }
}
