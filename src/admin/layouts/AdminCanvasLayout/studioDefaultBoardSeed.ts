/**
 * shouldSeedDefaultBoard — the pure predicate behind `AdminCanvasLayout.tsx`'s
 * `useStudioDefaultBoardSeed` effect, split into its own module so it is
 * unit-testable without mounting the whole layout AND so the `.tsx` file
 * stays component-only (`react-refresh/only-export-components`).
 *
 * `BoardFramesLayer` now renders exactly `board.frames` — an empty board
 * renders an empty-state card, not "every page". That's correct for a NEW
 * board (a 2nd+ board should start blank; the whole point of multiple boards
 * is that each curates its own subset of pages), but it would REGRESS the
 * board a Studio user is already using: before per-board frame membership
 * existed, that board's (empty) `frames` meant "show every page", so today
 * it's showing every page with no saved frames at all.
 *
 * Fix: the very first time the sole/default board is seen with zero frames
 * (and at least one page exists to seed), populate it with a frame for every
 * current page — reproducing the old "show every page" behavior as a real,
 * persisted `board.frames` list. `boardCount === 1` is the signal that
 * distinguishes this from a deliberately-empty 2nd/3rd board a user just
 * created via `addBoard` — those are never auto-seeded, so they stay
 * intentionally blank until the user adds frames themselves.
 *
 * Refuses while `boardsLoadFailed` is true — regression coverage for
 * `boards-fetch-race-01`: that flag means the CURRENT `boards` state is a
 * synthetic placeholder from a FAILED `.studio/boards.json` fetch, not real
 * (or legitimately-empty) server data. Before this guard existed, a failed
 * fetch was indistinguishable from a legitimately-empty new project — both
 * flowed through `loadBoards`, which marks the resulting single empty board
 * DIRTY. This predicate would then seed that board from whatever
 * `site.pages` held at that moment, and the 800ms auto-save effect
 * (`useStudioBoardsPersistence`) persisted the result — silently overwriting
 * the REAL boards.json (never actually read) with a board derived from
 * in-memory state instead of disk.
 */
export interface StudioDefaultBoardSeedInputs {
  boardsLoaded: boolean
  boardsLoadFailed: boolean
  boardCount: number
  activeBoardFrameCount: number | null
  pageCount: number
  /**
   * Whether the project's `frameDefaults` are known yet (`boardSlice`'s
   * `frameDefaultsSettled` — populated, empty, or failed; "settled", not
   * "non-empty"). The seed hands every frame it creates the project's default
   * size, so running it before that answer arrives silently stamps the whole
   * board with the hardcoded `FRAME_WIDTH`/`FRAME_HEIGHT` — the exact race
   * that would make a project created as Mobile open its first screen at
   * 1024×800. The two fetches are started together and neither orders the
   * other, so this has to be an explicit gate.
   */
  frameDefaultsSettled: boolean
}

export function shouldSeedDefaultBoard(inputs: StudioDefaultBoardSeedInputs): boolean {
  if (!inputs.boardsLoaded) return false
  if (inputs.boardsLoadFailed) return false
  if (inputs.boardCount !== 1) return false
  if (inputs.activeBoardFrameCount !== 0) return false
  if (inputs.pageCount === 0) return false
  if (!inputs.frameDefaultsSettled) return false
  return true
}
