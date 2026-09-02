/**
 * shouldSeedDefaultBoard — regression coverage for `boards-fetch-race-01`.
 *
 * A failed `.studio/boards.json` fetch used to be indistinguishable from a
 * legitimately-empty new project: both flowed through `loadBoards`, which
 * marks the resulting single empty board DIRTY. `useStudioDefaultBoardSeed`
 * (this predicate) then seeded that board from whatever `site.pages` held at
 * that moment, and the 800ms auto-save effect persisted the result —
 * silently overwriting the REAL boards.json (never actually read) with a
 * board derived from in-memory state instead of disk.
 *
 * The fix: a failed fetch now calls `markBoardsLoadFailed()` instead of
 * `loadBoards(createBoardsFile())`, which sets `boardsLoadFailed: true` and
 * leaves `boardsDirty: false`. This predicate must refuse to seed while that
 * flag is set, even when every other condition (a lone board, zero frames,
 * pages already loaded) looks exactly like the legitimate "brand new
 * project" case it exists to handle.
 */
import { describe, it, expect } from 'bun:test'
import { shouldSeedDefaultBoard, type StudioDefaultBoardSeedInputs } from '../studioDefaultBoardSeed'

const BASE: StudioDefaultBoardSeedInputs = {
  boardsLoaded: true,
  boardsLoadFailed: false,
  boardCount: 1,
  activeBoardFrameCount: 0,
  pageCount: 5,
  frameDefaultsSettled: true,
}

describe('shouldSeedDefaultBoard', () => {
  it('seeds a legitimately-empty single board once pages are loaded', () => {
    expect(shouldSeedDefaultBoard(BASE)).toBe(true)
  })

  it('refuses until the project frame defaults are known', () => {
    // The seed stamps every frame it creates with the project's default size.
    // Running before that answer arrives silently seeds the whole board at the
    // hardcoded FRAME_WIDTH/FRAME_HEIGHT — which is what would make a project
    // created as Mobile open its first screen at 1024x800.
    expect(shouldSeedDefaultBoard({ ...BASE, frameDefaultsSettled: false })).toBe(false)
  })

  it('refuses when boardsLoadFailed is true — the boards-fetch-race-01 regression', () => {
    expect(shouldSeedDefaultBoard({ ...BASE, boardsLoadFailed: true })).toBe(false)
  })

  it('refuses before boards have loaded', () => {
    expect(shouldSeedDefaultBoard({ ...BASE, boardsLoaded: false })).toBe(false)
  })

  it('refuses a deliberately-empty 2nd/3rd board (boardCount !== 1)', () => {
    expect(shouldSeedDefaultBoard({ ...BASE, boardCount: 2 })).toBe(false)
  })

  it('refuses once the active board already has frames', () => {
    expect(shouldSeedDefaultBoard({ ...BASE, activeBoardFrameCount: 3 })).toBe(false)
  })

  it('refuses with no pages to seed from', () => {
    expect(shouldSeedDefaultBoard({ ...BASE, pageCount: 0 })).toBe(false)
  })
})
