import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import type {
  CanvasDropCandidate,
  CanvasRect,
} from './canvasDnd'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { nodeVisualRect, resolveCanvasAxisFromStyle, resolveCanvasInsertionAxis, type CanvasRectSource, type ClientRectLike } from '@core/studio-runtime'

// Re-exported verbatim — `speed-06` moved the implementation into
// `@core/studio-runtime/dropAxisRules.ts` so the in-frame bridge candidate
// builder can share it, but existing admin-side imports of these two names
// from THIS module (`canvasInsertionAxis.test.ts`) stay valid.
export { resolveCanvasAxisFromStyle, resolveCanvasInsertionAxis }
// SB-3 moved `nodeVisualRect` (and its two structural rect types) into
// `@core/studio-runtime/nodeVisualRect.ts` so the in-frame bridge runtime's
// `measureAll` measures a node exactly as the portal canvas does. Admin code
// keeps importing the names from here.
export { nodeVisualRect }
export type { CanvasRectSource, ClientRectLike }
export type { CanvasAxisResolution, CanvasAxisStyleInput } from '@core/studio-runtime'

const CANVAS_NODE_SELECTOR = '[data-node-id]'

/**
 * A bridge frame's document is cross-origin, so `measureCanvasDropCandidates`
 * below (one DOM scan) cannot reach it. Its candidates come over the wire
 * instead — `FrameDocumentAdapter.measureDropCandidates()` (`speed-06`),
 * converted into the same frame-space units by
 * `measureDropCandidatesThroughAdapter` at the bottom of this module.
 */

export function getViewportLocalPoint(
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = getViewportScale(viewport, viewportRect)
  return {
    x: (clientX - viewportRect.left) / scale,
    y: (clientY - viewportRect.top) / scale,
  }
}

/**
 * Translate a pointer event's `clientX` / `clientY` into editor-document
 * coordinates.
 *
 * The canvas renders each breakpoint frame inside its own iframe (see
 * `IframeFrameSurface`). Pointer events that originate inside a frame carry
 * coordinates relative to THAT iframe's viewport — not the editor's. Anything
 * portaled into the editor's `document.body` with `position: fixed` (the
 * right-click context menu, popovers anchored to the cursor, etc.) needs the
 * editor's viewport coordinates instead.
 *
 * The translation:
 *  1. Resolve the iframe element that hosts the event target (via
 *     `target.ownerDocument.defaultView.frameElement`).
 *  2. Multiply the iframe-internal point by the canvas zoom (recovered from
 *     `iframeRect.width / iframe.offsetWidth` — the iframe element itself is
 *     scaled by the canvas transform layer, but the iframe's internal
 *     coordinate space is its own un-transformed viewport).
 *  3. Add the iframe's outer client rect to get editor-document coordinates.
 *
 * When the event originates in the editor's own document (e.g. right-click in
 * the DOM panel), `frameElement` is null and we return `clientX` / `clientY`
 * unchanged.
 */
export function clientPointToEditorDoc(event: {
  clientX: number
  clientY: number
  target: EventTarget | null
}): { x: number; y: number } {
  const target = event.target as { ownerDocument?: Document | null } | null
  const ownerDoc = target?.ownerDocument ?? null
  const frame = (ownerDoc?.defaultView?.frameElement ?? null) as HTMLIFrameElement | null
  if (!frame) {
    return { x: event.clientX, y: event.clientY }
  }
  const iframeRect = frame.getBoundingClientRect()
  const iframeScale = frame.offsetWidth > 0 ? iframeRect.width / frame.offsetWidth : 1
  return {
    x: iframeRect.left + event.clientX * iframeScale,
    y: iframeRect.top + event.clientY * iframeScale,
  }
}

/**
 * Compute the pan offset that horizontally centers a breakpoint frame in the
 * canvas viewport and aligns its top a fixed padding below the viewport top,
 * keeping the current zoom. Returns `null` when the frame isn't measurable yet
 * (zero-size — not laid out).
 *
 * Only the translate component of the layer transform is adjusted, so the math
 * works directly in screen pixels: with `translate(pan) scale(zoom)`, changing
 * `pan` shifts every child's on-screen rect 1:1 — translate values are NOT
 * scaled by `zoom`, and the result is independent of the transform-origin.
 * That lets us read the live `getBoundingClientRect()` of the frame (already
 * reflecting the current transform) and derive the delta to apply.
 */
