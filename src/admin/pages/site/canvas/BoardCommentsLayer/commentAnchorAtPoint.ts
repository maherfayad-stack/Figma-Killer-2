/**
 * commentAnchorAtPoint — what a screen point MEANS as a comment anchor.
 *
 * Three things, in order, each degrading cleanly to the next:
 *
 *   1. Board coordinates, from the transform layer's own client rect. Using the
 *      element's measured rect rather than reconstructing it from
 *      pan/zoom/offsets means the maths cannot drift out of sync with the
 *      layer's CSS (which carries `top: 80px; left: 80px`).
 *   2. The frame under the cursor, by hit-testing `[data-frame-id]`, and the
 *      frame-local offset within it. This is the coordinate of record — it is
 *      what makes a pin follow its frame when the frame is dragged.
 *   3. The node under the cursor, by hit-testing INSIDE that frame's iframe.
 *      Best-effort: a cross-origin or not-yet-loaded iframe simply yields no
 *      node, and the comment becomes coordinate-only rather than failing.
 *
 * Step 3 is the one that gives a comment meaning rather than just a position,
 * and it can only be captured at the moment the tree and the cursor are both
 * available — which is why it happens here rather than at commit time.
 *
 * ITS OWN MODULE BECAUSE TWO GESTURES ASK THE SAME QUESTION
 * ────────────────────────────────────────────────────────
 * Placing a new pin (`CommentPlacementLayer`) and dragging an existing one
 * (`CommentPin`) are the same question — "what is under this point?" — asked at
 * different times. A second copy of this would be the same class of bug
 * `pinPosition.ts` was extracted to prevent: a dropped pin and a dragged pin
 * disagreeing about where the same cursor position is.
 */
import { useEditorStore } from '@site/store/store'
import { captureNodeHint } from '@core/studio-anchor'
import type { CommentAnchor } from '@core/studio-comments'
import { canvasZoomOf } from '../canvasZoom'

/**
 * Screen point → board point, measured off the transform layer itself.
 *
 * The SCALE has to come from `canvasZoomOf` rather than from that same rect —
 * the layer's `offsetWidth` is 0, so the usual `rect.width / offsetWidth` ratio
 * silently yields 1. See `canvasZoom.ts`.
 */
function toBoardPoint(
  layer: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number; zoom: number } {
  const rect = layer.getBoundingClientRect()
  const zoom = canvasZoomOf(layer)
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
    zoom,
  }
}

/**
 * The node id under a point inside a board frame, or `null`.
 *
 * Reads through the frame's iframe, which is same-origin (`srcdoc`), so
 * `contentDocument` is reachable. Everything here is wrapped because a frame
 * that is still booting has no document yet, and a comment placed a moment
 * too early must land as a coordinate-only pin, not an exception.
 */
function nodeIdAtPoint(frameEl: HTMLElement, clientX: number, clientY: number): string | null {
  try {
    const iframe = frameEl.querySelector('iframe')
    const doc = iframe?.contentDocument
    if (!iframe || !doc) return null
    const iframeRect = iframe.getBoundingClientRect()
    const scale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
    if (scale === 0) return null
    const innerX = (clientX - iframeRect.left) / scale
    const innerY = (clientY - iframeRect.top) / scale
    const hit = doc.elementFromPoint(innerX, innerY)
    return hit?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
  } catch {
    // A frame whose document is not reachable is not an error condition here
    // — it just means this pin has coordinates and no subject.
    return null
  }
}

/**
 * The board frame under a screen point.
 *
 * `elementsFromPoint` rather than `elementFromPoint`: the topmost element at
 * the cursor is whatever surface is driving the gesture — the placement layer's
 * capture sheet, or the pin being dragged — so the single-element form would
 * always return that instead of the frame beneath it.
 */
function frameAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const beneath = document
    .elementsFromPoint(clientX, clientY)
    .find((el) => el instanceof HTMLElement && el.closest('[data-frame-id]'))
  return beneath instanceof HTMLElement ? beneath.closest<HTMLElement>('[data-frame-id]') : null
}

/**
 * Resolve a screen point into the anchor a comment placed (or dropped) there
 * should carry. Never throws; a point over nothing yields a board-absolute,
 * subject-less anchor, which is a legitimate permanent state for a pin.
 */
export function commentAnchorAtPoint(
  transformLayer: HTMLElement,
  clientX: number,
  clientY: number,
): CommentAnchor {
  const board = toBoardPoint(transformLayer, clientX, clientY)
  const frameEl = frameAtPoint(clientX, clientY)

  if (!frameEl) {
    return { frameId: null, pageId: null, dx: board.x, dy: board.y, node: null }
  }

  const frameRect = frameEl.getBoundingClientRect()
  const pageId = frameEl.getAttribute('data-page-id')
  const nodeId = nodeIdAtPoint(frameEl, clientX, clientY)
  const page = pageId
    ? useEditorStore.getState().site?.pages.find((candidate) => candidate.id === pageId)
    : undefined

  return {
    frameId: frameEl.getAttribute('data-frame-id'),
    pageId,
    // Frame-LOCAL, so the pin travels with the frame. Divided by the live zoom
    // because the measured rect is already scaled.
    dx: (clientX - frameRect.left) / board.zoom,
    dy: (clientY - frameRect.top) / board.zoom,
    node: nodeId && page ? captureNodeHint(page, nodeId) : null,
  }
}
