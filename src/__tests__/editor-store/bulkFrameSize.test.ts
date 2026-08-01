/**
 * boardSlice — WS-7.1/7.2 bulk frame selection + bulk frame actions.
 *
 * Covers:
 *   - selectFrame (replace/toggle) + selectAllFrames + setSelectedFrameIds +
 *     clearFrameSelection, including mutual exclusivity with node selection
 *   - setSelectedFramesSize with MIXED width/height values across the
 *     selection, and the `null` "leave this dimension alone" contract
 *   - applyWidthToAllFrames — the literal "apply to all pages" ask: every
 *     frame on the board (not just the selection) gets the new width, each
 *     frame's own height survives, and the local `frameDefaults` mirror updates
 *   - setFrameHeights (the "fit height to content" primitive)
 *   - alignSelectedFrames / distributeSelectedFrames / tidySelectedFrames
 *   - round-trip through `parseBoardsFile`/`serializeBoardsFile` — every
 *     bulk-written width/height survives a save → parse cycle byte-faithfully
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import {
  createBoard,
  createBoardsFile,
  parseBoardsFile,
  serializeBoardsFile,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  type BoardsFile,
} from '@core/studio-board'

function resetBoardState() {
  useEditorStore.setState({
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    boardSnapGuides: [],
    selectedFrameIds: [],
    frameDefaults: {},
    selectedNodeIds: [],
    selectedNodeId: null,
  })
}

beforeEach(resetBoardState)
// `useEditorStore` is a process-wide singleton shared across test files — see
// boardSlice.test.ts's module doc for why this matters.
afterAll(resetBoardState)

function state() {
  return useEditorStore.getState()
}

/**
 * Load a board with N frames at (i*500, 0), widths/heights as given.
 * WS-10 Phase 2 — `id` defaults to `pageId`, mirroring `coerceFrame`'s own
 * synthesis for a pre-Phase-2 shape (every fixture here has exactly one
 * frame per page, so `pageId` is a perfectly valid, unique frame id) — every
 * per-frame boardSlice action is now id-keyed, so a fixture without one
 * would make every lookup collide on the first frame.
 */
function loadBoardWithFrames(frames: Array<{ pageId: string; x: number; y: number; width?: number; height?: number; id?: string }>) {
  const board = createBoard('board-1', 'Board 1')
  board.frames = frames.map((f) => ({ id: f.pageId, ...f }))
  const file: BoardsFile = { version: 1, boards: [board] }
  state().loadBoards(file)
}

// ---------------------------------------------------------------------------
// Frame selection (WS-7.1)
// ---------------------------------------------------------------------------