export function panToCenterBreakpointFrame(
  canvasRoot: HTMLElement,
  frame: HTMLElement,
  current: { panX: number; panY: number },
  topPadding = 48,
): { panX: number; panY: number } | null {
  const rootRect = canvasRoot.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  if (frameRect.width === 0 && frameRect.height === 0) return null

  const rootCenterX = rootRect.left + rootRect.width / 2
  const frameCenterX = frameRect.left + frameRect.width / 2
  const desiredFrameTop = rootRect.top + topPadding

  return {
    panX: current.panX + (rootCenterX - frameCenterX),
    panY: current.panY + (desiredFrameTop - frameRect.top),
  }
}

export function measureCanvasDropCandidates(
  viewport: HTMLElement,
  tree: NodeTree<PageNode>,
  /**
   * Iframe hosting the canvas content. When provided, drop-candidate lookups
   * happen inside the iframe's document and each rect is translated into
   * editor coords before being made viewport-local. `null` / undefined falls
   * back to the legacy in-document path.
   */
  iframe?: HTMLIFrameElement | null,
): CanvasDropCandidate[] {
  const depths = buildDepthMap(tree)
  const queryScope: ParentNode = resolvePortalDocument(iframe) ?? viewport
  const wrappers = Array.from(queryScope.querySelectorAll<HTMLElement>(CANVAS_NODE_SELECTOR))
  const iframeRect = iframe?.getBoundingClientRect() ?? null
  // Inner rects come back unscaled (iframe document is its own viewport);
  // multiply by the canvas zoom recovered from the iframe element before
  // adding the iframe's outer offset. See the matching explanation in
  // `canvasOverlayGeometry.ts`.
  const iframeScale =
    iframe && iframe.offsetWidth > 0 && iframeRect ? iframeRect.width / iframe.offsetWidth : 1
  const candidates: CanvasDropCandidate[] = []

  for (const target of wrappers) {
    const nodeId = target.dataset.nodeId
    if (!nodeId) continue
    const node = tree.nodes[nodeId]
    if (!node || node.hidden) continue

    const rectInsideScope = nodeVisualRect(target)
    if (!rectInsideScope) continue

    // Translate iframe-internal coords into editor coords: multiply by the
    // canvas zoom, then add the iframe's outer offset.
    // `clientRectToViewportRect` only reads `left`/`top`/`width`/`height`
    // so we hand it a plain object — happy-dom doesn't expose DOMRect as a
    // global, ruling out `new DOMRect()`.
    const editorRect: ClientRectLike = iframeRect
      ? {
          left: iframeRect.left + rectInsideScope.left * iframeScale,
          top: iframeRect.top + rectInsideScope.top * iframeScale,
          right: iframeRect.left + rectInsideScope.right * iframeScale,
          bottom: iframeRect.top + rectInsideScope.bottom * iframeScale,
          width: rectInsideScope.width * iframeScale,
          height: rectInsideScope.height * iframeScale,
        }
      : rectInsideScope

    const { axis, reversed } = resolveCanvasInsertionAxis(target)
    candidates.push({
      nodeId,
      depth: depths.get(nodeId) ?? 0,
      rect: clientRectToViewportRect(viewport, editorRect),
      axis,
      reversed,
    })
  }

  return candidates
}

export function clientRectToViewportRect(
  viewport: HTMLElement,
  rect: ClientRectLike,
): CanvasRect {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = getViewportScale(viewport, viewportRect)
  const left = (rect.left - viewportRect.left) / scale
  const top = (rect.top - viewportRect.top) / scale
  const width = rect.width / scale
  const height = rect.height / scale

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
}

function getViewportScale(viewport: HTMLElement, viewportRect: DOMRect): number {
  return viewport.offsetWidth > 0 ? viewportRect.width / viewport.offsetWidth : 1
}

