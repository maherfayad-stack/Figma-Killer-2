/**
 * boardSlice — Studio board overlay state (sticky notes + page frames).
 *
 * Owns the editor-side view of `<workspace>/.studio/boards.json`: the parsed
 * `BoardsFile`, which board is currently active, and a dirty flag the
 * auto-save effect in `AdminCanvasLayout` watches to persist changes back to
 * the server. Only meaningful in studio mode (`?studio`) — the CMS flow never
 * touches this slice.
 *
 * Frames: `board.frames` only stores POSITIONS (`{ pageId, x, y }`) — WHICH
 * frames exist is derived from `site.pages` by `BoardFramesLayer`, which
 * falls back to a default grid slot for any page without a saved position.
 * `setFramePosition` upserts a position (works for both "first drag" and
 * subsequent moves), so no separate add/reconcile action is needed.
 *
 * All mutations route through the pure `@core/studio-board` transforms
 * (`upsertBoard`, `upsertNote`, `moveNote`, `removeNote`, `upsertFrame`,
 * `removeFrame`, …) rather than hand-mutating `Board` / `BoardsFile` objects,
 * so this slice stays a thin translation from store actions to the pure
 * board model.
 */
import type { EditorStoreSliceCreator, EditorStore } from '@site/store/types'
import type { Board, BoardsFile, NoteColor, StickyNote } from '@core/studio-board'
import {
  createBoard,
  createBoardsFile,
  upsertBoard,
  upsertNote,
  moveNote as moveNoteOnBoard,
  removeNote as removeNoteFromBoard,
  upsertFrame,
  removeFrame as removeFrameFromBoard,
} from '@core/studio-board'

const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'
const DEFAULT_NOTE_WIDTH = 180
const DEFAULT_NOTE_HEIGHT = 120

interface BoardSlice {
  /** The parsed `.studio/boards.json` contents. */
  boards: BoardsFile
  /** Board the sticky-notes overlay reads/writes. `null` until loaded. */
  activeBoardId: string | null
  /** True once `loadBoards` has run for this editor session. */
  boardsLoaded: boolean
  /** True when `boards` has unsaved changes the auto-save effect must flush. */
  boardsDirty: boolean

  /**
   * Hydrate from a freshly-fetched `BoardsFile`. An empty file gets a default
   * "Board 1" created and marked dirty so the newly-created board persists
   * on the next auto-save.
   */
  loadBoards: (file: BoardsFile) => void
  /** Create a sticky note at (x, y) on the active board. No-op with no active board. */
  addNote: (x: number, y: number) => void
  /** Reposition a note on the active board. */
  moveNote: (noteId: string, x: number, y: number) => void
  /** Update a note's text content. */
  updateNoteText: (noteId: string, text: string) => void
  /** Recolor a note. */
  setNoteColor: (noteId: string, color: NoteColor) => void
  /** Delete a note from the active board. */
  removeNote: (noteId: string) => void
  /**
   * Persist a page's frame position on the active board — inserts a new
   * `BoardFrame` if the page has none yet, updates it otherwise. No-op with
   * no active board.
   */
  setFramePosition: (pageId: string, x: number, y: number) => void
  /** Remove a page's saved frame position from the active board. */
  removeFrame: (pageId: string) => void
  /** Clear the dirty flag after a successful save. */
  markBoardsClean: () => void
}

declare module '@site/store/types' {
  interface EditorStore extends BoardSlice {}
}

/** Find the active board, or `null` when there is none (not loaded / no boards). */
function getActiveBoard(boards: BoardsFile, activeBoardId: string | null): Board | null {
  if (!activeBoardId) return null
  return boards.boards.find((b) => b.id === activeBoardId) ?? null
}

export const createBoardSlice: EditorStoreSliceCreator<BoardSlice> = (set, get) => ({
  boards: createBoardsFile(),
  activeBoardId: null,
  boardsLoaded: false,
  boardsDirty: false,

  loadBoards: (file) => {
    if (file.boards.length > 0) {
      set({
        boards: file,
        boardsLoaded: true,
        boardsDirty: false,
        activeBoardId: file.boards[0].id,
      })
      return
    }

    const board = createBoard(crypto.randomUUID(), 'Board 1')
    set({
      boards: upsertBoard(file, board),
      boardsLoaded: true,
      // A fresh default board was created locally — it needs to persist.
      boardsDirty: true,
      activeBoardId: board.id,
    })
  },

  addNote: (x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return

    const note: StickyNote = {
      id: crypto.randomUUID(),
      x,
      y,
      w: DEFAULT_NOTE_WIDTH,
      h: DEFAULT_NOTE_HEIGHT,
      text: '',
      color: DEFAULT_NOTE_COLOR,
    }
    set({ boards: upsertBoard(boards, upsertNote(board, note)), boardsDirty: true })
  },

  moveNote: (noteId, x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, moveNoteOnBoard(board, noteId, x, y)), boardsDirty: true })
  },

  updateNoteText: (noteId, text) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existing = board.notes.find((n) => n.id === noteId)
    if (!existing) return
    set({
      boards: upsertBoard(boards, upsertNote(board, { ...existing, text })),
      boardsDirty: true,
    })
  },

  setNoteColor: (noteId, color) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existing = board.notes.find((n) => n.id === noteId)
    if (!existing) return
    set({
      boards: upsertBoard(boards, upsertNote(board, { ...existing, color })),
      boardsDirty: true,
    })
  },

  removeNote: (noteId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, removeNoteFromBoard(board, noteId)), boardsDirty: true })
  },

  setFramePosition: (pageId, x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, upsertFrame(board, { pageId, x, y })), boardsDirty: true })
  },

  removeFrame: (pageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, removeFrameFromBoard(board, pageId)), boardsDirty: true })
  },

  markBoardsClean: () => set({ boardsDirty: false }),
})

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)