describe('frame selection', () => {
  beforeEach(() => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0 },
      { pageId: 'b', x: 500, y: 0 },
      { pageId: 'c', x: 1000, y: 0 },
    ])
  })

  it('selectFrame replace mode selects exactly one frame', () => {
    state().selectFrame('a')
    expect(state().selectedFrameIds).toEqual(['a'])
    state().selectFrame('b')
    expect(state().selectedFrameIds).toEqual(['b'])
  })

  it('selectFrame toggle mode adds and removes', () => {
    state().selectFrame('a')
    state().selectFrame('b', 'toggle')
    expect(state().selectedFrameIds).toEqual(['a', 'b'])
    state().selectFrame('a', 'toggle')
    expect(state().selectedFrameIds).toEqual(['b'])
  })

  it('selectAllFrames selects every frame on the active board', () => {
    state().selectAllFrames()
    expect(state().selectedFrameIds).toEqual(['a', 'b', 'c'])
  })

  it('clearFrameSelection empties the selection', () => {
    state().selectAllFrames()
    state().clearFrameSelection()
    expect(state().selectedFrameIds).toEqual([])
  })

  it('selecting a frame clears any node selection (mutual exclusivity)', () => {
    useEditorStore.setState({ selectedNodeIds: ['n1'], selectedNodeId: 'n1' })
    state().selectFrame('a')
    expect(state().selectedNodeIds).toEqual([])
    expect(state().selectedNodeId).toBeNull()
  })

  it('setSelectedFrameIds is a no-op when the set is unchanged (empty-to-empty)', () => {
    const before = state().selectedFrameIds
    state().setSelectedFrameIds([])
    expect(state().selectedFrameIds).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// setSelectedFramesSize — mixed-value bulk resize
// ---------------------------------------------------------------------------

describe('setSelectedFramesSize', () => {
  beforeEach(() => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 390, height: 844 },
      { pageId: 'b', x: 500, y: 0, width: 768, height: 1024 },
      { pageId: 'c', x: 1000, y: 0 }, // no saved size — falls back to FRAME_WIDTH/HEIGHT
    ])
  })

  it('sets width and height on every selected frame', () => {
    state().selectAllFrames()
    state().setSelectedFramesSize(400, 900)

    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 400, height: 900 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 400, height: 900 })
    expect(board.frames.find((f) => f.pageId === 'c')).toMatchObject({ width: 400, height: 900 })
  })

  it('a null dimension leaves each frame\'s OWN value alone (mixed-value support)', () => {
    // Selection starts with genuinely mixed widths (390 vs 768) — typing only
    // a height must not collapse that width mix.
    state().setSelectedFrameIds(['a', 'b'])
    state().setSelectedFramesSize(null, 900)

    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 390, height: 900 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 768, height: 900 })
  })

  it('only affects frames in the selection, not the whole board', () => {
    state().setSelectedFrameIds(['a'])
    state().setSelectedFramesSize(500, 500)

    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 500, height: 500 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 768, height: 1024 })
  })

  it('a frame with no saved size resolves the FRAME_WIDTH/HEIGHT default before the null-dimension merge', () => {
    state().setSelectedFrameIds(['c'])
    state().setSelectedFramesSize(600, null)

    const frame = selectActiveBoard(state())!.frames.find((f) => f.pageId === 'c')!
    expect(frame.width).toBe(600)
    expect(frame.height).toBe(FRAME_HEIGHT)
  })

  it('is a no-op with an empty selection', () => {
    const before = state().boardsDirty
    state().setSelectedFramesSize(100, 100)
    expect(state().boardsDirty).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// applyWidthToAllFrames — the literal "apply to all pages" ask
// ---------------------------------------------------------------------------

describe('applyWidthToAllFrames', () => {
  beforeEach(() => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 390, height: 844 },
      { pageId: 'b', x: 500, y: 0, width: 768, height: 1200 },
      { pageId: 'c', x: 1000, y: 0 }, // no saved size
    ])
  })

  it('writes width to EVERY frame on the board, not just the selection', () => {
    // Only 'a' is selected — applyWidthToAllFrames must still touch 'b' and 'c'.
    state().selectFrame('a')
    state().applyWidthToAllFrames(402)

    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')?.width).toBe(402)
    expect(board.frames.find((f) => f.pageId === 'b')?.width).toBe(402)
    expect(board.frames.find((f) => f.pageId === 'c')?.width).toBe(402)
  })

  it("preserves each frame's OWN height", () => {
    state().applyWidthToAllFrames(402)
    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')?.height).toBe(844)
    expect(board.frames.find((f) => f.pageId === 'b')?.height).toBe(1200)
    expect(board.frames.find((f) => f.pageId === 'c')?.height).toBe(FRAME_HEIGHT)
  })

  it('updates the local frameDefaults mirror', () => {
    expect(state().frameDefaults).toEqual({})
    state().applyWidthToAllFrames(402)
    expect(state().frameDefaults).toEqual({ width: 402 })
  })

  it('a later addFrame inherits the applied width (frameDefaults consulted on new frames)', () => {
    state().applyWidthToAllFrames(402)
    state().addFrame('d')
    const frame = selectActiveBoard(state())!.frames.find((f) => f.pageId === 'd')
    expect(frame?.width).toBe(402)
  })
})

// ---------------------------------------------------------------------------
// setFrameHeights — the "fit height to content" primitive
// ---------------------------------------------------------------------------