/**
 * The live canvas zoom (1 = 100%), recovered from the viewport element's
 * rendered size vs. its untransformed layout size — the same measurement
 * `getViewportLocalPoint` / `clientRectToViewportRect` already use to convert
 * between screen space and frame space. Exported so drop-zone hit-testing
 * (`getCanvasDropZone` in `canvasDnd.ts`) can convert its screen-space edge
 * bands into the frame-space units `CanvasDropCandidate.rect` is measured in
 * — see `MIN_EDGE_HIT_ZONE_SCREEN_PX` there for why this matters.
 */
export function getViewportZoom(viewport: HTMLElement): number {
  return getViewportScale(viewport, viewport.getBoundingClientRect())
}

/**
 * A body-relative rect — the coordinate space `FrameDocumentAdapter.measure`/
 * `measureDropCandidates` both speak, since a bridge frame's cross-origin
 * document can only ever report a rect relative to ITS OWN `body` — converted
 * into CANDIDATE frame-space: the same unscaled, viewport-local unit system
 * `measureCanvasDropCandidates` has always produced, which
 * `resolveCanvasInsertionTarget`/`getCanvasDropZone`/`fixedPreviewForTarget`
 * all assume.
 *
 * Shared by the `speed-06` per-drag snapshot builder for BOTH a portal
 * surface's own DOM read and a bridge surface's wire answer — one conversion,
 * one place, instead of the iframe-scale arithmetic living twice (the
 * `standing-03` drift this module's own `project` comment elsewhere warns
 * against). Reuses `clientRectToViewportRect` below, the same function
 * `measureCanvasDropCandidates` itself is built on.
 */
export function bodyRelativeRectToFrameSpace(
  viewport: HTMLElement,
  iframe: HTMLIFrameElement,
  rect: { x: number; y: number; width: number; height: number },
): CanvasRect {
  const iframeRect = iframe.getBoundingClientRect()
  const iframeScale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
  const editorRect: ClientRectLike = {
    left: iframeRect.left + rect.x * iframeScale,
    top: iframeRect.top + rect.y * iframeScale,
    right: iframeRect.left + (rect.x + rect.width) * iframeScale,
    bottom: iframeRect.top + (rect.y + rect.height) * iframeScale,
    width: rect.width * iframeScale,
    height: rect.height * iframeScale,
  }
  return clientRectToViewportRect(viewport, editorRect)
}

export function buildDepthMap(tree: NodeTree<PageNode>): Map<string, number> {
  const depths = new Map<string, number>()
  const stack: Array<{ id: string; depth: number }> = [{ id: tree.rootNodeId, depth: 0 }]

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!
    if (depths.has(id)) continue
    depths.set(id, depth)
    const node = tree.nodes[id]
    if (!node) continue
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ id: node.children[i], depth: depth + 1 })
    }
  }

  return depths
}

/**
 * A bridge frame's drop candidates, asked over the wire ONCE and converted into
 * the frame-space units `measureCanvasDropCandidates` produces for a portal
 * frame — so every drop resolver downstream reads one shape whichever frame
 * kind the pointer is over. Shared by the insertion drag's per-drag snapshot
 * (`canvasInsertionDragSnapshot.ts`) and an element drag's candidate index
 * (`canvasDragSession.ts`). A node the tree does not know, or has hidden, is
 * never a candidate — the same filter the portal scan applies.
 */
export async function measureDropCandidatesThroughAdapter(
  adapter: Pick<FrameDocumentAdapter, 'measureDropCandidates'>,
  viewport: HTMLElement,
  iframe: HTMLIFrameElement,
  tree: NodeTree<PageNode>,
): Promise<CanvasDropCandidate[]> {
  const geometries = await adapter.measureDropCandidates()
  const depths = buildDepthMap(tree)
  const candidates: CanvasDropCandidate[] = []
  for (const geometry of geometries) {
    const node = tree.nodes[geometry.nodeId]
    if (!node || node.hidden) continue
    candidates.push({
      nodeId: geometry.nodeId,
      depth: depths.get(geometry.nodeId) ?? 0,
      rect: bodyRelativeRectToFrameSpace(viewport, iframe, geometry.rect),
      axis: geometry.axis,
      reversed: geometry.reversed,
    })
  }
  return candidates
}
