/**
 * boardSlice — unit tests
 *
 * Verifies the studio-mode board slice (sticky notes + page frames):
 *   - loadBoards creates a default board (and marks dirty) for an empty file
 *   - loadBoards sets the active board to the first board in a non-empty file
 *   - addNote / moveNote / updateNoteText / setNoteColor / removeNote mutate
 *     the active board via the pure @core/studio-board transforms and flip
 *     boardsDirty
 *   - setFramePosition / removeFrame do the same for `board.frames`
 *   - markBoardsClean clears the dirty flag
 *   - selectActiveBoard resolves the right board (or null)
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { createBoard, createBoardsFile, type BoardsFile } from '@core/studio-board'

beforeEach(() => {
  useEditorStore.setState({
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
  })
})

function state() {
  return useEditorStore.getState()
}

// ---------------------------------------------------------------------------
// loadBoards
// ---------------------------------------------------------------------------

describe('loadBoards', () => {
  it('creates a default board and marks dirty for an empty file', () => {
    state().loadBoards(createBoardsFile())

    const s = state()
    expect(s.boardsLoaded).toBe(true)
    expect(s.boardsDirty).toBe(true)
    expect(s.boards.boards).toHaveLength(1)
    expect(s.boards.boards[0].name).toBe('Board 1')
    expect(s.activeBoardId).toBe(s.boards.boards[0].id)
  })

  it('sets the active board to the first board in a non-empty file', () => {
    const boardA = createBoard('board-a', 'Board A')
    const boardB = createBoard('board-b', 'Board B')
    const file: BoardsFile = { version: 1, boards: [boardA, boardB] }

    state().loadBoards(file)

    const s = state()
    expect(s.boardsLoaded).toBe(true)
    expect(s.boardsDirty).toBe(false)
    expect(s.activeBoardId).toBe('board-a')
    expect(s.boards.boards).toEqual([boardA, boardB])
  })
})

// ---------------------------------------------------------------------------
// addNote
// ---------------------------------------------------------------------------

describe('addNote', () => {
  it('adds a note to the active board and marks dirty', () => {
    state().loadBoards(createBoardsFile())
    state().addNote(100, 200)

    const board = selectActiveBoard(state())
    expect(board).not.toBeNull()
    expect(board?.notes).toHaveLength(1)
    const note = board?.notes[0]
    expect(note?.x).toBe(100)
    expect(note?.y).toBe(200)
    expect(note?.w).toBe(180)
    expect(note?.h).toBe(120)
    expect(note?.text).toBe('')
    expect(note?.color).toBe('yellow')
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().addNote(0, 0)
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// moveNote / updateNoteText / setNoteColor / removeNote
// ---------------------------------------------------------------------------

describe('moveNote', () => {
  it('updates a note\'s coordinates', () => {
    state().loadBoards(createBoardsFile())
    state().addNote(0, 0)
    const noteId = selectActiveBoard(state())!.notes[0].id
    state().markBoardsClean()

    state().moveNote(noteId, 42, 84)

    const note = selectActiveBoard(state())!.notes[0]
    expect(note.x).toBe(42)
    expect(note.y).toBe(84)
    expect(state().boardsDirty).toBe(true)
  })
})

describe('updateNoteText', () => {
  it('updates a note\'s text', () => {
    state().loadBoards(createBoardsFile())
    state().addNote(0, 0)
    const noteId = selectActiveBoard(state())!.notes[0].id
    state().markBoardsClean()

    state().updateNoteText(noteId, 'hello board')

    expect(selectActiveBoard(state())!.notes[0].text).toBe('hello board')
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op for an unknown note id', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().updateNoteText('missing', 'nope')

    expect(selectActiveBoard(state())!.notes).toHaveLength(0)
    expect(state().boardsDirty).toBe(false)
  })
})

describe('setNoteColor', () => {
  it('updates a note\'s color', () => {
    state().loadBoards(createBoardsFile())
    state().addNote(0, 0)
    const noteId = selectActiveBoard(state())!.notes[0].id
    state().markBoardsClean()

    state().setNoteColor(noteId, 'pink')

    expect(selectActiveBoard(state())!.notes[0].color).toBe('pink')
    expect(state().boardsDirty).toBe(true)
  })
})

describe('removeNote', () => {
  it('removes a note from the active board', () => {
    state().loadBoards(createBoardsFile())
    state().addNote(0, 0)
    const noteId = selectActiveBoard(state())!.notes[0].id
    state().markBoardsClean()

    state().removeNote(noteId)

    expect(selectActiveBoard(state())!.notes).toHaveLength(0)
    expect(state().boardsDirty).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setFramePosition / removeFrame
// ---------------------------------------------------------------------------

describe('setFramePosition', () => {
  it('inserts a new frame position on the active board and marks dirty', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().setFramePosition('home', 100, 200)

    const board = selectActiveBoard(state())
    expect(board?.frames).toHaveLength(1)
    expect(board?.frames[0]).toEqual({ pageId: 'home', x: 100, y: 200 })
    expect(state().boardsDirty).toBe(true)
  })

  it('updates an existing frame position instead of duplicating it', () => {
    state().loadBoards(createBoardsFile())
    state().setFramePosition('home', 100, 200)
    state().markBoardsClean()

    state().setFramePosition('home', 42, 84)

    const board = selectActiveBoard(state())
    expect(board?.frames).toHaveLength(1)
    expect(board?.frames[0]).toEqual({ pageId: 'home', x: 42, y: 84 })
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().setFramePosition('home', 0, 0)
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

describe('removeFrame', () => {
  it('removes a page\'s frame position from the active board', () => {
    state().loadBoards(createBoardsFile())
    state().setFramePosition('home', 100, 200)
    state().markBoardsClean()

    state().removeFrame('home')

    expect(selectActiveBoard(state())?.frames).toHaveLength(0)
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().removeFrame('home')
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// markBoardsClean
// ---------------------------------------------------------------------------

describe('markBoardsClean', () => {
  it('clears the dirty flag', () => {
    state().loadBoards(createBoardsFile())
    expect(state().boardsDirty).toBe(true)

    state().markBoardsClean()

    expect(state().boardsDirty).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// selectActiveBoard
// ---------------------------------------------------------------------------

describe('selectActiveBoard', () => {
  it('returns null when there is no active board', () => {
    expect(selectActiveBoard(state())).toBeNull()
  })

  it('returns the board matching activeBoardId', () => {
    const boardA = createBoard('board-a', 'Board A')
    const boardB = createBoard('board-b', 'Board B')
    useEditorStore.setState({
      boards: { version: 1, boards: [boardA, boardB] },
      activeBoardId: 'board-b',
    })

    expect(selectActiveBoard(state())).toEqual(boardB)
  })
})
