/**
 * boardSelectors — the read side of `boardSlice.ts`: `selectActiveBoard`,
 * `selectHasActiveBoard`, the four narrow per-collection selectors, and
 * `selectBoardSnapGuides`. Split out of `boardSlice.ts` purely to stay under
 * the module-size-budget ceiling — mirrors the `boardFrameSelectionActions.ts`
 * / `boardAnnotationSliceActions.ts` splits, except this one separates
 * selectors (the read side) rather than actions (the write side): `boardSlice.ts`
 * stays the slice definition + its actions, this module is every consumer's
 * entry point for reading board state out of the store.
 */
import type { EditorStore } from '@site/store/types'
import type { Board, BoardFrame, BoardGuide, DocBlock, StickyNote } from '@core/studio-board'
import { getActiveBoard } from '@core/studio-board'
import type { SnapGuide } from '@site/canvas/boardSnapping'

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)

/** Whether an active board currently resolves. Cheap boolean — safe to subscribe to on its own where a component only needs the yes/no. */
export const selectHasActiveBoard = (s: EditorStore): boolean =>
  getActiveBoard(s.boards, s.activeBoardId) !== null

// Stable "nothing here" references for the four narrow collection selectors
// below — an inline `?? []` would mint a fresh array every call and defeat
// the whole point of narrowing (Zustand compares by reference).
const EMPTY_FRAMES: readonly BoardFrame[] = []
const EMPTY_NOTES: readonly StickyNote[] = []
const EMPTY_DOCS: readonly DocBlock[] = []
const EMPTY_GUIDES: readonly BoardGuide[] = []

/**
 * Per-collection selectors, one per `Board` sub-array — the fix for the
 * O(frames + notes + docs) re-render cascade: every board-mutating helper in
 * `boardsModel.ts` does copy-on-write on the WHOLE `Board` object (Mutative/
 * history correctness), so `selectActiveBoard` above changes reference on
 * ANY board write, no matter which sub-collection actually changed. These
 * four narrow to just the one array a layer component actually renders.
 *
 * This only works because `boardsModel.ts`'s per-collection transforms
 * (`moveFrame`, `moveNote`, `moveDoc`, `resizeFrame`, …) reuse the SAME
 * array reference for every sibling array they don't touch — `moveNote`
 * returns `{ ...board, notes }` with `frames`/`docs`/`guides` untouched, so
 * `board.frames` here stays referentially stable across a note drag. If a
 * future `boardsModel.ts` transform ever rebuilds an untouched sibling array
 * (e.g. via a broad object-literal reconstruction of `Board` instead of a
 * targeted spread), these selectors go from O(1) skips back to
 * O(frames+notes+docs) silently — the `board-layer-narrow-selectors` render-
 * count tests are the tripwire for that regression.
 */
export const selectActiveBoardFrames = (s: EditorStore): readonly BoardFrame[] =>
  getActiveBoard(s.boards, s.activeBoardId)?.frames ?? EMPTY_FRAMES

export const selectActiveBoardNotes = (s: EditorStore): readonly StickyNote[] =>
  getActiveBoard(s.boards, s.activeBoardId)?.notes ?? EMPTY_NOTES

export const selectActiveBoardDocs = (s: EditorStore): readonly DocBlock[] =>
  getActiveBoard(s.boards, s.activeBoardId)?.docs ?? EMPTY_DOCS

export const selectActiveBoardGuides = (s: EditorStore): readonly BoardGuide[] =>
  getActiveBoard(s.boards, s.activeBoardId)?.guides ?? EMPTY_GUIDES

/** Select the active drag's snap guides (empty outside of a drag). */
export const selectBoardSnapGuides = (s: EditorStore): SnapGuide[] => s.boardSnapGuides
