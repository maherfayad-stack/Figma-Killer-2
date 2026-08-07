/**
 * `board.frames` is membership — pair each frame with its already-resolved
 * page, dropping any frame whose page no longer exists (deleted since it was
 * added). Single source of truth for this derivation: `BoardFramesLayer.tsx`'s
 * render body uses it for the frame list and the multi-selection bounding
 * box. Its own module (not exported from `BoardFramesLayer.tsx`) so callers
 * don't have to import the component to get at it.
 *
 * `pages` MUST be the same length and order as `frames` — a parallel array,
 * one resolved `Page | null` per frame, built by the caller via
 * `lookupCanvasPageById` (store.ts, shared with C1's `selectCanvasPageFor`
 * cache). This function does a plain O(frames) zip, never its own `.find()`
 * scan — the O(pages) lookup itself is the caller's job (STUDIO-FIGMA-PARITY-
 * PLAN.md Track C, C2).
 */
import type { Page } from '@core/page-tree'
import type { BoardFrame } from '@core/studio-board'

export function resolveFramesWithPages(
  frames: readonly BoardFrame[],
  pages: readonly (Page | null)[],
): { frame: BoardFrame; page: Page }[] {
  const result: { frame: BoardFrame; page: Page }[] = []
  for (let i = 0; i < frames.length; i++) {
    const page = pages[i]
    if (page) result.push({ frame: frames[i], page })
  }
  return result
}
