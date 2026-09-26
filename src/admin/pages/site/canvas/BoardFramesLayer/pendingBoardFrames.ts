/**
 * P6-B — the frames on a board whose page has not arrived yet but is on its
 * way (`streamedLoadSlice.ts`'s `pendingPages`), each with the title to show
 * while it waits (`PendingBoardFrame`). The sibling of
 * `resolveFramesWithPages`: same parallel `frames`/`pages` arrays, the frames
 * that function drops.
 *
 * A frame whose page is simply gone is NOT pending: it stays unrendered, as
 * `resolveFramesWithPages` has always left it.
 */
import type { Page } from '@core/page-tree'
import type { PendingPage } from '@core/persistence/types'
import type { BoardFrame } from '@core/studio-board'

export interface PendingBoardFrameEntry {
  frame: BoardFrame
  title: string
}

const NO_PENDING_FRAMES: PendingBoardFrameEntry[] = []

export function pendingBoardFrames(
  frames: readonly BoardFrame[],
  pages: readonly (Page | null)[],
  pendingPages: readonly PendingPage[],
): PendingBoardFrameEntry[] {
  if (pendingPages.length === 0) return NO_PENDING_FRAMES
  const titleById = new Map(pendingPages.map((page) => [page.id, page.title]))
  const pending: PendingBoardFrameEntry[] = []
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!
    const title = pages[i] ? undefined : titleById.get(frame.pageId)
    if (title !== undefined) pending.push({ frame, title })
  }
  return pending
}
