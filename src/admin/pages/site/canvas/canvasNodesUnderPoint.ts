/**
 * canvasNodesUnderPoint — every layer under a point on the canvas, innermost
 * first (P5-E, IX-26): the right-click menu's "Select layer" list, Penpot's
 * and Figma's way to reach a layer that sits under another one.
 *
 * `elementsFromPoint` in the frame's own document answers "what is here" the
 * way the browser paints it — every box at the point, top to bottom,
 * including ancestors — and each element maps to the node that owns it
 * (`closest('[data-node-id]')`). Editor chrome inside the frame (rings,
 * handles) carries no `data-node-id`, so it never appears.
 *
 * Portal frames only: a live bridge frame's document is not reachable from
 * here, and the list is simply empty there (the menu hides the submenu).
 */
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'

/** How many layers the list offers at most — a deep tree under one point stays a usable menu. */
export const NODES_UNDER_POINT_LIMIT = 12

export function nodesUnderClientPoint(clientX: number, clientY: number, root: Document = document): string[] {
  const iframes = [...root.querySelectorAll<HTMLIFrameElement>('iframe')].reverse()
  for (const iframe of iframes) {
    const rect = iframe.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const doc = resolvePortalDocument(iframe)
    if (!doc || typeof doc.elementsFromPoint !== 'function') continue
    // The canvas zoom is a transform on the iframe element: its rect is
    // scaled, its own viewport is not.
    const scale = iframe.offsetWidth > 0 ? rect.width / iframe.offsetWidth : 1
    const x = (clientX - rect.left) / scale
    const y = (clientY - rect.top) / scale
    const ids: string[] = []
    for (const element of doc.elementsFromPoint(x, y)) {
      const id = element.closest('[data-node-id]')?.getAttribute('data-node-id')
      if (id && !ids.includes(id)) ids.push(id)
      if (ids.length >= NODES_UNDER_POINT_LIMIT) break
    }
    return ids
  }
  return []
}
