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
 * The element a node renders AS, or `null` when it has none of its own.
 *
 * The distinction `RenderedCanvasNodeCache.resolve` deliberately blurs: that
 * one falls back to a fragment's rendered DESCENDANTS so a zero-DOM node
 * (`studio.instance` — a component call site, rendered as a bare Fragment) can
 * still be measured for a ring. That fallback is right for drawing a box
 * around something, and wrong for anything that has to WRITE to the element,
 * because there is no element to write to.
 *
 * Resize handles are the second kind. Offering them on a call site produced a
 * dead affordance — eight handles, drawn around the union of the component's
 * children, that no drag could ever move.
 */
export function ownElementForNode(doc: Document, nodeId: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[data-node-id="${escapeCssAttributeValue(nodeId)}"]`)
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
  for (const { doc, frame } of canvasFrameDocuments(root)) {
    const element = doc.querySelector<HTMLElement>(selector)
    if (element) nodes.push({ element, frame })
  }
  return nodes
}

/** A canvas frame's document, paired with the iframe hosting it. */
export interface CanvasFrameDocument {
  doc: Document
  frame: HTMLIFrameElement
}

/**
 * Every mounted canvas frame document, in frame order.
 *
 * The `data-breakpoint-id` check on `<body>` is what distinguishes a canvas
 * frame from any other iframe in the admin shell (a plugin surface, a preview,
 * a dev tool). Shared so every lookup below agrees on what counts as a canvas
 * frame instead of re-deciding it.
 */
export function canvasFrameDocuments(root: Document = document): CanvasFrameDocument[] {
  const docs: CanvasFrameDocument[] = []
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
    docs.push({ doc: frameDoc, frame })
  }
  return docs
}

/** A measurable rect source for a node, with the frame it was found in. */
export interface CanvasNodeRectSource {
  source: CanvasRectSource
  frame: HTMLIFrameElement
  doc: Document
}

/**
 * The measurable box source for `nodeId` in the first canvas frame that has
 * it — its own element, or, when it rendered none, the span of its shallowest
 * rendered descendants.
 *
 * `findRenderedCanvasNodes` answers "which element", which is `null` for a
 * node that renders no element at all (a `studio.instance` fragment — see this
 * module's docblock). Anything that needs to know WHERE A NODE IS, rather than
 * which element it is, wants this instead: pass `tree` and a fragment node
 * still reports the box the user can see and point at.
 */
export function findCanvasNodeRectSource(
  nodeId: string,
  tree?: NodeTree<PageNode> | null,
  root: Document = document,
): CanvasNodeRectSource | null {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  for (const { doc, frame } of canvasFrameDocuments(root)) {
    const element = doc.querySelector<HTMLElement>(selector)
    if (element) return { source: element, frame, doc }
    const fragment = tree ? fragmentNodeRectSource(doc, tree, nodeId) : null
    if (fragment) return { source: fragment, frame, doc }
  }
  return null
}

/**
 * Per-caller cache of nodeId → every canvas frame currently rendering it
 * (`findRenderedCanvasNodes`'s own result, cached).
 *
 * Written for the properties/inspect panels' computed-style readers
 * (`useInspectComputedStyle.ts`), which re-run this lookup on every render —
 * for the Properties panel, that means once per KEYSTROKE that edits the
 * selected node's style, since `StyleSurface` re-renders to show what was
 * just typed. Before this cache, that was an uncached
 * `document.querySelectorAll('iframe')` over the whole admin document
 * followed by a cross-document `frameDoc.querySelector('[data-node-id=…]')`
 * INSIDE each breakpoint iframe's own (arbitrarily large, user-authored)
 * page — on every character typed, fanned out across every open breakpoint
 * frame (commonly 3+).
 *
 * `CanvasNodeElementCache` above is NOT reusable here directly: it caches
 * exactly one element per nodeId, keyed by nodeId alone, because its caller
 * (the selection overlay) already knows which single frame `Document` it's
 * asking about and calls `resolve(doc, nodeId)` once per frame in its own
 * loop. This cache's callers don't have that per-frame loop — they need
 * "every frame that renders this node" in one shot, exactly what
 * `findRenderedCanvasNodes` returns — so caching would need one cache slot
 * per (frame, nodeId) pair, not one per nodeId. Same validate-on-read design
 * as `CanvasNodeElementCache` (`isConnected`, not blind TTL), extended with a
 * frame-count check so a frame being added or removed (a new breakpoint
 * preview opened/closed) isn't missed the way a single element's
 * `isConnected` flip would.
 *
 * Correctness: a cached entry is trusted only when EVERY element in it is
 * still `.isConnected` (a node re-render replaces the DOM node — Studio's
 * canvas iframes re-render the whole app on a style/prop edit, but stable
 * elements keep the SAME node, e.g. a `style=""` attribute mutation — so
 * this both keeps the fast path for in-place updates and self-heals on an
 * actual remount) AND the live count of canvas iframes under `root` hasn't
 * changed since the entry was built. Both checks failing forces a fresh
 * `findRenderedCanvasNodes` scan, which repopulates the cache — never a
 * stale read.
 */
export class RenderedCanvasNodeCache {
  private entries = new Map<string, RenderedCanvasNode[]>()
  private frameCountAtLastScan = -1

  resolve(nodeId: string, root: Document = document): RenderedCanvasNode[] {
    const liveFrameCount = root.querySelectorAll('iframe').length
    const cached = this.entries.get(nodeId)
    const cacheIsValid =
      cached !== undefined &&
      liveFrameCount === this.frameCountAtLastScan &&
      cached.every((entry) => entry.element.isConnected && entry.frame.isConnected)
    if (cacheIsValid) return cached

    const fresh = findRenderedCanvasNodes(nodeId, root)
    this.entries.set(nodeId, fresh)
    this.frameCountAtLastScan = liveFrameCount
    return fresh
  }

  /**
   * Drop every cached entry except `nodeIds` — call with the single
   * currently-selected node id (or an empty set on deselect) so switching
   * between many nodes over a session doesn't pin detached DOM subtrees in
   * memory forever.
   */
  retainOnly(nodeIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!nodeIds.has(id)) this.entries.delete(id)
    }
  }
}
