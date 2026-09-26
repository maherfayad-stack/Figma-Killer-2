/**
 * loadPriority — the order a cold load parses its routes in: the frames a
 * person sees first, first (P6-B, PERF-7).
 *
 * A cold parse of a 40-page project takes seconds, and every page is equal to
 * the parser — but not to the person waiting. The board opens on its first
 * board, fitted around its frames, reading top-left to bottom-right, so that
 * is the order routes are parsed in: the first board's frames by `y`, then
 * `x`; then every other board's frames the same way; then any page no frame
 * shows, in discovery order.
 *
 * Today the order is felt in two ways: the load yields to the event loop
 * between routes (so a cold parse no longer blocks every other request for
 * its whole duration), and the NDJSON stream emits pages in this order, each
 * line carrying its place in the project's page order (`studioLoadResponse.ts`)
 * — so the client can apply each page as it arrives once the load itself
 * streams per page.
 *
 * The server does not know the camera; the board's resting layout is the best
 * proxy it has. Reading `.studio/boards.json` is best-effort: an unreadable
 * file just means discovery order.
 */
import { readBoardsFile } from './boardGeometry'

/** `pageIds` (discovery order) reordered by where their frames sit on the boards. Every id appears exactly once. */
export function viewportPriorityOrder(dir: string, pageIds: readonly string[]): string[] {
  let boards: ReturnType<typeof readBoardsFile>['boards']
  try {
    boards = readBoardsFile(dir).boards
  } catch (err) {
    console.error('[studio:loadPriority] could not read the board; parsing in discovery order:', err)
    return [...pageIds]
  }
  const known = new Set(pageIds)
  const ordered: string[] = []
  const placed = new Set<string>()
  for (const board of boards) {
    const frames = [...board.frames].sort((a, b) => a.y - b.y || a.x - b.x)
    for (const frame of frames) {
      if (!known.has(frame.pageId) || placed.has(frame.pageId)) continue
      placed.add(frame.pageId)
      ordered.push(frame.pageId)
    }
  }
  for (const pageId of pageIds) if (!placed.has(pageId)) ordered.push(pageId)
  return ordered
}
