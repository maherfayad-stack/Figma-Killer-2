/**
 * peerSelectionRects - where a peer's selected nodes are, in BOARD space.
 *
 * A peer's selection arrives as node ids plus the page they belong to. The page
 * is shown by a board frame whose same-origin iframe holds the live elements,
 * so a rect is `data-node-id` -> `nodeVisualRect` inside that document, shifted
 * by the iframe's own board offset. Drawn from the overlay layer: nothing is
 * added to the frame's DOM.
 *
 * An id that does not resolve (the node moved, the frame is virtualised, the
 * iframe has not booted) yields no rect; the ring is simply absent, never
 * misplaced.
 */
import { canvasZoomOf } from '../canvasZoom'
import { nodeVisualRect } from '../canvasDomGeometry'
import { ownElementForNode, escapeCssAttributeValue } from '../canvasNodeLookup'
import { resolvePortalDocument } from '../frameAdapter/resolvePortalDocument'

export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

export function measurePeerSelectionRects(layer: HTMLElement, pageId: string, nodeIds: readonly string[]): BoardRect[] {
  const frame = layer.querySelector<HTMLElement>(`[data-page-id="${escapeCssAttributeValue(pageId)}"]`)
  const iframe = frame?.querySelector<HTMLIFrameElement>('iframe') ?? null
  const doc = resolvePortalDocument(iframe)
  if (!iframe || !doc) return []

  const layerRect = layer.getBoundingClientRect()
  const iframeRect = iframe.getBoundingClientRect()
  const zoom = canvasZoomOf(layer)
  const scale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth / zoom : 1
  const originX = (iframeRect.left - layerRect.left) / zoom
  const originY = (iframeRect.top - layerRect.top) / zoom

  const rects: BoardRect[] = []
  for (const id of nodeIds) {
    const element = ownElementForNode(doc, id)
    const rect = element ? nodeVisualRect(element) : null
    if (!rect) continue
    rects.push({
      x: originX + rect.left * scale,
      y: originY + rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    })
  }
  return rects
}

export function boardRectsEqual(a: readonly BoardRect[], b: readonly BoardRect[]): boolean {
  if (a.length !== b.length) return false
  return a.every((rect, i) => {
    const other = b[i]
    return other !== undefined && rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height
  })
}
