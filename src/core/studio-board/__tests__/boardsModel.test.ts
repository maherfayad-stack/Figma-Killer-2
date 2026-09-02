import { describe, expect, test } from 'bun:test'
import {
  createBoard,
  createBoardsFile,
  duplicateFrame,
  moveDoc,
  moveFrame,
  moveGuide,
  moveNote,
  parseBoardsFile,
  removeBoard,
  removeDoc,
  removeFrame,
  removeFramesForPage,
  removeGuide,
  removeNote,
  renameBoard,
  resizeFrame,
  serializeBoardsFile,
  setFrameAxes,
  upsertBoard,
  upsertDoc,
  upsertFrame,
  upsertGuide,
  upsertNote,
} from '../index'
import type { Board, BoardFrame, BoardGuide, BoardsFile, DocBlock, StickyNote } from '../types'

describe('create helpers', () => {
  test('createBoardsFile returns empty file', () => {
    expect(createBoardsFile()).toEqual({ version: 1, boards: [] })
  })

  test('createBoard returns empty board', () => {
    expect(createBoard('b1', 'My Board')).toEqual({
      id: 'b1',
      name: 'My Board',
      frames: [],
      notes: [],
      docs: [],
      guides: [],
    })
  })
})

describe('upsertBoard', () => {
  test('adds a new board', () => {
    const file = createBoardsFile()
    const board = createBoard('b1', 'Board 1')
    const result = upsertBoard(file, board)
    expect(result.boards).toEqual([board])
  })

  test('replaces a board with the same id', () => {
    const file = upsertBoard(createBoardsFile(), createBoard('b1', 'Old Name'))
    const replacement = createBoard('b1', 'New Name')
    const result = upsertBoard(file, replacement)
    expect(result.boards).toEqual([replacement])
    expect(result.boards).toHaveLength(1)
  })

  test('does not mutate the input file', () => {
    const file = createBoardsFile()
    const originalSnapshot = JSON.parse(JSON.stringify(file))
    upsertBoard(file, createBoard('b1', 'Board 1'))
    expect(file).toEqual(originalSnapshot)
    expect(file.boards).toHaveLength(0)
  })
})

describe('removeBoard', () => {
  test('drops the board with the given id', () => {
    const file = upsertBoard(createBoardsFile(), createBoard('b1', 'Board 1'))
    const result = removeBoard(file, 'b1')
    expect(result.boards).toEqual([])
  })

  test('is a no-op for a missing id', () => {
    const file = upsertBoard(createBoardsFile(), createBoard('b1', 'Board 1'))
    const result = removeBoard(file, 'does-not-exist')
    expect(result.boards).toEqual(file.boards)
  })

  test('does not mutate the input file', () => {
    const file = upsertBoard(createBoardsFile(), createBoard('b1', 'Board 1'))
    const originalBoardsRef = file.boards
    removeBoard(file, 'b1')
    expect(file.boards).toBe(originalBoardsRef)
    expect(file.boards).toHaveLength(1)
  })
})

describe('renameBoard', () => {
  test('returns a board with the new name', () => {
    const board = createBoard('b1', 'Old Name')
    const result = renameBoard(board, 'New Name')
    expect(result).toEqual({ id: 'b1', name: 'New Name', frames: [], notes: [], docs: [], guides: [] })
  })

  test('does not mutate the input board', () => {
    const board = createBoard('b1', 'Old Name')
    renameBoard(board, 'New Name')
    expect(board.name).toBe('Old Name')
  })

  test('preserves frames and notes', () => {
    let board = createBoard('b1', 'Old Name')
    board = upsertFrame(board, { pageId: 'p1', x: 1, y: 2 })
    const result = renameBoard(board, 'New Name')
    expect(result.frames).toEqual(board.frames)
    expect(result.name).toBe('New Name')
  })
})

const note = (overrides: Partial<StickyNote> = {}): StickyNote => ({
  id: 'n1',
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  text: 'hello',
  color: 'yellow',
  ...overrides,
})

describe('upsertNote', () => {
  test('adds a new note', () => {
    const board = createBoard('b1', 'Board 1')
    const result = upsertNote(board, note())
    expect(result.notes).toEqual([note()])
  })

  test('replaces a note with the same id', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const replacement = note({ text: 'updated', color: 'blue' })
    const result = upsertNote(board, replacement)
    expect(result.notes).toEqual([replacement])
    expect(result.notes).toHaveLength(1)
  })

  test('does not mutate the input board', () => {
    const board = createBoard('b1', 'Board 1')
    const originalNotesRef = board.notes
    upsertNote(board, note())
    expect(board.notes).toBe(originalNotesRef)
    expect(board.notes).toHaveLength(0)
  })
})

