/**
 * boardSlice — unit tests
 *
 * Verifies the studio-mode board slice (sticky notes + page frames):
 *   - loadBoards creates a default board (and marks dirty) for an empty file
 *   - loadBoards sets the active board to the first board in a non-empty file
 *   - addNote / moveNote / updateNoteText / setNoteColor / removeNote mutate
 *     the active board via the pure @core/studio-board transforms and flip
 *     boardsDirty
 *   - addDoc / moveDoc / updateDocMarkdown / removeDoc do the same for
 *     board.docs (markdown documentation blocks)
 *   - setFramePosition / removeFrame do the same for `board.frames`
 *   - markBoardsClean clears the dirty flag
 *   - selectActiveBoard resolves the right board (or null)
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { createBoard, createBoardsFile, type BoardsFile } from '@core/studio-board'

/** Neutral board state — matches a freshly-created, not-yet-loaded store. */
function resetBoardState() {
  useEditorStore.setState({
    boards: createBoardsFile(),
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    boardSnapGuides: [],
  })
}

beforeEach(resetBoardState)
// `useEditorStore` is a process-wide singleton shared by every test file in
// this run — without this, whatever board state the LAST test in this file
// leaves behind (an active board, saved frames, …) leaks into unrelated
// test files that render `CanvasRoot` (BoardFramesLayer / BoardSwitcher
// self-gate on there being an active board, so a leaked one makes them
// render unexpectedly elsewhere). Restore the neutral state on the way out
// too, not just between tests in this file.
afterAll(resetBoardState)

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

// ---------------------------------------------------------------------------
// addBoard / renameBoard / removeBoard / setActiveBoard
// ---------------------------------------------------------------------------

describe('addBoard', () => {
  it('creates a board, makes it active, with empty frames, and marks dirty', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()
    const firstBoardId = state().activeBoardId

    const newId = state().addBoard('My Flow')

    const s = state()
    expect(newId).not.toBe(firstBoardId)
    expect(s.activeBoardId).toBe(newId)
    expect(s.boardsDirty).toBe(true)
    const board = s.boards.boards.find((b) => b.id === newId)
    expect(board?.name).toBe('My Flow')
    expect(board?.frames).toEqual([])
    expect(board?.notes).toEqual([])
  })

  it('assigns a unique default name when none is given', () => {
    state().loadBoards(createBoardsFile()) // creates "Board 1"

    const idA = state().addBoard()
    const idB = state().addBoard()

    const names = state().boards.boards.map((b) => b.name)
    expect(names).toEqual(['Board 1', 'Board 2', 'Board 3'])
    expect(idA).not.toBe(idB)
  })
})

describe('renameBoard', () => {
  it('renames a board without changing its frames/notes', () => {
    state().loadBoards(createBoardsFile())
    const boardId = state().activeBoardId!
    state().setFramePosition('home', 1, 2)
    state().markBoardsClean()

    state().renameBoard(boardId, 'Checkout flow')

    const board = state().boards.boards.find((b) => b.id === boardId)
    expect(board?.name).toBe('Checkout flow')
    expect(board?.frames).toEqual([{ pageId: 'home', x: 1, y: 2 }])
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op for an unknown board id', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().renameBoard('missing', 'New Name')

    expect(state().boardsDirty).toBe(false)
  })
})

describe('removeBoard', () => {
  it('switches active board to the first remaining board when removing the active one', () => {
    state().loadBoards(createBoardsFile()) // "Board 1"
    const firstId = state().activeBoardId!
    const secondId = state().addBoard('Board 2')
    expect(state().activeBoardId).toBe(secondId)

    state().removeBoard(secondId)

    const s = state()
    expect(s.boards.boards.map((b) => b.id)).toEqual([firstId])
    expect(s.activeBoardId).toBe(firstId)
    expect(s.boardsDirty).toBe(true)
  })

  it('leaves the active board untouched when removing a non-active board', () => {
    state().loadBoards(createBoardsFile())
    const firstId = state().activeBoardId!
    const secondId = state().addBoard('Board 2')
    state().setActiveBoard(firstId)
    state().markBoardsClean()

    state().removeBoard(secondId)

    expect(state().activeBoardId).toBe(firstId)
    expect(state().boards.boards.map((b) => b.id)).toEqual([firstId])
  })

  it('refuses to remove the last remaining board', () => {
    state().loadBoards(createBoardsFile())
    const onlyId = state().activeBoardId!
    state().markBoardsClean()

    state().removeBoard(onlyId)

    expect(state().boards.boards).toHaveLength(1)
    expect(state().boardsDirty).toBe(false)
  })
})

describe('setActiveBoard', () => {
  it('switches the active board', () => {
    state().loadBoards(createBoardsFile())
    const firstId = state().activeBoardId!
    const secondId = state().addBoard('Board 2')
    state().setActiveBoard(firstId)

    expect(state().activeBoardId).toBe(firstId)

    state().setActiveBoard(secondId)
    expect(state().activeBoardId).toBe(secondId)
  })

  it('is a no-op for an unknown board id', () => {
    state().loadBoards(createBoardsFile())
    const firstId = state().activeBoardId!

    state().setActiveBoard('missing')

    expect(state().activeBoardId).toBe(firstId)
  })
})

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
// addDoc / moveDoc / updateDocMarkdown / removeDoc
// ---------------------------------------------------------------------------

