/**
 * dropCandidates — in-frame enumeration of every stamped node's drop-target
 * geometry, answering a bridge frame's `dropCandidates` request (`speed-06`).
 *
 * Mirrors `measureCanvasDropCandidates` (`canvasDomGeometry.ts`, the portal
 * scan a design frame's own document gets) as closely as a cross-origin
 * frame allows: the same axis rule (`resolveCanvasInsertionAxis`, moved to
 * `dropAxisRules.ts` in this same change so both scans share it), and the
 * same body-relative rect convention `measure`/`resize:commit` already speak
 * — the parent (`bodyRelativeRectToFrameSpace` in `canvasDomGeometry.ts`)
 * converts it into the frame-space unit system the drop resolver assumes.
 *
 * **A box-less node is measured as its children's union.** A design-system
 * call site is hosted on a `display: contents` element that has no rect of its
 * own; `nodeVisualRect` (shared with the portal scan) falls back to the union
 * of its boxed children. Skipping such a node left every component instance
 * without a candidate, so `nearestFlowIndex` saw only the plain siblings above
 * the pointer and a drop beside an instance landed at the end of the column.
 *
 * **Bounded per `sec-06`'s posture.** The wire reply schema caps the
 * candidate list and each candidate's `childRects`; this module caps what it
 * even tries to compute, so a page with more stamped nodes than the cap
 * costs no more DOM work than the cap allows.
 */
import { nodeVisualRect } from './nodeVisualRect'
import { NODE_ID_ATTR, occurrenceIndexOf } from './nodeIdIndexing'
import { resolveCanvasInsertionAxis, type CanvasDropAxis } from './dropAxisRules'
import type { NodeRect } from './messages'

/** Matches `OutboundRuntimeMessageSchema`'s `dropCandidates:result.candidates` bound — see `messages.ts`. */
export const MAX_DROP_CANDIDATES = 2000
/** Matches `messages.ts`'s per-candidate `childRects` bound. */
export const MAX_DROP_CANDIDATE_CHILD_RECTS = 200

export interface DropCandidateGeometry {
  nodeId: string
  occurrenceIndex: number
  rect: NodeRect
  axis: CanvasDropAxis
  reversed: boolean
  /** The candidate's own immediate boxed children, document order, capped — unconsumed by today's resolver, carried for a future sibling-geometry axis heuristic (see `dropAxisRules.ts`'s G9 note). */
  childRects: NodeRect[]
}

function isEmptyRect(rect: NodeRect): boolean {
  return rect.width === 0 && rect.height === 0
}

/** `el`'s visual box relative to `body`'s border box, or an empty rect when it has none. */
function visualRectRelativeToBody(el: Element, body: HTMLElement): NodeRect {
  const visual = nodeVisualRect(el)
  if (!visual) return { x: 0, y: 0, width: 0, height: 0 }
  const bodyRect = body.getBoundingClientRect()
  return { x: visual.left - bodyRect.left, y: visual.top - bodyRect.top, width: visual.width, height: visual.height }
}

/** Every stamped node's drop-target geometry in `doc`, capped at {@link MAX_DROP_CANDIDATES}. */
export function collectDropCandidates(doc: Document): DropCandidateGeometry[] {
  if (!doc.body) return []
  const body = doc.body
  const out: DropCandidateGeometry[] = []
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (out.length >= MAX_DROP_CANDIDATES) break
    const occurrence = occurrenceIndexOf(doc, el)
    if (!occurrence) continue
    const rect = visualRectRelativeToBody(el, body)
    if (isEmptyRect(rect)) continue
    const { axis, reversed } = resolveCanvasInsertionAxis(el as HTMLElement)
    const childRects: NodeRect[] = []
    for (const child of el.children) {
      if (childRects.length >= MAX_DROP_CANDIDATE_CHILD_RECTS) break
      const childRect = visualRectRelativeToBody(child, body)
      if (isEmptyRect(childRect)) continue
      childRects.push(childRect)
    }
    out.push({ nodeId: occurrence.nodeId, occurrenceIndex: occurrence.occurrenceIndex, rect, axis, reversed, childRects })
  }
  return out
}