describe('moveNote', () => {
  test('updates coordinates', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const result = moveNote(board, 'n1', 42, 99)
    expect(result.notes[0]).toEqual(note({ x: 42, y: 99 }))
  })

  test('is a no-op for a missing id', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const result = moveNote(board, 'missing', 42, 99)
    expect(result).toBe(board)
  })

  test('does not mutate the input board', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const snapshot = JSON.parse(JSON.stringify(board))
    moveNote(board, 'n1', 42, 99)
    expect(board).toEqual(snapshot)
  })
})

describe('removeNote', () => {
  test('drops the note with the given id', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const result = removeNote(board, 'n1')
    expect(result.notes).toEqual([])
  })

  test('is a no-op for a missing id', () => {
    const board = upsertNote(createBoard('b1', 'Board 1'), note())
    const result = removeNote(board, 'missing')
    expect(result.notes).toEqual(board.notes)
  })
})

const doc = (overrides: Partial<DocBlock> = {}): DocBlock => ({
  id: 'd1',
  x: 0,
  y: 0,
  w: 320,
  h: 200,
  html: '<h1>hello</h1>',
  ...overrides,
})

describe('upsertDoc', () => {
  test('adds a new doc', () => {
    const board = createBoard('b1', 'Board 1')
    const result = upsertDoc(board, doc())
    expect(result.docs).toEqual([doc()])
  })

  test('replaces a doc with the same id', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const replacement = doc({ html: '<p>updated</p>' })
    const result = upsertDoc(board, replacement)
    expect(result.docs).toEqual([replacement])
    expect(result.docs).toHaveLength(1)
  })

  test('does not mutate the input board', () => {
    const board = createBoard('b1', 'Board 1')
    const originalDocsRef = board.docs
    upsertDoc(board, doc())
    expect(board.docs).toBe(originalDocsRef)
    expect(board.docs).toHaveLength(0)
  })
})

describe('moveDoc', () => {
  test('updates coordinates', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const result = moveDoc(board, 'd1', 42, 99)
    expect(result.docs[0]).toEqual(doc({ x: 42, y: 99 }))
  })

  test('is a no-op for a missing id', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const result = moveDoc(board, 'missing', 42, 99)
    expect(result).toBe(board)
  })

  test('does not mutate the input board', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const snapshot = JSON.parse(JSON.stringify(board))
    moveDoc(board, 'd1', 42, 99)
    expect(board).toEqual(snapshot)
  })
})

describe('removeDoc', () => {
  test('drops the doc with the given id', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const result = removeDoc(board, 'd1')
    expect(result.docs).toEqual([])
  })

  test('is a no-op for a missing id', () => {
    const board = upsertDoc(createBoard('b1', 'Board 1'), doc())
    const result = removeDoc(board, 'missing')
    expect(result.docs).toEqual(board.docs)
  })
})

// WS-10 Phase 2 — `id` defaults to `pageId` here purely because that's a
// convenient, readable default for single-frame-per-page fixtures (and
// matches what `serialize.ts`'s `coerceFrame` synthesizes for legacy data).
// The "frames keyed by id, not pageId" block below exercises the case where
// they DIVERGE — two frames, same pageId, different id — since a fixture
// where they always match can't actually prove id-keying over pageId-keying.
const frame = (overrides: Partial<BoardFrame> = {}): BoardFrame => ({
  id: 'p1',
  pageId: 'p1',
  x: 0,
  y: 0,
  ...overrides,
})

