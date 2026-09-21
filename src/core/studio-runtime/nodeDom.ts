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
