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
import type { Board, BoardFrame, BoardGuide, CanvasLayerPlacement, DocBlock, StickyNote } from '@core/studio-board'
import { getActiveBoard } from '@core/studio-board'
import { isGalleryPage } from '@core/component-variants'
import type { SnapGuide, SnapSpacing } from '@core/studio-runtime'

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)

/**
 * Ids of the pages a default board is seeded with. A variants gallery is
 * derived and lives on the server-placed Components board, so it is never
 * seeded onto another one. Lives here (the store chunk), not in the route
 * shell, so the shell does not import `@core/component-variants`.
 */
export const selectSeedablePageIds = (s: EditorStore): string[] =>
  (s.site?.pages ?? []).filter((page) => !isGalleryPage(page)).map((page) => page.id)

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
const EMPTY_LAYERS: readonly CanvasLayerPlacement[] = []

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

/** P5-G — the active board's loose-layer placements (`Board.layers`), narrow like the four above. */
export const selectActiveBoardLayers = (s: EditorStore): readonly CanvasLayerPlacement[] =>
  getActiveBoard(s.boards, s.activeBoardId)?.layers ?? EMPTY_LAYERS

/** Select the active drag's snap guides (empty outside of a drag). */
export const selectBoardSnapGuides = (s: EditorStore): SnapGuide[] => s.boardSnapGuides
export const selectBoardSnapSpacings = (s: EditorStore): SnapSpacing[] => s.boardSnapSpacings

/**
 * SB-1 — the board frame a Layers-panel row stands for. The Layers tree is the
 * ACTIVE page's tree, and a board can render that page in more than one frame
 * (a "duplicate as variant" shares every node id). A selection or hover made
 * with no `frameId` is mirrored by every mounted frame whose page holds the
 * node (PERF-2, PERF-13): each mounts a ring and pays the frame-fit and unroll
 * passes for it. Naming ONE frame confines the chrome to it. The frame the
 * user last worked in wins when it shows the active page; otherwise the first
 * frame of that page. `null` when no frame of the active board shows the page
 * (a Visual Component document, or no board) — the old mirrored behaviour,
 * which is then the only one that can show anything.
 */
export function selectLayersFrameId(s: EditorStore): string | null {
  const pageId = s.activeDocument === null || s.activeDocument.kind === 'page' ? s.activePageId : null
  if (pageId === null) return null
  const frames = selectActiveBoardFrames(s)
  const remembered = s.selectedNodeFrameId
  let first: string | null = null
  for (const frame of frames) {
    if (frame.pageId !== pageId) continue
    if (frame.id === remembered) return frame.id
    first ??= frame.id
  }
  return first
}
