/**
 * canvasNodesUnderPoint — every layer under a point on the canvas, innermost
 * first (P5-E, IX-26): the right-click menu's "Select layer" list, Penpot's
 * and Figma's way to reach a layer that sits under another one.
 *
 * SB-3: answered from the frame's rect index (`frameGeometry/`), not from the
 * frame's document. The index lists every boxed node at the point, topmost
 * first, ancestors included, which is what `elementsFromPoint` +
 * `closest('[data-node-id]')` produced. Editor chrome inside the frame (rings,
 * handles) carries no `data-node-id`, so it is never in the index. It works for
 * a live bridge frame too, which the DOM version could not reach (that menu
 * entry used to be empty there).
 *
 * Async because the first query of a frame reads it (`adapter.measureAll`);
 * every later one is answered from the cache until the frame reports a change.
 */
import { hitTestBoard } from './frameGeometry/frameGeometryRegistry'

/** How many layers the list offers at most — a deep tree under one point stays a usable menu. */
export const NODES_UNDER_POINT_LIMIT = 12

export async function nodesUnderClientPoint(clientX: number, clientY: number): Promise<string[]> {
  const found = await hitTestBoard({ x: clientX, y: clientY })
  return found ? found.hits.slice(0, NODES_UNDER_POINT_LIMIT).map((hit) => hit.nodeId) : []
}
