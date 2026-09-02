/**
 * Geometry helpers that translate elements measured inside a breakpoint
 * iframe into the canvas overlay coordinate space (canvas-root scroll-content
 * px, post-transform screen px).
 *
 * `getBoundingClientRect()` inside the iframe returns un-transformed coords
 * (the iframe document is its own viewport, never transformed). The iframe
 * ELEMENT in the parent doc IS scaled by the canvas transform layer, so we
 * recover the canvas zoom from the iframe element itself
 * (`clientRect.width / offsetWidth`), multiply the inner rect by that scale,
 * add the iframe's outer offset, and subtract the canvas-root origin.
 *
 * There is deliberately no scroll term. The canvas root is `overflow: clip`
 * (see `CanvasRoot.module.css`), which clips the board WITHOUT creating a
 * scroll container — its scroll offsets are structurally pinned at 0, so the
 * canvas-root client rect IS the overlay coordinate origin. This used to add
 * `scrollLeft`/`scrollTop` to compensate for an `overflow: hidden` root that
 * the browser scrolled behind the user's back on iframe focus; that scroll is
 * now impossible, so compensating for it would be dead arithmetic.
 */
import { nodeVisualRect, type CanvasRectSource } from './canvasDomGeometry'

export interface CanvasOverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasOverlayMeasureSession {
  /** Canvas-root client rect, or null in the fixed/body fallback mode. */
  canvasRect: DOMRect | null
  /** Measure one iframe element into canvas-root-relative overlay coords. */
  measure(target: CanvasRectSource | null): CanvasOverlayRect | null
}

/**
 * Snapshot the geometry shared by every overlay measurement in one animation
 * frame — the iframe rect/scale and the canvas-root origin — so a tick that
 * positions K rings reads them ONCE instead of K times. Reading them in the
 * parent document before any overlay style write also keeps the tick's
 * read phase free of forced reflows (the writes happen afterwards).
 */
export function createCanvasOverlayMeasureSession(
  iframe: HTMLIFrameElement,
  canvasRoot: HTMLElement | null,
): CanvasOverlayMeasureSession {
  const iframeRect = iframe.getBoundingClientRect()
  const iframeScale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
  const canvasRect = canvasRoot ? canvasRoot.getBoundingClientRect() : null
  const originLeft = canvasRect?.left ?? 0
  const originTop = canvasRect?.top ?? 0

  return {
    canvasRect,
    measure(target) {
      // Duck-type check (`getBoundingClientRect` is callable) rather than
      // `instanceof Element` because iframe nodes have their own Element class.
      if (
        !target ||
        typeof (target as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function'
      ) {
        return null
      }

      const elementRectInIframe = nodeVisualRect(target)
      if (!elementRectInIframe) return null
      return {
        x: iframeRect.left + elementRectInIframe.left * iframeScale - originLeft,
        y: iframeRect.top + elementRectInIframe.top * iframeScale - originTop,
        width: elementRectInIframe.width * iframeScale,
        height: elementRectInIframe.height * iframeScale,
      }
    },
  }
}

/**
 * One-shot convenience over `createCanvasOverlayMeasureSession` for callers
 * that measure a single element (plugin canvas hooks, tree-ladder rows).
 * Hot per-frame loops should create a session instead.
 */
export function measureCanvasElementRect(
  target: HTMLElement | null,
  iframe: HTMLIFrameElement,
  canvasRoot: HTMLElement | null,
): CanvasOverlayRect | null {
  if (!target) return null
  return createCanvasOverlayMeasureSession(iframe, canvasRoot).measure(target)
}

/**
 * Measure `target` directly in its OWN document's coordinate space — no zoom
 * recovery, no iframe-offset addition, no canvas-root origin subtraction.
 * Valid ONLY when the caller (an overlay element) lives in the SAME document
 * as `target` — e.g. the in-iframe selection overlay (WS-5.1), which portals
 * rings/badge into an overlay root appended to the iframe's own `<body>`
 * instead of the parent canvas root. Panning/zooming the canvas moves the
 * iframe element — and everything painted inside it, including this overlay
 * — as one composited CSS transform, so an overlay measured in this space
 * tracks the element with zero per-frame conversion and zero drift. This is
 * the fix for "the ring lands away from the element" (`STATE.md`
 * `standing-03`); `createCanvasOverlayMeasureSession` above is still what
 * PARENT-document chrome (the toolbar, `InPlaceInspector`) needs, since that
 * chrome genuinely lives in a different coordinate space.
 */
export function measureIframeLocalRect(target: CanvasRectSource | null): CanvasOverlayRect | null {
  if (
    !target ||
    typeof (target as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function'
  ) {
    return null
  }
  const rect = nodeVisualRect(target)
  if (!rect) return null
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

/** Smallest rect containing both `a` (may be null) and `b`. */
export function unionCanvasOverlayRects(
  a: CanvasOverlayRect | null,
  b: CanvasOverlayRect,
): CanvasOverlayRect {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}