describe('upsertFrame', () => {
  test('adds a new frame', () => {
    const board = createBoard('b1', 'Board 1')
    const result = upsertFrame(board, frame())
    expect(result.frames).toEqual([frame()])
  })

  test('replaces a frame keyed by id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const replacement = frame({ x: 10, y: 20 })
    const result = upsertFrame(board, replacement)
    expect(result.frames).toEqual([replacement])
    expect(result.frames).toHaveLength(1)
  })

  test('does not mutate the input board', () => {
    const board = createBoard('b1', 'Board 1')
    const originalFramesRef = board.frames
    upsertFrame(board, frame())
    expect(board.frames).toBe(originalFramesRef)
    expect(board.frames).toHaveLength(0)
  })

  test('merges a partial update, preserving unmentioned fields (width/height)', () => {
    // Regression: a resized frame kept its size, then a position-only update
    // (setFramePosition passes just { id, pageId, x, y }) dropped
    // width/height, snapping the frame back to the render default on the
    // next drag.
    const sized = upsertFrame(createBoard('b1', 'Board 1'), frame({ width: 393, height: 852 }))
    const moved = upsertFrame(sized, { id: 'p1', pageId: 'p1', x: 40, y: 60 })
    expect(moved.frames[0]).toEqual({ id: 'p1', pageId: 'p1', x: 40, y: 60, width: 393, height: 852 })
  })
})

describe('moveFrame', () => {
  test('updates coordinates', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = moveFrame(board, 'p1', 5, 7)
    expect(result.frames[0]).toEqual(frame({ x: 5, y: 7 }))
  })

  test('is a no-op for a missing id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = moveFrame(board, 'missing', 5, 7)
    expect(result).toBe(board)
  })
})

describe('removeFrame (id-keyed, single frame)', () => {
  test('drops the frame with the given id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = removeFrame(board, 'p1')
    expect(result.frames).toEqual([])
  })

  test('is a no-op for a missing id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = removeFrame(board, 'missing')
    expect(result.frames).toEqual(board.frames)
  })

  test('removing one variant frame never touches its sibling of the same page', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ id: 'frame-source' }))
    board = upsertFrame(board, frame({ id: 'frame-variant', x: 600 }))
    const result = removeFrame(board, 'frame-variant')
    expect(result.frames).toEqual([frame({ id: 'frame-source' })])
  })
})

describe('removeFramesForPage', () => {
  test('drops every frame of the given page, including duplicated variants', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ id: 'frame-source' }))
    board = upsertFrame(board, frame({ id: 'frame-variant', x: 600 }))
    board = upsertFrame(board, { id: 'other-page', pageId: 'p2', x: 0, y: 0 })
    const result = removeFramesForPage(board, 'p1')
    expect(result.frames).toEqual([{ id: 'other-page', pageId: 'p2', x: 0, y: 0 }])
  })

  test('is a no-op for a missing pageId', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = removeFramesForPage(board, 'missing')
    expect(result.frames).toEqual(board.frames)
  })
})

describe('resizeFrame', () => {
  test('sets width/height on a frame with none yet', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = resizeFrame(board, 'p1', 393, 852)
    expect(result.frames[0]).toEqual(frame({ width: 393, height: 852 }))
  })

  test('overwrites an existing width/height', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ width: 1024, height: 800 }))
    const result = resizeFrame(board, 'p1', 834, 1194)
    expect(result.frames[0]).toEqual(frame({ width: 834, height: 1194 }))
  })

  test('is a no-op for a missing id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = resizeFrame(board, 'missing', 393, 852)
    expect(result).toBe(board)
  })

  test('does not mutate the input board', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const snapshot = JSON.parse(JSON.stringify(board))
    resizeFrame(board, 'p1', 393, 852)
    expect(board).toEqual(snapshot)
  })

  test('leaves x/y untouched', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ x: 10, y: 20 }))
    const result = resizeFrame(board, 'p1', 393, 852)
    expect(result.frames[0]).toEqual({ id: 'p1', pageId: 'p1', x: 10, y: 20, width: 393, height: 852 })
  })

  // `height: undefined` means "hug the content", and hugging is the ABSENCE of
  // the key — `hasManualHeight` in BoardFramesLayer reads `height !== undefined`,
  // and `boards.json` is JSON, so a stored `null` would not round-trip as absent.
  test('an undefined height DELETES the stored one, restoring hug-to-content', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ width: 1024, height: 800 }))
    const result = resizeFrame(board, 'p1', 1024, undefined)
    expect(result.frames[0]).toEqual(frame({ width: 1024 }))
    expect('height' in result.frames[0]).toBe(false)
  })

  test('an undefined height still applies the new width', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ width: 1024, height: 800 }))
    const result = resizeFrame(board, 'p1', 480, undefined)
    expect(result.frames[0]).toEqual(frame({ width: 480 }))
  })

  test('an undefined height on an already-hugging frame leaves it hugging', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = resizeFrame(board, 'p1', 480, undefined)
    expect('height' in result.frames[0]).toBe(false)
  })
})

