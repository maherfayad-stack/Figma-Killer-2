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
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { NodeRect } from './frameAdapter/FrameDocumentAdapter'
import { escapeCssAttributeValue } from './escapeCssAttributeValue'

export { escapeCssAttributeValue }

/**
 * How deep the fragment walk descends past a node with no element of its own
 * before giving up. A component's rendered root sits one level under its
 * instance; each extra level is another fragment node nested immediately
 * inside (an instance whose component immediately renders another component).
 * Four covers real nesting while keeping the walk a small constant.
 */
const MAX_FRAGMENT_DESCENT = 4

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
 * The element a node is actually SEEN as — `ownElementForNode`, then down
 * through any layout-transparent host it renders.
 *
 * A module is allowed to carry the node id on a wrapper that produces no box:
 * `src/modules/alm/register.tsx` puts the editor's `data-node-id` and event
 * handlers on a `display: contents` div and renders the design-system
 * component inside it, deliberately, so the wrapper cannot disturb the
 * component's own layout (a real box there would break percentage-height
 * chains and every sibling combinator crossing it).
 *
 * That host is the right thing to SELECT and the wrong thing to size: `width`
 * on `display: contents` does nothing. The element the user is pointing at is
 * one level down. Descent stops at anything carrying its own `data-node-id` —
 * that box belongs to a different node, and resizing it here would write to
 * the wrong place — and at anything with more than one element child, where
 * there is no single "the" element to mean.
 */
