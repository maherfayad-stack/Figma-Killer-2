import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import type {
  CanvasDropAxis,
  CanvasDropCandidate,
  CanvasRect,
} from './canvasDnd'

const CANVAS_NODE_SELECTOR = '[data-node-id]'

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
  const queryScope: ParentNode = iframe?.contentDocument ?? viewport
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

    candidates.push({
      nodeId,
      depth: depths.get(nodeId) ?? 0,
      rect: clientRectToViewportRect(viewport, editorRect),
      axis: inferCanvasDropAxis(target),
    })
  }

  return candidates
}

/**
 * Subset of `DOMRect` that `clientRectToViewportRect` actually reads. Using
 * a structural type lets callers pass either a real `DOMRect` (from
 * `getBoundingClientRect()`) or a plain object built by the iframe-coord
 * translation path above — both work, and we don't need `new DOMRect(...)`
 * which isn't available in every test environment.
 */
export interface ClientRectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** How far `nodeVisualRect` will descend looking for a box. */
const MAX_TRANSPARENT_WRAPPER_DEPTH = 4

/**
 * The box a canvas node element actually occupies, or `null` when it occupies
 * none at all.
 *
 * A module whose root element is LAYOUT-TRANSPARENT (`display: contents`, how a
 * module hosts a third-party component without inserting a box into the author's
 * layout — see `src/modules/alm/register.tsx`) generates no box of its own, so
 * `getBoundingClientRect()` is all zeros. What the user sees and clicks is its
 * children, so their union is the node's visual box. Without this such a node
 * gets no selection ring, no hover outline, and cannot be a drop target.
 *
 * Also covers the ordinary empty-element case: a node with neither a box nor any
 * boxed descendant returns `null`, which is what both callers already did with a
 * zero rect.
 */
export function nodeVisualRect(element: Element, depth: number = 0): ClientRectLike | null {
  const rect = element.getBoundingClientRect()
  if (rect.width !== 0 || rect.height !== 0) return rect
  if (depth >= MAX_TRANSPARENT_WRAPPER_DEPTH) return null

  // Duck-typed, like `measure`'s own `getBoundingClientRect` check: elements
  // arrive from an iframe document with their own classes, and test doubles
  // implement only what they are asked about.
  const children = element.children
  if (!children || typeof children.length !== 'number') return null

  let union: ClientRectLike | null = null
  for (const child of Array.from(children)) {
    const childRect = nodeVisualRect(child, depth + 1)
    if (!childRect) continue
    // NEVER assign `union = childRect` directly (the single/first-child
    // case) when `childRect` can be a real `DOMRect` — `getBoundingClientRect()`
    // returns one whenever a child's own box is non-empty (the `return rect`
    // branch above). `left`/`top`/`right`/`bottom` on a `DOMRect` are
    // PROTOTYPE getters, not the instance's own enumerable properties, so a
    // later `{ ...union, ... }` spread (below) silently drops them — the
    // result keeps a correct `width`/`height` (computed from `right`/`left`,
    // which ARE readable via normal property access) but `x`/`y` come out
    // `undefined`, then `undefined * zoom` is `NaN` wherever a caller
    // multiplies it. Explicit field reads work on a DOMRect either way — copy
    // fields into a plain object immediately so nothing downstream can spread
    // it again and reintroduce this.
    union = union === null
      ? { left: childRect.left, top: childRect.top, right: childRect.right, bottom: childRect.bottom, width: 0, height: 0 }
      : {
        left: Math.min(union.left, childRect.left),
        top: Math.min(union.top, childRect.top),
        right: Math.max(union.right, childRect.right),
        bottom: Math.max(union.bottom, childRect.bottom),
        width: 0,
        height: 0,
      }
  }
  if (union === null) return null
  return { left: union.left, top: union.top, right: union.right, bottom: union.bottom, width: union.right - union.left, height: union.bottom - union.top }
}

function clientRectToViewportRect(
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

function inferCanvasDropAxis(target: HTMLElement): CanvasDropAxis {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return 'vertical'
  }

  const parent = findLayoutParent(target)
  if (!parent) return 'vertical'

  const style = window.getComputedStyle(parent)
  if (style.display.includes('flex') && style.flexDirection.startsWith('row')) {
    return 'horizontal'
  }

  return 'vertical'
}

function findLayoutParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(parent)
      : null
    if (style?.display !== 'contents') return parent
    parent = parent.parentElement
  }
  return null
}

function buildDepthMap(tree: NodeTree<PageNode>): Map<string, number> {
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