describe('frames keyed by id, not pageId (WS-10 Phase 2)', () => {
  test('moveFrame moves only the addressed variant, leaving its same-page sibling in place', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ id: 'frame-source' }))
    board = upsertFrame(board, frame({ id: 'frame-variant', x: 600 }))
    const result = moveFrame(board, 'frame-variant', 900, 40)
    expect(result.frames).toEqual([
      frame({ id: 'frame-source' }),
      frame({ id: 'frame-variant', x: 900, y: 40 }),
    ])
  })

  test('resizeFrame resizes only the addressed variant', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ id: 'frame-source' }))
    board = upsertFrame(board, frame({ id: 'frame-variant', x: 600 }))
    const result = resizeFrame(board, 'frame-variant', 393, 852)
    expect(result.frames).toEqual([
      frame({ id: 'frame-source' }),
      frame({ id: 'frame-variant', x: 600, width: 393, height: 852 }),
    ])
  })
})

describe('setFrameAxes', () => {
  test('sets an axes override on the addressed frame', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = setFrameAxes(board, 'p1', { direction: 'rtl' })
    expect(result.frames[0]).toEqual(frame({ axes: { direction: 'rtl' } }))
  })

  test('clearing (undefined) drops the axes field entirely rather than setting it to undefined', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ axes: { direction: 'rtl' } }))
    const result = setFrameAxes(board, 'p1', undefined)
    expect(result.frames[0]).toEqual(frame())
    expect('axes' in result.frames[0]).toBe(false)
  })

  test('only touches the addressed frame, not a same-page sibling', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ id: 'frame-source' }))
    board = upsertFrame(board, frame({ id: 'frame-variant', x: 600 }))
    const result = setFrameAxes(board, 'frame-variant', { colorScheme: 'dark' })
    expect(result.frames).toEqual([
      frame({ id: 'frame-source' }),
      frame({ id: 'frame-variant', x: 600, axes: { colorScheme: 'dark' } }),
    ])
  })

  test('is a no-op for a missing id', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = setFrameAxes(board, 'missing', { direction: 'rtl' })
    expect(result).toBe(board)
  })
})

describe('duplicateFrame', () => {
  test('adds a new frame of the same page, at the given position, carrying the given axes', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ id: 'frame-source', width: 393, height: 852 }))
    const result = duplicateFrame(board, 'frame-source', {
      id: 'frame-variant',
      x: 900,
      y: 0,
      axes: { direction: 'rtl' },
    })
    expect(result).not.toBeNull()
    expect(result!.frames).toEqual([
      frame({ id: 'frame-source', width: 393, height: 852 }),
      frame({ id: 'frame-variant', x: 900, y: 0, width: 393, height: 852, axes: { direction: 'rtl' } }),
    ])
  })

  test('never mutates the source frame', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ id: 'frame-source' }))
    duplicateFrame(board, 'frame-source', { id: 'frame-variant', x: 900, y: 0, axes: {} })
    expect(board.frames).toEqual([frame({ id: 'frame-source' })])
  })

  test('returns null for a missing sourceFrameId, and never writes to the user\'s source', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame({ id: 'frame-source' }))
    const result = duplicateFrame(board, 'missing', { id: 'frame-variant', x: 0, y: 0, axes: {} })
    expect(result).toBeNull()
  })
})

const guide = (overrides: Partial<BoardGuide> = {}): BoardGuide => ({
  id: 'g1',
  axis: 'x',
  position: 100,
  ...overrides,
})

describe('upsertGuide', () => {
  test('adds a new guide', () => {
    const board = createBoard('b1', 'Board 1')
    const result = upsertGuide(board, guide())
    expect(result.guides).toEqual([guide()])
  })

  test('replaces a guide with the same id', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const replacement = guide({ position: 250 })
    const result = upsertGuide(board, replacement)
    expect(result.guides).toEqual([replacement])
    expect(result.guides).toHaveLength(1)
  })

  test('does not mutate the input board', () => {
    const board = createBoard('b1', 'Board 1')
    const originalGuidesRef = board.guides
    upsertGuide(board, guide())
    expect(board.guides).toBe(originalGuidesRef)
    expect(board.guides).toHaveLength(0)
  })
})

