/**
 * Where each selected node is drawn, for the agent's live digest (AI-9).
 *
 * The server can decode a node id to its `file:line`, but only the browser
 * knows the box: "the button at 24,640, 345×48 in its frame" is what lets an
 * agent say which of three identical buttons the user means, and compare the
 * selection against a measured design without taking a screenshot first.
 *
 * Measured once, when a message is sent — one lookup per selected node per
 * canvas frame, never a subscription and never a layout-thrashing loop. Only
 * frames whose document the admin page can read are measured: a live
 * (cross-origin) frame is skipped, and a node found in no readable frame gets
 * no box, which the digest reports as unmeasured rather than guessing.
 *
 * The box is frame-local CSS px, document-relative — the same space
 * `studio_screenshot`'s `nodeRects` report — so a box in the digest and a
 * rectangle in a capture line up. The first frame that renders a node wins; a
 * node the board shows twice (a variant under other axes) is measured in one.
 */
import { listFrameAdapterRegistrations } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { presentedElementForNode } from '@site/canvas/canvasNodeLookup'
import type { SelectionBoxMeasurer } from './studioAgentSnapshot'

function readableDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument
  } catch (_err) {
    // Cross-origin (a live frame): not readable from here, by design.
    return null
  }
}

export const measureSelectionBoxes: SelectionBoxMeasurer = (nodeIds) => {
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>()
  const pending = new Set(nodeIds)
  for (const iframe of listFrameAdapterRegistrations().keys()) {
    if (pending.size === 0) break
    const doc = readableDocument(iframe)
    const view = doc?.defaultView
    if (!doc || !view) continue
    for (const nodeId of [...pending]) {
      const element = presentedElementForNode(doc, nodeId)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) continue
      boxes.set(nodeId, {
        x: Math.round(rect.left + view.scrollX),
        y: Math.round(rect.top + view.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      pending.delete(nodeId)
    }
  }
  return boxes
}
