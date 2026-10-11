/**
 * nodeVisualRect — the box a canvas node is actually SEEN as.
 *
 * Moved here (SB-3) from the admin canvas's `canvasDomGeometry.ts` so the
 * in-frame bridge runtime's `measureAll` (`nodeGeometry.ts`) measures a node
 * exactly the way the portal canvas does. `canvasDomGeometry.ts` re-exports
 * the three names, so admin call sites are unchanged. Pure DOM reads; no admin
 * imports, so it bundles into the runtime.
 */

/**
 * Subset of `DOMRect` the canvas geometry reads. A structural type lets callers
 * pass either a real `DOMRect` (from `getBoundingClientRect()`) or a plain
 * object built by an iframe-coordinate translation, and avoids
 * `new DOMRect(...)`, which is not available in every test environment.
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
 * Anything the canvas can measure a box from: a real DOM `Element`, or a
 * SYNTHETIC stand-in for a node that rendered no element of its own.
 *
 * The second case exists for zero-DOM fragment nodes: `studio.instance`
 * (WS-4.2) renders `<>{children}</>` and therefore spreads `data-node-id`
 * nowhere, so `[data-node-id="..."]` finds nothing to measure. `canvasNodeLookup`
 * builds a synthetic source whose rect is the union of the node's shallowest
 * rendered descendants; every measurement path only ever calls
 * `getBoundingClientRect()` (and, for the box-less fallback below, reads
 * `children`), so such a stand-in flows through all of them unchanged.
 */
export interface CanvasRectSource {
  getBoundingClientRect(): ClientRectLike
  readonly children?: HTMLCollection
}

/**
 * The box a canvas node element actually occupies, or `null` when it occupies
 * none at all.
 *
 * A module whose root element is LAYOUT-TRANSPARENT (`display: contents`, how a
 * module hosts a third-party component without inserting a box into the author's
 * layout, see `src/modules/alm/register.tsx`) generates no box of its own, so
 * `getBoundingClientRect()` is all zeros. What the user sees and clicks is its
 * children, so their union is the node's visual box. Without this such a node
 * gets no selection ring, no hover outline, and cannot be a drop target.
 *
 * Also covers the ordinary empty-element case: a node with neither a box nor any
 * boxed descendant returns `null`, which is what both callers already did with a
 * zero rect.
 */
export function nodeVisualRect(element: CanvasRectSource, depth: number = 0): ClientRectLike | null {
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
    // NEVER assign `union = childRect` directly (the single/first-child case)
    // when `childRect` can be a real `DOMRect`: `left`/`top`/`right`/`bottom`
    // on a `DOMRect` are PROTOTYPE getters, not own enumerable properties, so a
    // later `{ ...union, ... }` spread silently drops them and `x`/`y` come out
    // `undefined`, then `NaN` wherever a caller multiplies by zoom. Copy the
    // fields into a plain object immediately.
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