describe('moveGuide', () => {
  test('updates the position', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const result = moveGuide(board, 'g1', 320)
    expect(result.guides![0]).toEqual(guide({ position: 320 }))
  })

  test('is a no-op for a missing id', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const result = moveGuide(board, 'missing', 320)
    expect(result).toBe(board)
  })

  test('does not mutate the input board', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const snapshot = JSON.parse(JSON.stringify(board))
    moveGuide(board, 'g1', 320)
    expect(board).toEqual(snapshot)
  })
})

describe('removeGuide', () => {
  test('drops the guide with the given id', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const result = removeGuide(board, 'g1')
    expect(result.guides).toEqual([])
  })

  test('is a no-op for a missing id', () => {
    const board = upsertGuide(createBoard('b1', 'Board 1'), guide())
    const result = removeGuide(board, 'missing')
    expect(result.guides).toEqual(board.guides)
  })
})

describe('serialize round-trip', () => {
  test('parseBoardsFile(serializeBoardsFile(f)) deep-equals f', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ pageId: 'home', x: 100, y: 200 }))
    board = upsertNote(board, note({ id: 'n1', text: 'note text', color: 'pink' }))
    board = upsertDoc(board, doc({ id: 'd1', html: '<h1>doc text</h1>' }))
    const file: BoardsFile = upsertBoard(createBoardsFile(), board)

    const serialized = serializeBoardsFile(file)
    expect(serialized.endsWith('\n')).toBe(true)

    const parsed = parseBoardsFile(serialized)
    expect(parsed).toEqual(file)
  })

  test('serializeBoardsFile produces pretty JSON', () => {
    const file = createBoardsFile()
    const serialized = serializeBoardsFile(file)
    expect(serialized).toBe(`${JSON.stringify(file, null, 2)}\n`)
  })
})

describe('parseBoardsFile tolerance', () => {
  test('garbage string returns empty boards file', () => {
    expect(parseBoardsFile('not json')).toEqual({ version: 1, boards: [] })
  })

  test('null returns empty boards file', () => {
    expect(parseBoardsFile(null)).toEqual({ version: 1, boards: [] })
  })

  test('undefined returns empty boards file', () => {
    expect(parseBoardsFile(undefined)).toEqual({ version: 1, boards: [] })
  })

  test('a bare number/array returns empty boards file', () => {
    expect(parseBoardsFile(42)).toEqual({ version: 1, boards: [] })
    expect(parseBoardsFile([1, 2, 3])).toEqual({ version: 1, boards: [] })
  })

  test('object with malformed boards drops the bad entries', () => {
    const raw = {
      version: 1,
      boards: [
        { id: 'good', name: 'Good Board', frames: [], notes: [] },
        { name: 'missing id' }, // malformed: no id -> dropped
        'not an object', // malformed -> dropped
        null, // malformed -> dropped
        {
          id: 'partial',
          name: 'Partial Board',
          frames: [
            { pageId: 'p1', x: 1, y: 2 },
            { pageId: 'p1' }, // duplicate pageId still coerced with defaults
            { x: 1, y: 2 }, // missing pageId -> dropped
            'garbage', // -> dropped
          ],
          notes: [
            { id: 'n1' }, // coerced to defaults
            { id: 'n2', color: 'not-a-color', w: 'nope' }, // invalid color/w coerced to defaults
            {}, // missing id -> dropped
          ],
          docs: [
            { id: 'd1' }, // coerced to defaults
            { id: 'd2', w: 'nope', html: 123 }, // invalid w/html coerced to defaults
            {}, // missing id -> dropped
          ],
        },
      ],
    }

    const result = parseBoardsFile(raw)
    expect(result.version).toBe(1)
    expect(result.boards).toHaveLength(2)

    const good = result.boards.find((b) => b.id === 'good')
    expect(good).toEqual({ id: 'good', name: 'Good Board', frames: [], notes: [], docs: [], guides: [] })

    const partial = result.boards.find((b) => b.id === 'partial') as Board
    expect(partial.frames).toEqual([
      { id: 'p1', pageId: 'p1', x: 1, y: 2 },
      { id: 'p1', pageId: 'p1', x: 0, y: 0 },
    ])
    expect(partial.notes).toEqual([
      { id: 'n1', x: 0, y: 0, w: 200, h: 120, text: '', color: 'yellow' },
      { id: 'n2', x: 0, y: 0, w: 200, h: 120, text: '', color: 'yellow' },
    ])
    expect(partial.docs).toEqual([
      { id: 'd1', x: 0, y: 0, w: 320, h: 200, html: '' },
      { id: 'd2', x: 0, y: 0, w: 320, h: 200, html: '' },
    ])
  })

  test('board missing the docs key entirely (pre-existing boards.json) parses with an empty docs list', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'legacy', name: 'Legacy Board', frames: [], notes: [] }],
    }

    const result = parseBoardsFile(raw)
    expect(result.boards).toEqual([
      { id: 'legacy', name: 'Legacy Board', frames: [], notes: [], docs: [], guides: [] },
    ])
  })

  test('a board with a malformed (non-array) docs field parses with an empty docs list', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'b1', name: 'Board 1', frames: [], notes: [], docs: 'not-an-array' }],
    }

    const result = parseBoardsFile(raw)
    expect(result.boards[0].docs).toEqual([])
  })

  test('an object with boards not an array returns empty boards file', () => {
    expect(parseBoardsFile({ version: 1, boards: 'nope' })).toEqual({
      version: 1,
      boards: [],
    })
  })

  test('accepts an already-parsed object (not just a string)', () => {
    const file: BoardsFile = { version: 1, boards: [createBoard('b1', 'Board 1')] }
    expect(parseBoardsFile(file)).toEqual(file)
  })
})

