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
 * The selection chrome closes that from the frame's rect index and the page
 * tree instead (`frameChromeRects.ts`): a node the index does not list takes the
 * union of its children's boxes. The DOM alone cannot say which elements belong
 * to a fragment node, so this lookup stays element-only.
 */
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { presentedElementOf } from '@core/studio-runtime'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { NodeRect } from './frameAdapter/FrameDocumentAdapter'
import { escapeCssAttributeValue } from './escapeCssAttributeValue'

export { escapeCssAttributeValue }

/**
 * The element a node renders AS, or `null` when it has none of its own.
 *
 * The distinction the selection chrome's rect lookup deliberately blurs
 * (`frameChromeRects.ts`): it falls back to a fragment's rendered DESCENDANTS so
 * a zero-DOM node (`studio.instance` — a component call site, rendered as a bare
 * Fragment) can still be measured for a ring. That fallback is right for drawing a box
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
  // The descent rule itself is shared with the in-frame runtime's resize
  // handles (`live-13`), which size the same presented element cross-origin.
  return presentedElementOf(view, own)
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
