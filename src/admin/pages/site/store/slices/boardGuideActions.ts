/**
 * boardGuideActions — persisted ruler guide actions (D1), as a thin
 * `Board -> Board` wrapper over the pure `@core/studio-board` transforms.
 * Mirrors `boardAnnotationActions.ts`'s shape exactly (its own module doc
 * explains why notes/docs were split out of `boardSlice.ts` — the same
 * 700-line module-size ceiling applies here, so guides land in their own
 * sibling module from the start rather than growing the slice file directly).
 *
 * `addGuide` mints the id (`crypto.randomUUID()`), matching `addNote`/`addDoc`.
 */
import {
  upsertGuide,
  moveGuide as moveGuideOnBoard,
  removeGuide as removeGuideFromBoard,
  type Board,
  type BoardGuide,
} from '@core/studio-board'

export function addGuide(board: Board, axis: 'x' | 'y', position: number): Board {
  const guide: BoardGuide = { id: crypto.randomUUID(), axis, position }
  return upsertGuide(board, guide)
}

export function moveGuide(board: Board, guideId: string, position: number): Board {
  return moveGuideOnBoard(board, guideId, position)
}

export function removeGuide(board: Board, guideId: string): Board {
  return removeGuideFromBoard(board, guideId)
}
