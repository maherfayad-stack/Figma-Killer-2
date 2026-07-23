/**
 * boardSlice — Studio board overlay state (sticky notes + doc blocks + page frames).
 *
 * Owns the editor-side view of `<workspace>/.studio/boards.json`: the parsed
 * `BoardsFile`, which board is currently active, and a dirty flag the
 * auto-save effect in `AdminCanvasLayout` watches to persist changes back to
 * the server. Only meaningful in studio mode (`?studio`) — the CMS flow never
 * touches this slice.
 *
 * Frames: `board.frames` is the source of truth for which pages are curated
 * onto a board — `BoardFramesLayer` renders exactly this list (resolved
 * against `site.pages`), not "every page". `addFrame` / `seedFramesForActiveBoard`
 * add membership at a default grid slot; `setFramePosition` upserts a
 * position (works for both "first drag" and subsequent moves); `setFrameSize`
 * (Phase 6E) persists a frame's own width/height (canvas drag-resize or the
 * design tab's device-preset picker) — a frame without a saved size renders
 * at the shared `FRAME_WIDTH`/`FRAME_HEIGHT` default; `removeFrame`
 * drops membership without touching the underlying page.
 *
 * Doc blocks: `board.docs` mirrors the sticky-note shape exactly (`addDoc` /
 * `moveDoc` / `updateDocMarkdown` / `removeDoc`) — markdown-authored
 * documentation cards rendered by `BoardDocsLayer`/`DocBlockView`.
 *
 * Boards are plural: `addBoard` / `renameBoard` / `removeBoard` /
 * `setActiveBoard` manage the `BoardsFile`'s board list and which one is
 * active. A board's `frames` are its own — switching boards changes which
 * curated set of pages the canvas shows.
 *
 * All mutations route through the pure `@core/studio-board` transforms
 * (`upsertBoard`, `upsertNote`, `moveNote`, `removeNote`, `upsertDoc`,
 * `moveDoc`, `removeDoc`, `upsertFrame`, `removeFrame`, …) rather than
 * hand-mutating `Board` / `BoardsFile` objects, so this slice stays a thin
 * translation from store actions to the pure board model.
 */
import type { EditorStoreSliceCreator, EditorStore } from '@site/store/types'
import type { Board, BoardsFile, DocBlock, NoteColor, StickyNote } from '@core/studio-board'
import {
  createBoard,
  createBoardsFile,
  upsertBoard,
  removeBoard as removeBoardFromFile,
  renameBoard as renameBoardOnBoard,
  upsertNote,
  moveNote as moveNoteOnBoard,
  removeNote as removeNoteFromBoard,
  upsertDoc,
  moveDoc as moveDocOnBoard,
  removeDoc as removeDocFromBoard,
  upsertFrame,
  removeFrame as removeFrameFromBoard,
  resizeFrame,
} from '@core/studio-board'
import { defaultFramePosition } from '@site/canvas/BoardFramesLayer/frameGrid'

const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'
const DEFAULT_NOTE_WIDTH = 180
const DEFAULT_NOTE_HEIGHT = 120
const DEFAULT_DOC_WIDTH = 320
const DEFAULT_DOC_HEIGHT = 200

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
  /**
   * Create a new board (empty frames/notes), make it active, and return its
   * id. `name` defaults to the next unique "Board N".
   */
  addBoard: (name?: string) => string
  /** Rename a board. No-op for an unknown id. */
  renameBoard: (boardId: string, name: string) => void
  /**
   * Delete a board. If it was active, activity switches to the first
   * remaining board. Never removes the last board (no-op).
   */
  removeBoard: (boardId: string) => void
  /** Switch which board is active. No-op for an unknown id. */
  setActiveBoard: (boardId: string) => void
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
  /** Create a doc block at (x, y) on the active board. No-op with no active board. */
  addDoc: (x: number, y: number) => void
  /** Reposition a doc block on the active board. */
  moveDoc: (docId: string, x: number, y: number) => void
  /** Update a doc block's markdown content. */
  updateDocMarkdown: (docId: string, markdown: string) => void
  /** Delete a doc block from the active board. */
  removeDoc: (docId: string) => void
  /**
   * Persist a page's frame position on the active board — inserts a new
   * `BoardFrame` if the page has none yet, updates it otherwise. No-op with
   * no active board.
   */
  setFramePosition: (pageId: string, x: number, y: number) => void
  /**
   * Persist a page's frame size (Phase 6E — resizable frames + device
   * presets) on the active board. No-op with no active board, or if the
   * page has no frame yet (unlike `setFramePosition`, resize never creates a
   * frame — `addFrame`/`seedFramesForActiveBoard` own frame creation).
   */
  setFrameSize: (pageId: string, width: number, height: number) => void
  /** Remove a page's saved frame position from the active board. */
  removeFrame: (pageId: string) => void
  /**
   * Add a `BoardFrame` for `pageId` to the ACTIVE board at a default grid
   * slot. No-op if the page is already a frame on the board, or there is no
   * active board.
   */
  addFrame: (pageId: string) => void
  /**
   * Add frames (grid layout) for every `pageId` not already present on the
   * ACTIVE board. Used for the one-time default-board seed. No-op with no
   * active board or when every id is already a frame.
   */
  seedFramesForActiveBoard: (pageIds: string[]) => void
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