describe('setFrameHeights', () => {
  beforeEach(() => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 390, height: 844 },
      { pageId: 'b', x: 500, y: 0, width: 390, height: 844 },
    ])
  })

  it('sets each named frame\'s height individually, preserving its own width', () => {
    state().setFrameHeights({ a: 1200, b: 600 })
    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 390, height: 1200 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 390, height: 600 })
  })

  it('ignores a non-finite or non-positive measured height', () => {
    state().setFrameHeights({ a: Number.NaN, b: -10 })
    const board = selectActiveBoard(state())!
    expect(board.frames.find((f) => f.pageId === 'a')?.height).toBe(844)
    expect(board.frames.find((f) => f.pageId === 'b')?.height).toBe(844)
  })
})

// ---------------------------------------------------------------------------
// Align / distribute / tidy
// ---------------------------------------------------------------------------

describe('alignSelectedFrames / distributeSelectedFrames / tidySelectedFrames', () => {
  beforeEach(() => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 200, height: 200 },
      { pageId: 'b', x: 300, y: 50, width: 400, height: 400 },
      { pageId: 'c', x: 900, y: -20, width: 100, height: 100 },
    ])
  })

  it('aligns every selected frame to the shared left edge', () => {
    state().selectAllFrames()
    state().alignSelectedFrames('left')
    const board = selectActiveBoard(state())!
    for (const f of board.frames) expect(f.x).toBe(0)
  })

  it('distributes 3+ selected frames evenly, fixing the two extremes', () => {
    state().selectAllFrames()
    state().distributeSelectedFrames('horizontal')
    const board = selectActiveBoard(state())!
    const a = board.frames.find((f) => f.pageId === 'a')!
    const c = board.frames.find((f) => f.pageId === 'c')!
    // Extremes stay put.
    expect(a.x).toBe(0)
    expect(c.x).toBe(900)
  })

  it('distribute is a no-op below 3 selected frames', () => {
    state().setSelectedFrameIds(['a', 'b'])
    const before = selectActiveBoard(state())!.frames.map((f) => f.x)
    state().distributeSelectedFrames('horizontal')
    const after = selectActiveBoard(state())!.frames.map((f) => f.x)
    expect(after).toEqual(before)
  })

  it('tidySelectedFrames re-lays selected frames into the standard grid, in selection order', () => {
    state().setSelectedFrameIds(['c', 'a'])
    state().tidySelectedFrames()
    const board = selectActiveBoard(state())!
    // First selected id gets grid slot 0, second gets slot 1 — 'b' (not selected) is untouched.
    expect(board.frames.find((f) => f.pageId === 'c')).toMatchObject({ x: 0, y: 0 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ x: 300, y: 50 })
  })
})

// ---------------------------------------------------------------------------
// Round-trip through parseBoardsFile/serializeBoardsFile
// ---------------------------------------------------------------------------

describe('bulk-written frame sizes round-trip through parseBoardsFile', () => {
  it('a bulk resize survives serialize → parse byte-faithfully', () => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 390, height: 844 },
      { pageId: 'b', x: 500, y: 0, width: 768, height: 1024 },
    ])
    state().selectAllFrames()
    state().setSelectedFramesSize(402, 874)

    const serialized = serializeBoardsFile(state().boards)
    const parsed = parseBoardsFile(serialized)

    const board = parsed.boards.find((b) => b.id === 'board-1')!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 402, height: 874 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 402, height: 874 })
  })

  it('applyWidthToAllFrames survives serialize → parse and keeps distinct heights', () => {
    loadBoardWithFrames([
      { pageId: 'a', x: 0, y: 0, width: 390, height: 844 },
      { pageId: 'b', x: 500, y: 0, width: 768, height: 1200 },
    ])
    state().applyWidthToAllFrames(440)

    const parsed = parseBoardsFile(JSON.parse(serializeBoardsFile(state().boards)))
    const board = parsed.boards.find((b) => b.id === 'board-1')!
    expect(board.frames.find((f) => f.pageId === 'a')).toMatchObject({ width: 440, height: 844 })
    expect(board.frames.find((f) => f.pageId === 'b')).toMatchObject({ width: 440, height: 1200 })
  })
})
