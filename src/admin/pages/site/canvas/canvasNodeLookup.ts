/**
 * canvasNodeLookup — the ONE way to resolve the live DOM element that renders
 * a page-tree node.
 *
 * `data-node-id` is not unique to the canvas: the DOM panel's tree rows, the
 * Import-HTML preview rows, and the selection/hover overlay rings all carry it
 * in the ADMIN document. Resolving a node by querying the admin document
 * therefore returns panel chrome whenever such an element happens to exist —
 * and whether it exists depends on transient UI state (the layers tree
 * auto-expands the selected node's ancestors AFTER selection), which made
 * ambient-selector matching in the Properties panel flicker between correct
 * and empty depending on click order.
 *
 * Canvas nodes render exclusively inside the per-breakpoint canvas iframes
 * (`IframeFrameSurface`), whose `<body>` is tagged with `data-breakpoint-id`.
 * The lookup searches ONLY those documents — never the admin document, and
 * never iframes that aren't canvas frames (plugin surfaces, previews).
 *
 * ZERO-DOM FRAGMENT NODES (instance-ui-01)
 * ────────────────────────────────────────
 * One node kind renders no element at all: `studio.instance` (WS-4.2) is a
 * bare `<>{children}</>` React Fragment, deliberately — see
 * `src/modules/base/instance/InstanceEditor.tsx` for why a component call site
 * must leave NOTHING behind in the DOM. It therefore spreads `data-node-id`
 * nowhere, and `[data-node-id="…"]` cannot find it.
 *
 * That is only a problem once the instance becomes SELECTABLE, which is what
 * instance-ui-01 made it: clicking a component now selects the instance
 * (`findEnclosingInstance`), so the overlay is asked to ring a node with no
 * element, gets `null`, and draws nothing — a node the user just clicked, with
 * an open Properties panel, and no ring, no hover outline and no in-place
 * inspector anchor on the canvas. `nodeVisualRect`'s own box-less fallback
 * cannot cover this: it unions an element's CHILDREN, and here there is no
 * element to start from.
 *
 * `resolve` closes that by falling back to a synthetic `CanvasRectSource`
 * spanning the node's SHALLOWEST RENDERED DESCENDANTS — the boxes the user
 * actually sees the component occupy. This needs the page tree (the DOM alone
 * cannot say which elements belong to a fragment node), so callers that want
 * the fallback pass it.
 */
import { getChildren } from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import { nodeVisualRect, type CanvasRectSource, type ClientRectLike } from './canvasDomGeometry'

/**
 * How deep the fragment walk descends past a node with no element of its own
 * before giving up. A component's rendered root sits one level under its
 * instance; each extra level is another fragment node nested immediately
 * inside (an instance whose component immediately renders another component).
 * Four covers real nesting while keeping the walk a small constant.
 */
const MAX_FRAGMENT_DESCENT = 4

/** Escape a value for safe interpolation into a `[attr="…"]` CSS selector. */
export function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Per-overlay cache of nodeId → rendered element inside one breakpoint
 * iframe.
 *
 * The selection overlay's RAF tick used to `querySelector` every tracked
 * node on every frame — an O(document) attribute scan per ring at 60fps.
 * Caching the resolved element makes the steady-state tick O(1) per ring;
 * a cached entry is re-queried only when it has been unmounted
 * (`!isConnected` — e.g. the node re-rendered) or when the iframe swapped
 * documents (a srcDoc reload leaves stale elements connected to the OLD
 * document, so `ownerDocument` must match the live one).
 *
 * Call `retainOnly` with the ids tracked this tick so entries for
 * deselected nodes don't pin detached DOM subtrees in memory.
 */
export class CanvasNodeElementCache {
  private elements = new Map<string, HTMLElement>()