describe('parseBoardsFile — frame width/height (Phase 6E)', () => {
  test('a frame missing width/height parses with neither key present (falls back to FRAME_WIDTH/HEIGHT at render time)', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'legacy', name: 'Legacy Board', frames: [{ pageId: 'p1', x: 0, y: 0 }], notes: [], docs: [] }],
    }
    const result = parseBoardsFile(raw)
    const parsedFrame = result.boards[0].frames[0]
    expect(parsedFrame).toEqual({ id: 'p1', pageId: 'p1', x: 0, y: 0 })
    expect('width' in parsedFrame).toBe(false)
    expect('height' in parsedFrame).toBe(false)
  })

  test('a frame with a valid width/height keeps them', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [{ pageId: 'p1', x: 0, y: 0, width: 393, height: 852 }],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0]).toEqual({ id: 'p1', pageId: 'p1', x: 0, y: 0, width: 393, height: 852 })
  })

  test('a zero, negative, or non-numeric width/height is dropped (not coerced to a default)', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [
            { pageId: 'p1', x: 0, y: 0, width: 0, height: 852 },
            { pageId: 'p2', x: 0, y: 0, width: -100, height: 852 },
            { pageId: 'p3', x: 0, y: 0, width: 'nope', height: 852 },
          ],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    for (const frame of result.boards[0].frames) {
      expect('width' in frame).toBe(false)
      expect(frame.height).toBe(852)
    }
  })

  test('serialize round-trip preserves width/height', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ pageId: 'home', width: 393, height: 852 }))
    const file: BoardsFile = upsertBoard(createBoardsFile(), board)
    const parsed = parseBoardsFile(serializeBoardsFile(file))
    expect(parsed).toEqual(file)
  })
})

