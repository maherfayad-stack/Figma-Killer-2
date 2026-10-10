/**
 * canvasDrawAbsolutePlacement — where a drawn element goes when its container
 * lays children out by position rather than by flow.
 *
 * A drawn rectangle normally lands at a flow index (the honest answer in a
 * React tree). In a screen whose children are `position: absolute` (an
 * exported mobile layout, a status bar over a hero) an appended flow child sits
 * at the container's origin, on top of whatever is there — nowhere near where
 * the pointer was. When the destination container already positions a child
 * absolutely, the draw is written the same way: `position: absolute` plus
 * `left` / `top` relative to that child's containing block, in CSS px at 100%.
 *
 * Portal (design) frames only: a bridge frame's document is cross-origin, so
 * its container cannot be inspected and the draw stays a flow insert.
 */
import { ownElementForNode } from './canvasNodeLookup'

interface PointLike {
  x: number
  y: number
}

/** The padding-box origin of a containing block, and the point being placed, in one space. */
export function absoluteOffsetWithin(point: PointLike, origin: PointLike): { left: number; top: number } {
  return { left: Math.round(point.x - origin.x), top: Math.round(point.y - origin.y) }
}

/** The inline styles that pin a drawn element at `left` / `top`. */
export function absolutePlacementStyles(offset: { left: number; top: number }): Record<string, string> {
  return { position: 'absolute', left: `${offset.left}px`, top: `${offset.top}px` }
}

/**
 * The absolute placement for a draw whose top-left is at `clientPoint`
 * (editor-document client px), inside node `parentId` of the frame hosted by
 * `iframe`. `null` when the container lays out by flow (no child of it is
 * absolutely positioned) or the frame's document is not reachable.
 */
export function absolutePlacementForDraw(
  iframe: HTMLIFrameElement | null,
  parentId: string,
  clientPoint: PointLike,
): Record<string, string> | null {
  const doc = iframe?.contentDocument
  const view = doc?.defaultView
  if (!iframe || !doc || !view) return null
  const parent = ownElementForNode(doc, parentId)
  if (!parent) return null
  const positioned = Array.from(parent.children).find(
    (child) => view.getComputedStyle(child).position === 'absolute',
  ) as HTMLElement | undefined
  if (!positioned) return null
  const containing = positioned.offsetParent ?? parent
  const frameRect = iframe.getBoundingClientRect()
  const scaleX = iframe.clientWidth > 0 ? frameRect.width / iframe.clientWidth : 1
  const scaleY = iframe.clientHeight > 0 ? frameRect.height / iframe.clientHeight : 1
  const local = { x: (clientPoint.x - frameRect.left) / scaleX, y: (clientPoint.y - frameRect.top) / scaleY }
  // A static `<body>` is not a containing block: the initial one is the document's origin.
  const isInitialBlock = containing === doc.body && view.getComputedStyle(containing).position === 'static'
  const box = isInitialBlock ? { left: -view.scrollX, top: -view.scrollY } : containing.getBoundingClientRect()
  const origin = isInitialBlock
    ? { x: box.left, y: box.top }
    : { x: box.left + containing.clientLeft - containing.scrollLeft, y: box.top + containing.clientTop - containing.scrollTop }
  return absolutePlacementStyles(absoluteOffsetWithin(local, origin))
}
