/**
 * nodeGeometry — one batched read of every stamped node's box in a frame
 * document, for the parent-side rect index (SB-3).
 *
 * Both frame kinds call this: the bridge runtime answers `measureAll` with it,
 * and `PortalFrameAdapter.measureAll` runs it on the same-origin document. One
 * implementation, so a portal frame and a bridge frame of the same page index
 * identically.
 *
 * ## What it reads, and why this is cheap
 *
 * - **One pass, no per-node searches.** `measure` finds an element with
 *   `findNthNodeById` (a document scan) per ref and `collectDropCandidates`
 *   calls `occurrenceIndexOf` (a scan) per element, which is quadratic. Here a
 *   single `querySelectorAll` is walked once with a `Map` counter for the
 *   occurrence index and a `Map<Element, number>` for ancestry.
 * - **One body rect**, not one per node (`rectRelativeToBody` re-reads it).
 * - **One `getComputedStyle` per boxed node**, for the five properties a hit
 *   test needs (`overflow`, `pointer-events`, `visibility`, `transform`,
 *   `position`/`z-index`). With a clean layout this is the whole cost.
 *
 * ## Semantics: the same box the canvas draws a ring around
 *
 * The rect is `nodeVisualRect` (a `display: contents` host takes the union of
 * its boxed children), relative to the body border box, exactly the
 * convention `measure` and `collectDropCandidates` already use. A node with no
 * box at all is not listed; its stamped descendants simply attach to the
 * nearest listed ancestor.
 *
 * ## What the flags are for
 *
 * A rect alone cannot answer "what would a click hit". The flags carry just
 * enough of the browser's own hit-test rules for the index to reproduce them
 * for ordinary pages, and to say so honestly when it cannot (`transformed`):
 * see `FrameGeometryIndex` for how each is applied.
 */
import { nodeVisualRect } from './nodeVisualRect'
import { NODE_ID_ATTR } from './nodeIdIndexing'
import { GEOMETRY_NODES_MAX, type GeometryNodeWire } from './geometryMessages'

export interface FrameGeometryRead {
  /** The body's top-left in the frame's viewport; node rects are body-relative. */
  origin: { x: number; y: number }
  nodes: GeometryNodeWire[]
  truncated: boolean
}

/**
 * Where an element paints among its siblings, as one integer: `z-index` doubled, plus one for a positioned
 * element. A positioned `z-index: auto` element therefore paints above every non-positioned sibling and below
 * `z-index: 1`; `z-index: -1` paints below the non-positioned in-flow content. Floats and inline content are
 * not distinguished (they paint between the two); that is the documented approximation.
 */
export function paintRankOf(position: string, zIndex: string): number {
  const positioned = position !== 'static' && position !== ''
  const parsed = Number.parseInt(zIndex, 10)
  const z = Number.isFinite(parsed) ? parsed : 0
  return (positioned ? z * 2 + 1 : 0) | 0
}

export function collectNodeGeometry(doc: Document, view: Window): FrameGeometryRead {
  const body = doc.body
  if (!body) return { origin: { x: 0, y: 0 }, nodes: [], truncated: false }
  const bodyRect = body.getBoundingClientRect()
  const nodes: GeometryNodeWire[] = []
  const listed = new Map<Element, number>()
  const occurrences = new Map<string, number>()
  let truncated = false

  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    const nodeId = el.getAttribute(NODE_ID_ATTR)
    if (!nodeId) continue
    // Counted for EVERY stamped element, listed or not: `occurrenceIndex` is the position among all
    // same-stamp elements, the way `occurrenceIndexOf` counts it.
    const occurrenceIndex = occurrences.get(nodeId) ?? 0
    occurrences.set(nodeId, occurrenceIndex + 1)

    const visual = nodeVisualRect(el)
    if (!visual) continue
    if (nodes.length >= GEOMETRY_NODES_MAX) {
      truncated = true
      break
    }

    let parent = -1
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const index = listed.get(ancestor)
      if (index !== undefined) {
        parent = index
        break
      }
    }

    const style = view.getComputedStyle(el)
    const overflowX = style.overflowX
    const overflowY = style.overflowY
    listed.set(el, nodes.length)
    nodes.push({
      nodeId,
      occurrenceIndex,
      rect: { x: visual.left - bodyRect.left, y: visual.top - bodyRect.top, width: visual.width, height: visual.height },
      parent,
      clips: (overflowX !== '' && overflowX !== 'visible') || (overflowY !== '' && overflowY !== 'visible'),
      inert: style.pointerEvents === 'none' || style.visibility === 'hidden',
      transformed: style.transform !== 'none' && style.transform !== '',
      paint: paintRankOf(style.position, style.zIndex),
    })
  }

  return { origin: { x: bodyRect.left, y: bodyRect.top }, nodes, truncated }
}