export function presentedElementForNode(doc: Document, nodeId: string): HTMLElement | null {
  const own = ownElementForNode(doc, nodeId)
  const view = doc.defaultView
  if (!own || !view) return own

  let element = own
  // Bounded rather than `while (true)`: a cycle is impossible in a tree, but a
  // deep chain of transparent wrappers is not worth walking, and a fixed
  // ceiling keeps this safe to call from a render.
  for (let depth = 0; depth < 4; depth += 1) {
    if (view.getComputedStyle(element).display !== 'contents') return element
    const children = Array.from(element.children)
    const only = children.length === 1 ? (children[0] as HTMLElement) : null
    if (!only || only.hasAttribute('data-node-id')) return element
    element = only
  }
  return element
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

/**
 * Portal-mode-only ("Class A", `live-05`/STATE.md — the architect's Batch 4
 * resolution) — the element `nodeId` renders as, in the FIRST registered
 * PORTAL frame that has it. Genuinely portal-only, not a scoping shortcut:
 * its real callers (`useClassPickerDerivedState.ts`'s `Element.matches()`
 * selector-affinity check, the plugin SDK's `useCanvasNodeRect`'s
 * `getBoundingClientRect()`) need an ACTUAL live `Element` to call a DOM
 * method on — something that cannot exist for a cross-origin bridge frame
 * under any adapter design (`adapter.measure()` hands back a rect/computed-
 * style SNAPSHOT, never a node). A bridge-registered frame is silently
 * skipped here, never attempted. See `findRenderedCanvasNodes` below for the
 * cross-mode sibling that only needs rect/computed-style values, which
 * bridge mode genuinely CAN answer.
 */
export function findRenderedCanvasNodeElement(nodeId: string): HTMLElement | null {
  return findRenderedCanvasElements(nodeId)[0]?.element ?? null
}

/** A rendered canvas node's real element (portal-mode only — see `findRenderedCanvasNodeElement`'s doc), paired with the breakpoint iframe hosting it. */
export interface RenderedCanvasElement {
  element: HTMLElement
  frame: HTMLIFrameElement
}

/**
 * Every PORTAL canvas frame's rendered element for a node, in adapter-
 * registration order (`canvasFrameAdapterRegistry.ts`) — the direct
 * replacement for the old `findRenderedCanvasNodes`'s "which element"
 * question, now explicitly scoped to the mode that can actually answer it.
 */
export function findRenderedCanvasElements(nodeId: string): RenderedCanvasElement[] {
  const results: RenderedCanvasElement[] = []
  for (const [frame, adapter] of listFrameAdapters()) {
    if (!isPortalFrameAdapter(adapter)) continue
    const doc = adapter.getPortalWindow()?.document
    const element = doc ? ownElementForNode(doc, nodeId) : null
    if (element) results.push({ element, frame })
  }
  return results
}

/**
 * A rendered canvas node's measured geometry/computed-style — NOT a live
 * element (see `findRenderedCanvasNodeElement` for the portal-only sibling
 * that hands back one of those instead) — paired with the frame that
 * rendered it.
 */
export interface RenderedCanvasNode {
  rect: NodeRect
  computedStyle: Record<string, string>
  frame: HTMLIFrameElement
}

/**
 * Every mounted canvas frame's measured rect/computed-style for a node, in
 * adapter-registration order — the CROSS-MODE ("Class B") answer to "which
 * frames render this node, and where" (`live-05`, STATE.md, the architect's
 * Batch 4 resolution). Works identically for a same-origin portal frame and
 * a cross-origin bridge frame through `adapter.measure` — this function
 * never knows or cares which kind of adapter it's talking to. Genuinely
 * async even in portal mode (bundles every frame's measurement into one
 * `Promise.all`, rather than pretending the multi-frame case is
 * synchronous just because any ONE portal measurement happens to resolve
 * synchronously under the hood).
 */
export async function findRenderedCanvasNodes(
  nodeId: string,
  properties?: string[],
): Promise<RenderedCanvasNode[]> {
  const entries = Array.from(listFrameAdapters())
  const measured = await Promise.all(
    entries.map(async ([frame, adapter]): Promise<RenderedCanvasNode | null> => {
      const [result] = await adapter.measure([{ nodeId }], properties)
      if (!result?.rect) return null
      return { rect: result.rect, computedStyle: result.computedStyle, frame }
    }),
  )
  return measured.filter((entry): entry is RenderedCanvasNode => entry !== null)
}

/**
 * `findRenderedCanvasNodes`'s result narrowed to the frame matching
 * `preferredBreakpointId` (its OWN `data-breakpoint-id`, stamped directly on
 * the `<iframe>` element by `IframeFrameSurface` in both `documentMode`
 * branches — NOT its `contentDocument`'s `<body>`, which is unreachable
 * cross-origin for a bridge frame), falling back to the first result when
 * none match. `null` when no registered frame (portal or bridge) renders
 * `nodeId` at all.
 *
 * The cross-mode counterpart to `useInspectComputedStyle.ts`'s portal-only
 * `pickPreferredElement` — same "prefer the active breakpoint, else the
 * first match" rule, expressed against `RenderedCanvasNode`s instead of live
 * elements so it works identically for a same-origin portal frame and a
 * cross-origin bridge frame (P5, STATE.md `panel-26`).
 */
export async function preferredRenderedCanvasNode(
  nodeId: string,
  preferredBreakpointId: string,
  properties?: string[],
): Promise<RenderedCanvasNode | null> {
  const results = await findRenderedCanvasNodes(nodeId, properties)
  if (results.length === 0) return null
  const preferred = results.find(
    (entry) => entry.frame.getAttribute('data-breakpoint-id') === preferredBreakpointId,
  )
  return preferred ?? results[0]!
}

/**
 * A canvas frame's document, paired with the iframe hosting it.
 *
 * Portal-only, and NOT yet migrated off a direct `Document` reach-in —
 * deliberately deferred (`live-05`, STATE.md) alongside `findCanvasNodeRectSource`
 * below, since their one real caller (`usePrototypeEndpoints.ts`) is Batch
 * 7's own territory (capture/agent/prototype tooling), not this pass's.
 * Redesigning this pair in isolation, ahead of their actual caller, would
 * risk guessing at a shape Batch 7 then has to redo.
 */
export interface CanvasFrameDocument {
  doc: Document
  frame: HTMLIFrameElement
}

/**
 * Every mounted, portal-mode canvas frame document, in registration order.
 *
 * Registry-based (`live-05`, STATE.md, Batch 7) instead of a
 * `document.querySelectorAll('iframe')` scan + raw `frame.contentDocument`
 * reach-in — `listFrameAdapters()` (`canvasFrameAdapterRegistry.ts`) is
 * already the shared answer to "what counts as a canvas frame" for every
 * other Class B lookup in this module, so this one now agrees with them
 * instead of re-deciding it via a DOM scan.
 *
 * Portal-mode only: a bridge-registered adapter has no `Document` to return,
 * so a Tier 2 frame contributes nothing here (`findCanvasNodeRectSource`'s
 * `BoardPrototypeLayer` callers don't have a bridge-mode story yet either).
 */
export function canvasFrameDocuments(): CanvasFrameDocument[] {
  const docs: CanvasFrameDocument[] = []
  for (const [frame, adapter] of listFrameAdapters()) {
    if (!isPortalFrameAdapter(adapter)) continue
    const frameDoc = adapter.getPortalWindow()?.document ?? null
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
): CanvasNodeRectSource | null {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  for (const { doc, frame } of canvasFrameDocuments()) {
    const element = doc.querySelector<HTMLElement>(selector)
    if (element) return { source: element, frame, doc }
    const fragment = tree ? fragmentNodeRectSource(doc, tree, nodeId) : null
    if (fragment) return { source: fragment, frame, doc }
  }
  return null
}

/**
 * Per-caller cache of nodeId → every PORTAL canvas frame currently rendering
 * it (`findRenderedCanvasElements`'s own result, cached).
 *
 * Portal-mode only (`live-05`, STATE.md, the architect's Batch 4
 * resolution) — same reason `findRenderedCanvasNodeElement` is: this
 * class's actual real callers (`useClassPickerDerivedState.ts`,
 * `useInspectComputedStyle.ts`'s PORTAL branch) need a real `Element`, which
 * only exists for a portal frame. A cheap, live `.isConnected` validity
 * check (below) is exactly the thing that stops being possible once the
 * cached value is a rect/computed-style SNAPSHOT instead of an element
 * reference — `findRenderedCanvasNodes`'s async, cross-mode sibling has no
 * equivalent cache; its callers (bridge mode) re-fetch on their own trigger
 * list instead (see `useInspectComputedStyle.ts`'s bridge branch).
 *
 * Written for the properties/inspect panels' computed-style readers, which
 * re-run this lookup on every render — for the Properties panel, that means
 * once per KEYSTROKE that edits the selected node's style, since
 * `StyleSurface` re-renders to show what was just typed. Before this cache,
 * that was an uncached `document.querySelectorAll('iframe')` over the whole
 * admin document followed by a cross-document
 * `frameDoc.querySelector('[data-node-id=…]')` INSIDE each breakpoint
 * iframe's own (arbitrarily large, user-authored) page — on every character
 * typed, fanned out across every open breakpoint frame (commonly 3+).
 *
 * `CanvasNodeElementCache` above is NOT reusable here directly: it caches
 * exactly one element per nodeId, keyed by nodeId alone, because its caller
 * (the selection overlay) already knows which single frame `Document` it's
 * asking about and calls `resolve(doc, nodeId)` once per frame in its own
 * loop. This cache's callers don't have that per-frame loop — they need
 * "every frame that renders this node" in one shot, exactly what
 * `findRenderedCanvasElements` returns — so caching would need one cache
 * slot per (frame, nodeId) pair, not one per nodeId. Same validate-on-read
 * design as `CanvasNodeElementCache` (`isConnected`, not blind TTL),
 * extended with a frame-count check so a frame being added or removed (a new
 * breakpoint preview opened/closed) isn't missed the way a single element's
 * `isConnected` flip would.
 *
 * Correctness: a cached entry is trusted only when EVERY element in it is
 * still `.isConnected` (a node re-render replaces the DOM node — Studio's
 * canvas iframes re-render the whole app on a style/prop edit, but stable
 * elements keep the SAME node, e.g. a `style=""` attribute mutation — so
 * this both keeps the fast path for in-place updates and self-heals on an
 * actual remount) AND the live count of registered portal frames hasn't
 * changed since the entry was built. Both checks failing forces a fresh
 * `findRenderedCanvasElements` scan, which repopulates the cache — never a
 * stale read.
 */
export class RenderedCanvasNodeCache {
  private entries = new Map<string, RenderedCanvasElement[]>()
  private frameCountAtLastScan = -1

  resolve(nodeId: string): RenderedCanvasElement[] {
    const liveFrameCount = listFrameAdapters().size
    const cached = this.entries.get(nodeId)
    const cacheIsValid =
      cached !== undefined &&
      liveFrameCount === this.frameCountAtLastScan &&
      cached.every((entry) => entry.element.isConnected && entry.frame.isConnected)
    if (cacheIsValid) return cached

    const fresh = findRenderedCanvasElements(nodeId)
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
