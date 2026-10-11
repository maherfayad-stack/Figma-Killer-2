/**
 * nodeDom — the two DOM reads every in-frame gesture and measurement shares:
 * which stamped node an element belongs to, and where a box sits relative to
 * the body. Split from `runtime.ts` with `gestureForwarding.ts` (`live-12`)
 * so both can read them without either importing the other.
 */
import type { NodeRect } from './messages'
import { NODE_ID_ATTR, occurrenceIndexOf } from './nodeIdIndexing'

/** The nearest node-id-carrying ancestor (inclusive) of `el`, paired with its own occurrence index — `null` if no ancestor carries a node id. */
export function nearestNodeOccurrence(doc: Document, el: Element | null): { nodeId: string; occurrenceIndex: number } | null {
  const anchor = el?.closest(`[${NODE_ID_ATTR}]`) as Element | null
  if (!anchor) return null
  return occurrenceIndexOf(doc, anchor)
}

/** `el`'s box relative to `body`'s border box — both rects are viewport-relative, so scroll cancels out of the difference. */
export function rectRelativeToBody(el: Element, body: HTMLElement): NodeRect {
  const elRect = el.getBoundingClientRect()
  const bodyRect = body.getBoundingClientRect()
  return {
    x: elRect.left - bodyRect.left,
    y: elRect.top - bodyRect.top,
    width: elRect.width,
    height: elRect.height,
  }
}

/**
 * The element a node is actually SEEN as — `own`, then down through any
 * layout-transparent host it renders. A module may carry the node id on a
 * `display: contents` wrapper so the wrapper cannot disturb the component's
 * own layout; that host is the right thing to select and the wrong thing to
 * size (`width` on it does nothing), so the box the user is pointing at is
 * one level down. Descent stops at anything carrying its own node id (that
 * box belongs to a different node) and at anything with more than one
 * element child (no single "the" element to mean). Bounded rather than
 * `while (true)`: a deep chain of transparent wrappers is not worth walking.
 */
export function presentedElementOf(view: Window, own: Element): HTMLElement {
  let element = own as HTMLElement
  for (let depth = 0; depth < 4; depth += 1) {
    if (view.getComputedStyle(element).display !== 'contents') return element
    const children = Array.from(element.children)
    const only = children.length === 1 ? (children[0] as HTMLElement) : null
    if (!only || only.hasAttribute(NODE_ID_ATTR)) return element
    element = only
  }
  return element
}

/** How many stamped ancestors a `pointer` or `text:editStart` message carries — deeper than any real component nesting, small enough to never matter on the wire. */
const MAX_ANCESTORS = 32

/**
 * Every stamped ancestor of `el` (inclusive), innermost first, each with its
 * own occurrence index. The runtime stamps by SOURCE position, so the
 * innermost stamp under a gesture can be a package's own internal element;
 * the parent walks this chain to the first node its tree knows
 * (`BridgeFrameAdapter`'s `nearestKnownNodeId`).
 */
export function stampedAncestors(doc: Document, el: Element | null): { nodeId: string; occurrenceIndex: number }[] {
  const chain: { nodeId: string; occurrenceIndex: number }[] = []
  let current = el?.closest(`[${NODE_ID_ATTR}]`) ?? null
  while (current && chain.length < MAX_ANCESTORS) {
    const occurrence = occurrenceIndexOf(doc, current)
    if (occurrence) chain.push(occurrence)
    current = current.parentElement?.closest(`[${NODE_ID_ATTR}]`) ?? null
  }
  return chain
}