  /**
   * The measurable box source for `nodeId` inside `doc` — its own rendered
   * element, or `null` when this frame doesn't render the node.
   *
   * Pass `tree` to also cover zero-DOM fragment nodes (see the module
   * docblock): when the node rendered no element of its own, the returned
   * source spans its shallowest rendered descendants instead. Omitting `tree`
   * keeps the plain element-only lookup.
   *
   * Fragment sources are deliberately NOT cached — they are computed from a
   * bounded walk (`MAX_FRAGMENT_DESCENT`) gated on this frame owning the tree
   * at all, and unlike an element they have no `isConnected` to invalidate
   * against.
   */
  resolve(
    doc: Document,
    nodeId: string,
    tree?: NodeTree<PageNode> | null,
  ): CanvasRectSource | null {
    const cached = this.elements.get(nodeId)
    if (cached && cached.isConnected && cached.ownerDocument === doc) return cached

    const element = doc.querySelector<HTMLElement>(
      `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
    )
    if (element) {
      this.elements.set(nodeId, element)
      return element
    }
    this.elements.delete(nodeId)
    return tree ? fragmentNodeRectSource(doc, tree, nodeId) : null
  }

  retainOnly(nodeIds: ReadonlySet<string>): void {
    for (const id of this.elements.keys()) {
      if (!nodeIds.has(id)) this.elements.delete(id)
    }
  }
}

/**
 * A `CanvasRectSource` spanning `nodeId`'s shallowest rendered descendants, or
 * `null` when it has none in `doc`.
 *
 * Only meaningful for a node that rendered no element of its own — a
 * `studio.instance` fragment (WS-4.2). The union is taken over the FIRST
 * rendered element found down each branch: descent stops as soon as a
 * descendant has an element, so a component's rendered root is measured, not
 * every box inside it.
 *
 * Guarded on this frame actually rendering `tree`: without that check, every
 * board frame that does NOT own the selected node would walk the subtree on
 * every RAF tick just to conclude nothing is there. The tree root (`base.body`)
 * always renders — `applyIframeBodyPresentation` stamps `data-node-id` onto the
 * iframe `<body>` — so its presence is an O(1) "this frame owns this page".
 */
export function fragmentNodeRectSource(
  doc: Document,
  tree: NodeTree<PageNode>,
  nodeId: string,
): CanvasRectSource | null {
  const rootSelector = `[data-node-id="${escapeCssAttributeValue(tree.rootNodeId)}"]`
  if (!doc.querySelector(rootSelector)) return null

  const elements: Element[] = []
  const collect = (id: string, depth: number): void => {
    if (depth > MAX_FRAGMENT_DESCENT) return
    for (const child of getChildren(tree, id)) {
      const element = doc.querySelector(
        `[data-node-id="${escapeCssAttributeValue(child.id)}"]`,
      )
      if (element) elements.push(element)
      else collect(child.id, depth + 1)
    }
  }
  collect(nodeId, 0)
  if (elements.length === 0) return null

  // Recomputed on read (not captured) so the source stays live across the
  // reflows the overlay's RAF tick exists to follow.
  return {
    getBoundingClientRect: () => unionVisualRects(elements),
  }
}

/** Smallest rect containing every measurable element in `elements`. */
function unionVisualRects(elements: readonly Element[]): ClientRectLike {
  let union: ClientRectLike | null = null
  for (const element of elements) {
    const rect = nodeVisualRect(element)
    if (!rect) continue
    union = union === null
      ? rect
      : {
        left: Math.min(union.left, rect.left),
        top: Math.min(union.top, rect.top),
        right: Math.max(union.right, rect.right),
        bottom: Math.max(union.bottom, rect.bottom),
        width: 0,
        height: 0,
      }
  }
  // No measurable child → an all-zero rect, which every caller already treats
  // as "nothing to draw" (`nodeVisualRect` returns null for it, and the
  // overlay hides a ring with no finite rect).
  if (!union) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  return {
    left: union.left,
    top: union.top,
    right: union.right,
    bottom: union.bottom,
    width: union.right - union.left,
    height: union.bottom - union.top,
  }
}

export function findRenderedCanvasNodeElement(
  nodeId: string,
  root: Document = document,
): HTMLElement | null {
  return findRenderedCanvasNodes(nodeId, root)[0]?.element ?? null
}

/** A rendered canvas node together with the breakpoint iframe hosting it. */
export interface RenderedCanvasNode {
  element: HTMLElement
  frame: HTMLIFrameElement
}

/**
 * Every canvas frame's rendered element for a node, in frame order — one per
 * breakpoint frame that has mounted the node, paired with its hosting iframe
 * (geometry callers need the frame for zoom/coordinate translation, and
 * `defaultView.frameElement` is not reliable in every environment).
 */
export function findRenderedCanvasNodes(
  nodeId: string,
  root: Document = document,
): RenderedCanvasNode[] {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  const nodes: RenderedCanvasNode[] = []
  for (const frame of root.querySelectorAll('iframe')) {
    let frameDoc: Document | null
    try {
      // Throws for cross-origin frames (a plugin or dev tool may add one to
      // the admin shell); may be null before the frame has loaded.
      frameDoc = frame.contentDocument
    } catch (_err) {
      frameDoc = null
    }
    if (!frameDoc?.body?.hasAttribute('data-breakpoint-id')) continue
    const element = frameDoc.querySelector<HTMLElement>(selector)
    if (element) nodes.push({ element, frame })
  }
  return nodes
}