describe('parseBoardsFile — frame id/axes (WS-10 Phase 2)', () => {
  // The back-compat contract the coordinator asked to have verified: every
  // frame in a pre-Phase-2 `boards.json` (real example:
  // `studio-workspace/maherfayad-stack-eSIM/.studio/boards.json`, 15 frames,
  // zero `id` fields) has no `id`. `coerceFrame` must synthesize one instead
  // of dropping the frame or throwing — a frame is the largest thing on a
  // board a user can lose.
  test('a frame with no id is synthesized from pageId (legacy boards.json)', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'legacy', name: 'Legacy Board', frames: [{ pageId: 'home', x: 0, y: 0 }], notes: [], docs: [] }],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0]).toEqual({ id: 'home', pageId: 'home', x: 0, y: 0 })
  })

  test('an explicit id is preserved as-is, even when it differs from pageId (a duplicated variant)', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [{ id: 'frame-variant', pageId: 'home', x: 900, y: 0 }],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0]).toEqual({ id: 'frame-variant', pageId: 'home', x: 900, y: 0 })
  })

  test('an empty-string id is treated as absent and synthesized from pageId', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'b1', name: 'Board 1', frames: [{ id: '', pageId: 'home', x: 0, y: 0 }], notes: [], docs: [] }],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0].id).toBe('home')
  })

  test('two frames of the same page keep DISTINCT ids when both are explicit', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [
            { id: 'frame-source', pageId: 'home', x: 0, y: 0 },
            { id: 'frame-variant', pageId: 'home', x: 900, y: 0, axes: { direction: 'rtl' } },
          ],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames).toEqual([
      { id: 'frame-source', pageId: 'home', x: 0, y: 0 },
      { id: 'frame-variant', pageId: 'home', x: 900, y: 0, axes: { direction: 'rtl' } },
    ])
  })

  test('a valid axes override (direction and/or colorScheme) is kept', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0, axes: { direction: 'rtl', colorScheme: 'dark' } }],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0].axes).toEqual({ direction: 'rtl', colorScheme: 'dark' })
  })

  test('a frame with no axes key parses with no axes field at all (not axes: undefined)', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'b1', name: 'Board 1', frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0 }], notes: [], docs: [] }],
    }
    const result = parseBoardsFile(raw)
    expect('axes' in result.boards[0].frames[0]).toBe(false)
  })

  test('an invalid axes value (bad direction/colorScheme, or a non-object) is dropped entirely', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [
            { id: 'f1', pageId: 'home', x: 0, y: 0, axes: { direction: 'sideways' } },
            { id: 'f2', pageId: 'home', x: 0, y: 0, axes: 'not-an-object' },
          ],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect('axes' in result.boards[0].frames[0]).toBe(false)
    expect('axes' in result.boards[0].frames[1]).toBe(false)
  })

  // WS-10 §4.4 (Phase 4) — a per-frame `axes.locale` override now round-trips
  // like `direction`/`colorScheme`. (Was: "silently ignored, not rejected" —
  // that was Phase 2/3's honest placeholder for a mechanism that didn't
  // exist yet; Phase 4 built it, so ignoring it here would now be a bug.)
  test('a locale field on axes is kept, alongside direction/colorScheme', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0, axes: { direction: 'rtl', locale: 'ar' } }],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].frames[0].axes).toEqual({ direction: 'rtl', locale: 'ar' })
  })

  test('an empty-string locale on axes is dropped, same as an invalid direction/colorScheme', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [{ id: 'f1', pageId: 'home', x: 0, y: 0, axes: { locale: '' } }],
          notes: [],
          docs: [],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect('axes' in result.boards[0].frames[0]).toBe(false)
  })

  test('serialize round-trip preserves a per-frame axes override', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, { id: 'f1', pageId: 'home', x: 0, y: 0, axes: { direction: 'rtl' } })
    const file: BoardsFile = upsertBoard(createBoardsFile(), board)
    const parsed = parseBoardsFile(serializeBoardsFile(file))
    expect(parsed).toEqual(file)
  })
})

describe('parseBoardsFile — guides (D1)', () => {
  test('a board missing the guides key entirely (pre-D1 boards.json) parses with an empty guides list', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'legacy', name: 'Legacy Board', frames: [], notes: [], docs: [] }],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].guides).toEqual([])
  })

  test('a board with a malformed (non-array) guides field parses with an empty guides list', () => {
    const raw = {
      version: 1,
      boards: [{ id: 'b1', name: 'Board 1', frames: [], notes: [], docs: [], guides: 'not-an-array' }],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].guides).toEqual([])
  })

  test('a valid guide is kept', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [],
          notes: [],
          docs: [],
          guides: [{ id: 'g1', axis: 'y', position: -40 }],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].guides).toEqual([{ id: 'g1', axis: 'y', position: -40 }])
  })

  test('a guide with an invalid axis, missing/non-finite position, or missing id is dropped', () => {
    const raw = {
      version: 1,
      boards: [
        {
          id: 'b1',
          name: 'Board 1',
          frames: [],
          notes: [],
          docs: [],
          guides: [
            { id: 'g1', axis: 'diagonal', position: 10 }, // invalid axis
            { id: 'g2', axis: 'x', position: 'nope' }, // non-numeric position
            { id: 'g3', axis: 'x', position: Number.NaN }, // non-finite position
            { axis: 'x', position: 10 }, // missing id
            'garbage', // not an object
          ],
        },
      ],
    }
    const result = parseBoardsFile(raw)
    expect(result.boards[0].guides).toEqual([])
  })

  test('serialize round-trip preserves guides', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertGuide(board, guide({ id: 'g1', axis: 'x', position: 640 }))
    board = upsertGuide(board, guide({ id: 'g2', axis: 'y', position: -80 }))
    const file: BoardsFile = upsertBoard(createBoardsFile(), board)
    const parsed = parseBoardsFile(serializeBoardsFile(file))
    expect(parsed).toEqual(file)
  })
})