/** Next unused "Board N" name — skips numbers already taken by another board. */
function nextDefaultBoardName(boards: Board[]): string {
  const names = new Set(boards.map((b) => b.name))
  let n = 1
  while (names.has(`Board ${n}`)) n++
  return `Board ${n}`
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

  addBoard: (name) => {
    const { boards } = get()
    const board = createBoard(crypto.randomUUID(), name ?? nextDefaultBoardName(boards.boards))
    set({
      boards: upsertBoard(boards, board),
      activeBoardId: board.id,
      boardsDirty: true,
    })
    return board.id
  },

  renameBoard: (boardId, name) => {
    const { boards } = get()
    const board = boards.boards.find((b) => b.id === boardId)
    if (!board) return
    set({ boards: upsertBoard(boards, renameBoardOnBoard(board, name)), boardsDirty: true })
  },

  removeBoard: (boardId) => {
    const { boards, activeBoardId } = get()
    // Never remove the last board — the studio canvas always needs one.
    if (boards.boards.length <= 1) return
    if (!boards.boards.some((b) => b.id === boardId)) return

    const nextBoards = removeBoardFromFile(boards, boardId)
    const nextActiveBoardId =
      activeBoardId === boardId ? nextBoards.boards[0]?.id ?? null : activeBoardId
    set({ boards: nextBoards, activeBoardId: nextActiveBoardId, boardsDirty: true })
  },

  setActiveBoard: (boardId) => {
    const { boards } = get()
    if (!boards.boards.some((b) => b.id === boardId)) return
    set({ activeBoardId: boardId })
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

  addDoc: (x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return

    const doc: DocBlock = {
      id: crypto.randomUUID(),
      x,
      y,
      w: DEFAULT_DOC_WIDTH,
      h: DEFAULT_DOC_HEIGHT,
      markdown: '',
    }
    set({ boards: upsertBoard(boards, upsertDoc(board, doc)), boardsDirty: true })
  },

  moveDoc: (docId, x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, moveDocOnBoard(board, docId, x, y)), boardsDirty: true })
  },

  updateDocMarkdown: (docId, markdown) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existing = board.docs.find((d) => d.id === docId)
    if (!existing) return
    set({
      boards: upsertBoard(boards, upsertDoc(board, { ...existing, markdown })),
      boardsDirty: true,
    })
  },

  removeDoc: (docId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, removeDocFromBoard(board, docId)), boardsDirty: true })
  },

  setFramePosition: (pageId, x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, upsertFrame(board, { pageId, x, y })), boardsDirty: true })
  },

  setFrameSize: (pageId, width, height) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, resizeFrame(board, pageId, width, height)), boardsDirty: true })
  },

  removeFrame: (pageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, removeFrameFromBoard(board, pageId)), boardsDirty: true })
  },

  addFrame: (pageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    if (board.frames.some((f) => f.pageId === pageId)) return
    const { x, y } = defaultFramePosition(board.frames.length)
    set({ boards: upsertBoard(boards, upsertFrame(board, { pageId, x, y })), boardsDirty: true })
  },

  seedFramesForActiveBoard: (pageIds) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existingIds = new Set(board.frames.map((f) => f.pageId))
    const missingIds = pageIds.filter((id) => !existingIds.has(id))
    if (missingIds.length === 0) return

    const nextBoard = missingIds.reduce((acc, pageId, i) => {
      const { x, y } = defaultFramePosition(board.frames.length + i)
      return upsertFrame(acc, { pageId, x, y })
    }, board)
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  markBoardsClean: () => set({ boardsDirty: false }),
})

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)
