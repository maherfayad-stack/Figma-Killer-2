/**
 * `board.frames` is membership — resolve each against `site.pages`, dropping
 * any frame whose page no longer exists (deleted since it was added). Single
 * source of truth for this derivation: `BoardFramesLayer.tsx`'s render body
 * uses it for the frame list / selection bounding box, and
 * `useMarqueeSelection.ts`'s pointermove handler recomputes it fresh from
 * `useEditorStore.getState()` on every move rather than closing over a stale
 * render-scoped value. Its own module (not exported from `BoardFramesLayer.tsx`)
 * so the two don't import each other.
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
