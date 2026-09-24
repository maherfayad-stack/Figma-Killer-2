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
 * The box is BODY-relative CSS px (`rectRelativeToBody`) — the space the frame
 * adapters' `measure` and the capture's `nodeRects` speak — so a box in the
 * digest and a rectangle in a screenshot line up. The first frame that renders
 * a node wins; a node the board shows twice is measured in one.
 *
 * Deliberately built on leaf modules only — the adapter registry, the
 * attribute escaper and `@core/studio-runtime`'s shared node-DOM rules — and
 * not on `canvasNodeLookup.ts`: the agent slice is composed INTO the editor
 * store, and the canvas lookup reaches the store through the frame adapters,
 * which would make the store import itself.
 */
import { presentedElementOf, rectRelativeToBody } from '@core/studio-runtime'
import { listFrameAdapterRegistrations } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { escapeCssAttributeValue } from '@site/canvas/escapeCssAttributeValue'
import type { SelectionBoxMeasurer } from './studioAgentSnapshot'

function readableDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument
  } catch (_err) {
    // Cross-origin (a live frame): not readable from here, by design.
    return null
  }
}

/**
 * The element carrying `nodeId`, or `null`. Never throws: this runs while a
 * message is being SENT, and a selector a DOM implementation rejects must cost
 * one box, not the message.
 */
function elementFor(doc: Document, nodeId: string): Element | null {
  try {
    return doc.querySelector(`[data-node-id="${escapeCssAttributeValue(nodeId)}"]`)
  } catch (err) {
    console.error('[agent/selectionBoxes] could not look up a selected node — sending without its box:', err)
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
    if (!doc || !view || !doc.body) continue
    for (const nodeId of [...pending]) {
      const own = elementFor(doc, nodeId)
      if (!own) continue
      const rect = rectRelativeToBody(presentedElementOf(view, own), doc.body)
      if (rect.width <= 0 && rect.height <= 0) continue
      boxes.set(nodeId, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
      pending.delete(nodeId)
    }
  }
  return boxes
}
