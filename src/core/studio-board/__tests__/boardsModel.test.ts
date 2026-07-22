import { describe, expect, test } from 'bun:test'
import {
  createBoard,
  createBoardsFile,
  moveFrame,
  moveNote,
  parseBoardsFile,
  removeBoard,
  removeFrame,
  removeNote,
  serializeBoardsFile,
  upsertBoard,
  upsertFrame,
  upsertNote,
} from '../index'
import type { Board, BoardFrame, BoardsFile, StickyNote } from '../types'

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

const frame = (overrides: Partial<BoardFrame> = {}): BoardFrame => ({
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

  test('replaces a frame keyed by pageId', () => {
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
})

describe('moveFrame', () => {
  test('updates coordinates', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = moveFrame(board, 'p1', 5, 7)
    expect(result.frames[0]).toEqual(frame({ x: 5, y: 7 }))
  })

  test('is a no-op for a missing pageId', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = moveFrame(board, 'missing', 5, 7)
    expect(result).toBe(board)
  })
})

describe('removeFrame', () => {
  test('drops the frame with the given pageId', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = removeFrame(board, 'p1')
    expect(result.frames).toEqual([])
  })

  test('is a no-op for a missing pageId', () => {
    const board = upsertFrame(createBoard('b1', 'Board 1'), frame())
    const result = removeFrame(board, 'missing')
    expect(result.frames).toEqual(board.frames)
  })
})

describe('serialize round-trip', () => {
  test('parseBoardsFile(serializeBoardsFile(f)) deep-equals f', () => {
    let board = createBoard('b1', 'Board 1')
    board = upsertFrame(board, frame({ pageId: 'home', x: 100, y: 200 }))
    board = upsertNote(board, note({ id: 'n1', text: 'note text', color: 'pink' }))
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
        },
      ],
    }

    const result = parseBoardsFile(raw)
    expect(result.version).toBe(1)
    expect(result.boards).toHaveLength(2)

    const good = result.boards.find((b) => b.id === 'good')
    expect(good).toEqual({ id: 'good', name: 'Good Board', frames: [], notes: [] })

    const partial = result.boards.find((b) => b.id === 'partial') as Board
    expect(partial.frames).toEqual([
      { pageId: 'p1', x: 1, y: 2 },
      { pageId: 'p1', x: 0, y: 0 },
    ])
    expect(partial.notes).toEqual([
      { id: 'n1', x: 0, y: 0, w: 200, h: 120, text: '', color: 'yellow' },
      { id: 'n2', x: 0, y: 0, w: 200, h: 120, text: '', color: 'yellow' },
    ])
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
