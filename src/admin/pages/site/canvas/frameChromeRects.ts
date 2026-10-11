/**
 * frameChromeRects — where a node's selection chrome goes: its box from the
 * frame's {@link FrameGeometryIndex}, in the frame's own viewport px.
 *
 * Chrome used to look the element up in the frame document and read its rect
 * (a per-overlay element cache + `nodeVisualRect`), which is a read of the user's
 * DOM from the editor on every pass and impossible for a frame that has no
 * reachable document. The index carries exactly the box that read produced
 * (`collectNodeGeometry` calls the same `nodeVisualRect`), one batched read
 * for the whole frame.
 *
 * One case the index cannot answer by id: a ZERO-DOM fragment node has no
 * element at all, so it is not stamped and not listed. Its box is the union of
 * its children's, found through the page tree — the same fallback
 * the element cache applied to the rendered descendants.
 */
import type { Page } from '@core/page-tree'
import type { CanvasOverlayRect } from './canvasOverlayGeometry'
import { unionCanvasOverlayRects } from './canvasOverlayGeometry'
import type { FrameGeometryIndex } from './frameGeometry/frameGeometryIndex'

/** How deep the fragment fallback descends; a fragment inside a fragment inside a fragment is already unusual. */
const FRAGMENT_DEPTH_LIMIT = 4

/** The node's box in frame viewport px, or `null` when the frame draws nothing for it. */
export function chromeRectOf(index: FrameGeometryIndex | null, page: Page | null, nodeId: string): CanvasOverlayRect | null {
  if (!index) return null
  return fragmentAwareRect(index, page, nodeId, FRAGMENT_DEPTH_LIMIT)
}

function fragmentAwareRect(index: FrameGeometryIndex, page: Page | null, nodeId: string, depth: number): CanvasOverlayRect | null {
  const own = index.localRectOf(nodeId)
  if (own) return own
  if (depth <= 0) return null
  const children = page?.nodes[nodeId]?.children
  if (!children || children.length === 0) return null
  let union: CanvasOverlayRect | null = null
  for (const childId of children) {
    const rect = fragmentAwareRect(index, page, childId, depth - 1)
    if (rect) union = unionCanvasOverlayRects(union, rect)
  }
  return union
}
