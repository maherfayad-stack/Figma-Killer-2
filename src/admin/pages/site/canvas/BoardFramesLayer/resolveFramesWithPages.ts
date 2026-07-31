/**
 * `board.frames` is membership — resolve each against `site.pages`, dropping
 * any frame whose page no longer exists (deleted since it was added). Single
 * source of truth for this derivation: `BoardFramesLayer.tsx`'s render body
 * uses it for the frame list and the multi-selection bounding box. Its own
 * module (not exported from `BoardFramesLayer.tsx`) so callers don't have to
 * import the component to get at it.
 */
import type { Page } from '@core/page-tree'
import type { Board, BoardFrame } from '@core/studio-board'

export function resolveFramesWithPages(
  board: Board,
  pages: readonly Page[],
): { frame: BoardFrame; page: Page }[] {
  return board.frames
    .map((frame) => ({ frame, page: pages.find((p) => p.id === frame.pageId) }))
    .filter((entry): entry is { frame: BoardFrame; page: Page } => entry.page !== undefined)
}
