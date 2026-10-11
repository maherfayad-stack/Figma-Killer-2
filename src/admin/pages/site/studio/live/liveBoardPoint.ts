/**
 * Screen points <-> board points for the live channel.
 *
 * Measured off the transform layer's own rect and computed matrix, the same way
 * comment placement does (`commentAnchorAtPoint.ts`), so the maths cannot drift
 * from the layer's CSS inset.
 */
import { canvasZoomOf } from '../../canvas/canvasZoom'

export interface BoardPoint {
  x: number
  y: number
}

/** A point in the admin document's client space, as a board point. */
export function boardPointFromClient(layer: HTMLElement, clientX: number, clientY: number): BoardPoint {
  const rect = layer.getBoundingClientRect()
  const zoom = canvasZoomOf(layer)
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom }
}

/**
 * A point reported by an event INSIDE a canvas iframe. The iframe's content is
 * laid out 1:1 in board units, so its client coordinates only need the
 * iframe's own board offset added (scaled by any scale the iframe itself
 * carries).
 */
export function boardPointFromFrameEvent(
  layer: HTMLElement,
  iframe: HTMLElement,
  frameClientX: number,
  frameClientY: number,
): BoardPoint {
  const layerRect = layer.getBoundingClientRect()
  const iframeRect = iframe.getBoundingClientRect()
  const zoom = canvasZoomOf(layer)
  const scale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth / zoom : 1
  return {
    x: (iframeRect.left - layerRect.left) / zoom + frameClientX * scale,
    y: (iframeRect.top - layerRect.top) / zoom + frameClientY * scale,
  }
}

export function findTransformLayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-canvas-transform-layer]')
}

export function findCanvasRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-studio-canvas-root]')
}