describe('addDoc', () => {
  it('adds a doc block to the active board and marks dirty', () => {
    state().loadBoards(createBoardsFile())
    state().addDoc(100, 200)

    const board = selectActiveBoard(state())
    expect(board).not.toBeNull()
    expect(board?.docs).toHaveLength(1)
    const doc = board?.docs[0]
    expect(doc?.x).toBe(100)
    expect(doc?.y).toBe(200)
    expect(doc?.w).toBe(320)
    expect(doc?.h).toBe(200)
    expect(doc?.markdown).toBe('')
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().addDoc(0, 0)
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

describe('moveDoc', () => {
  it('updates a doc block\'s coordinates', () => {
    state().loadBoards(createBoardsFile())
    state().addDoc(0, 0)
    const docId = selectActiveBoard(state())!.docs[0].id
    state().markBoardsClean()

    state().moveDoc(docId, 42, 84)

    const doc = selectActiveBoard(state())!.docs[0]
    expect(doc.x).toBe(42)
    expect(doc.y).toBe(84)
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().moveDoc('missing', 0, 0)
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

describe('updateDocMarkdown', () => {
  it('updates a doc block\'s markdown', () => {
    state().loadBoards(createBoardsFile())
    state().addDoc(0, 0)
    const docId = selectActiveBoard(state())!.docs[0].id
    state().markBoardsClean()

    state().updateDocMarkdown(docId, '# hello board')

    expect(selectActiveBoard(state())!.docs[0].markdown).toBe('# hello board')
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op for an unknown doc id', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().updateDocMarkdown('missing', 'nope')

    expect(selectActiveBoard(state())!.docs).toHaveLength(0)
    expect(state().boardsDirty).toBe(false)
  })

  it('is a no-op with no active board', () => {
    state().updateDocMarkdown('missing', 'nope')
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

describe('removeDoc', () => {
  it('removes a doc block from the active board', () => {
    state().loadBoards(createBoardsFile())
    state().addDoc(0, 0)
    const docId = selectActiveBoard(state())!.docs[0].id
    state().markBoardsClean()

    state().removeDoc(docId)

    expect(selectActiveBoard(state())!.docs).toHaveLength(0)
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op with no active board', () => {
    state().removeDoc('missing')
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
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
// addFrame / seedFramesForActiveBoard
// ---------------------------------------------------------------------------

describe('addFrame', () => {
  it('adds a frame at a default grid position and marks dirty', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().addFrame('home')

    const board = selectActiveBoard(state())
    expect(board?.frames).toEqual([{ pageId: 'home', x: 0, y: 0 }])
    expect(state().boardsDirty).toBe(true)
  })

  it('is idempotent — adding the same pageId twice does not duplicate it', () => {
    state().loadBoards(createBoardsFile())
    state().addFrame('home')
    const before = selectActiveBoard(state())?.frames
    state().markBoardsClean()

    state().addFrame('home')

    expect(selectActiveBoard(state())?.frames).toEqual(before)
    expect(selectActiveBoard(state())?.frames).toHaveLength(1)
    expect(state().boardsDirty).toBe(false)
  })

  it('positions successive frames on a 2-column grid', () => {
    state().loadBoards(createBoardsFile())

    state().addFrame('a')
    state().addFrame('b')
    state().addFrame('c')

    const frames = selectActiveBoard(state())?.frames
    expect(frames?.[0]).toEqual({ pageId: 'a', x: 0, y: 0 })
    expect(frames?.[1].x).toBeGreaterThan(0)
    expect(frames?.[1].y).toBe(0)
    expect(frames?.[2].x).toBe(0)
    expect(frames?.[2].y).toBeGreaterThan(0)
  })

  it('is a no-op with no active board', () => {
    state().addFrame('home')
    expect(selectActiveBoard(state())).toBeNull()
    expect(state().boardsDirty).toBe(false)
  })
})

describe('seedFramesForActiveBoard', () => {
  it('adds frames only for pages missing from the active board', () => {
    state().loadBoards(createBoardsFile())
    state().addFrame('home')
    state().markBoardsClean()

    state().seedFramesForActiveBoard(['home', 'about', 'contact'])

    const pageIds = selectActiveBoard(state())?.frames.map((f) => f.pageId)
    expect(pageIds).toEqual(['home', 'about', 'contact'])
    expect(state().boardsDirty).toBe(true)
  })

  it('is a no-op when every id is already a frame', () => {
    state().loadBoards(createBoardsFile())
    state().addFrame('home')
    state().markBoardsClean()

    state().seedFramesForActiveBoard(['home'])

    expect(state().boardsDirty).toBe(false)
  })

  it('is a no-op with no active board', () => {
    state().seedFramesForActiveBoard(['home'])
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
// setBoardSnapGuides
// ---------------------------------------------------------------------------

describe('setBoardSnapGuides', () => {
  it('replaces the transient guides without touching boardsDirty', () => {
    state().loadBoards(createBoardsFile())
    state().markBoardsClean()

    state().setBoardSnapGuides([{ axis: 'x', position: 100, start: 0, end: 50 }])

    expect(state().boardSnapGuides).toEqual([{ axis: 'x', position: 100, start: 0, end: 50 }])
    expect(state().boardsDirty).toBe(false)
  })

  it('clears guides back to empty', () => {
    state().setBoardSnapGuides([{ axis: 'y', position: 10, start: 0, end: 20 }])

    state().setBoardSnapGuides([])

    expect(state().boardSnapGuides).toEqual([])
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
