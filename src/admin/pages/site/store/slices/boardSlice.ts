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
 *
 * Snap guides (Phase 6B): `boardSnapGuides` is a TRANSIENT UI field — the
 * alignment guide lines `BoardGuidesLayer` draws while a frame/note/doc is
 * mid-drag. It intentionally lives as its own top-level store field, NOT
 * inside `boards`/`BoardsFile`, so it never reaches `serializeBoardsFile` or
 * the boards auto-save effect (`AdminCanvasLayout`'s `useStudioBoardsPersistence`
 * only ever reads/writes `boards`). `setBoardSnapGuides` never flips
 * `boardsDirty` for the same reason — guides are drawn, not persisted.
 *
 * Frame multi-selection (WS-7.1): `selectedFrameIds` is a SEPARATE selection
 * domain from `selectedNodeIds` (selectionSlice) — a board frame is not a
 * node. `selectFrame`/`selectAllFrames` clear the node selection when they
 * make the frame selection non-empty (and vice versa in selectionSlice), so
 * the Properties panel always shows exactly one of "frame(s) selected" or
 * "node(s) selected", never both. Bulk frame actions (WS-7.2 — set size,
 * device preset, apply-to-all-pages, fit-to-content, align/distribute, tidy)
 * all resolve their target set from `selectedFrameIds` against the active
 * board and go through the same pure `upsertFrame`/`resizeFrame` transforms
 * as the single-frame actions above, so every write round-trips through
 * `parseBoardsFile` identically.
 *
 * `frameDefaults` (WS-7.2 — "apply to all pages") mirrors the per-project
 * default in `.studio/meta.json`'s `frameDefaults` (`server/handlers/studio/
 * studioMeta.ts`) — `AdminCanvasLayout` hydrates it via `setFrameDefaults`
 * alongside the boards load, and `addFrame`/`seedFramesForActiveBoard` read
 * it so a page added AFTER "apply to all pages" inherits the same width
 * instead of falling back to the hardcoded `FRAME_WIDTH`. This slice never
 * calls the meta.json endpoint itself — persisting the default is the UI
 * action's job (`frameDefaultsApi.ts`), matching every other project-meta
 * write in this codebase (rename, probe) — the store stays a pure state
 * container with no direct HTTP calls.
 */
import type { EditorStoreSliceCreator, EditorStore } from '@site/store/types'
import type { Board, BoardsFile, DocBlock, NoteColor, StickyNote } from '@core/studio-board'
import type { SnapGuide } from '@site/canvas/boardSnapping'
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
import { defaultFramePosition, FRAME_WIDTH, FRAME_HEIGHT } from '@site/canvas/BoardFramesLayer/frameGrid'
import { alignFrames, distributeFrames, type AlignableFrame, type FrameAlignEdge } from '@site/canvas/BoardFramesLayer/frameAlign'

export type { FrameAlignEdge }

const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'
const DEFAULT_NOTE_WIDTH = 180
const DEFAULT_NOTE_HEIGHT = 120
const DEFAULT_DOC_WIDTH = 320
const DEFAULT_DOC_HEIGHT = 200

/** Mirrors `FrameDefaultsSchema` in `server/handlers/studio/studioMeta.ts` — kept as a plain client-local shape so this browser module never imports server code. */
export interface FrameDefaults {
  width?: number
  height?: number
}

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
   * Transient alignment guide lines for the furniture piece currently being
   * dragged (Phase 6B). Empty outside of an active drag. NOT persisted — see
   * the module doc's "Snap guides" note.
   */
  boardSnapGuides: SnapGuide[]

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
  /**
   * Replace the active drag's snap guides (Phase 6B). Pass `[]` to clear —
   * furniture drag handlers do this on pointer-up/cancel. Never touches
   * `boardsDirty`: guides are drawn, not persisted.
   */
  setBoardSnapGuides: (guides: SnapGuide[]) => void

  // ── Frame multi-selection (WS-7.1) ───────────────────────────────────────
  /** Selected frame ids (page ids), on the ACTIVE board. Distinct from node selection. */
  selectedFrameIds: string[]
  /**
   * Select a frame. `replace` (default) clears the set and selects only
   * `pageId`; `toggle` (Shift-click) adds it if absent, removes it if
   * present. Selecting a frame clears the node selection (mutual
   * exclusivity — see module doc).
   */
  selectFrame: (pageId: string, mode?: 'replace' | 'toggle') => void
  /** Replace the frame selection wholesale — the marquee-drag live-update path. No-op if the set is reference-unchanged in length AND content is trivially empty-to-empty. */
  setSelectedFrameIds: (pageIds: string[]) => void
  /** Replace the frame selection with every frame on the active board (⌘/Ctrl+A on empty canvas). */
  selectAllFrames: () => void
  /** Empty the frame selection. No-op if already empty. */
  clearFrameSelection: () => void

  // ── Per-project frame size default (WS-7.2 — "apply to all pages") ──────
  /** Local mirror of `.studio/meta.json`'s `frameDefaults` — hydrated by `AdminCanvasLayout`, read by `addFrame`/`seedFramesForActiveBoard`. */
  frameDefaults: FrameDefaults
  /** Replace the local `frameDefaults` mirror (load-time hydration; does not itself persist anything). */
  setFrameDefaults: (defaults: FrameDefaults) => void

  // ── Bulk frame actions (WS-7.2) — all operate on `selectedFrameIds` ─────
  /**
   * Set width and/or height on every selected frame. Pass `null` for a
   * dimension to leave it unchanged per-frame (mixed-value support: typing
   * only W in the bulk inspector must not clobber each frame's own H).
   */
  setSelectedFramesSize: (width: number | null, height: number | null) => void
  /**
   * The literal "apply to all pages" ask: writes `width` to EVERY frame on
   * the active board (not just the selection) and updates the local
   * `frameDefaults` mirror so a page added later inherits it via
   * `addFrame`/`seedFramesForActiveBoard`. Does not touch `.studio/
   * meta.json` itself — the calling UI persists that through
   * `frameDefaultsApi.ts` (see module doc).
   */
  applyWidthToAllFrames: (width: number) => void
  /**
   * Set each named frame's height individually — the generic primitive
   * behind "fit height to content": the UI measures each selected frame's
   * live iframe content height and passes the result here so the store
   * itself never reaches into the DOM.
   */
  setFrameHeights: (heightsByPageId: Record<string, number>) => void
  /** Align every selected frame to a shared edge/center line. No-op below 2 selected frames. */
  alignSelectedFrames: (edge: FrameAlignEdge) => void
  /** Space selected frames evenly along an axis, extremes fixed. No-op below 3 selected frames. */
  distributeSelectedFrames: (axis: 'horizontal' | 'vertical') => void
  /** Re-lay every selected frame into the standard add-time grid, in selection order. */
  tidySelectedFrames: () => void
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
  boardSnapGuides: [],
  selectedFrameIds: [],
  frameDefaults: {},

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
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    if (board.frames.some((f) => f.pageId === pageId)) return
    const { x, y } = defaultFramePosition(board.frames.length)
    // WS-7.2 — a page added after "apply to all pages" inherits the
    // project's frame default instead of the hardcoded FRAME_WIDTH/HEIGHT.
    const frame: Parameters<typeof upsertFrame>[1] = { pageId, x, y }
    if (frameDefaults.width) frame.width = frameDefaults.width
    if (frameDefaults.height) frame.height = frameDefaults.height
    set({ boards: upsertBoard(boards, upsertFrame(board, frame)), boardsDirty: true })
  },

  seedFramesForActiveBoard: (pageIds) => {
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existingIds = new Set(board.frames.map((f) => f.pageId))
    const missingIds = pageIds.filter((id) => !existingIds.has(id))
    if (missingIds.length === 0) return

    const nextBoard = missingIds.reduce((acc, pageId, i) => {
      const { x, y } = defaultFramePosition(board.frames.length + i)
      const frame: Parameters<typeof upsertFrame>[1] = { pageId, x, y }
      if (frameDefaults.width) frame.width = frameDefaults.width
      if (frameDefaults.height) frame.height = frameDefaults.height
      return upsertFrame(acc, frame)
    }, board)
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  markBoardsClean: () => set({ boardsDirty: false }),

  setBoardSnapGuides: (guides) => set({ boardSnapGuides: guides }),

  // ── Frame multi-selection (WS-7.1) ───────────────────────────────────────

  selectFrame: (pageId, mode = 'replace') => {
    const { selectedFrameIds } = get()
    const nextIds =
      mode === 'toggle'
        ? selectedFrameIds.includes(pageId)
          ? selectedFrameIds.filter((id) => id !== pageId)
          : [...selectedFrameIds, pageId]
        : [pageId]
    set((state) => {
      state.selectedFrameIds = nextIds
      // Mutual exclusivity (module doc) — a frame selection replaces any
      // node selection so the Properties panel shows exactly one inspector.
      if (nextIds.length > 0 && state.selectedNodeIds.length > 0) {
        state.selectedNodeIds = []
        state.selectedNodeId = null
      }
    })
  },

  setSelectedFrameIds: (pageIds) => {
    const { selectedFrameIds } = get()
    if (selectedFrameIds.length === 0 && pageIds.length === 0) return
    if (
      selectedFrameIds.length === pageIds.length &&
      selectedFrameIds.every((id, i) => id === pageIds[i])
    ) {
      return
    }
    set((state) => {
      state.selectedFrameIds = pageIds
      if (pageIds.length > 0 && state.selectedNodeIds.length > 0) {
        state.selectedNodeIds = []
        state.selectedNodeId = null
      }
    })
  },

  selectAllFrames: () => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || board.frames.length === 0) return
    const ids = board.frames.map((f) => f.pageId)
    set((state) => {
      state.selectedFrameIds = ids
      if (state.selectedNodeIds.length > 0) {
        state.selectedNodeIds = []
        state.selectedNodeId = null
      }
    })
  },

  clearFrameSelection: () => {
    if (get().selectedFrameIds.length === 0) return
    set({ selectedFrameIds: [] })
  },

  // ── Per-project frame size default (WS-7.2) ─────────────────────────────

  setFrameDefaults: (defaults) => set({ frameDefaults: defaults }),

  // ── Bulk frame actions (WS-7.2) ─────────────────────────────────────────

  setSelectedFramesSize: (width, height) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || selectedFrameIds.length === 0) return
    let nextBoard = board
    for (const pageId of selectedFrameIds) {
      const frame = nextBoard.frames.find((f) => f.pageId === pageId)
      if (!frame) continue
      const w = width ?? frame.width ?? FRAME_WIDTH
      const h = height ?? frame.height ?? FRAME_HEIGHT
      nextBoard = resizeFrame(nextBoard, pageId, w, h)
    }
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  applyWidthToAllFrames: (width) => {
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || board.frames.length === 0) return
    let nextBoard = board
    for (const frame of board.frames) {
      // Preserve each frame's own height (explicit, or the shared default
      // made explicit) — only width is the "apply to all pages" ask.
      nextBoard = resizeFrame(nextBoard, frame.pageId, width, frame.height ?? FRAME_HEIGHT)
    }
    set({
      boards: upsertBoard(boards, nextBoard),
      boardsDirty: true,
      frameDefaults: { ...frameDefaults, width },
    })
  },

  setFrameHeights: (heightsByPageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    let nextBoard = board
    let changed = false
    for (const [pageId, height] of Object.entries(heightsByPageId)) {
      const frame = nextBoard.frames.find((f) => f.pageId === pageId)
      if (!frame || !Number.isFinite(height) || height <= 0) continue
      nextBoard = resizeFrame(nextBoard, pageId, frame.width ?? FRAME_WIDTH, height)
      changed = true
    }
    if (!changed) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  alignSelectedFrames: (edge) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || selectedFrameIds.length < 2) return
    const rects: AlignableFrame[] = []
    for (const pageId of selectedFrameIds) {
      const frame = board.frames.find((f) => f.pageId === pageId)
      if (frame) rects.push({ pageId, x: frame.x, y: frame.y, width: frame.width ?? FRAME_WIDTH, height: frame.height ?? FRAME_HEIGHT })
    }
    if (rects.length < 2) return
    const positions = alignFrames(rects, edge)
    let nextBoard = board
    for (const [pageId, pos] of positions) {
      nextBoard = upsertFrame(nextBoard, { pageId, x: pos.x, y: pos.y })
    }
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  distributeSelectedFrames: (axis) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || selectedFrameIds.length < 3) return
    const rects: AlignableFrame[] = []
    for (const pageId of selectedFrameIds) {
      const frame = board.frames.find((f) => f.pageId === pageId)
      if (frame) rects.push({ pageId, x: frame.x, y: frame.y, width: frame.width ?? FRAME_WIDTH, height: frame.height ?? FRAME_HEIGHT })
    }
    const positions = distributeFrames(rects, axis)
    if (positions.size === 0) return
    let nextBoard = board
    for (const [pageId, pos] of positions) {
      nextBoard = upsertFrame(nextBoard, { pageId, x: pos.x, y: pos.y })
    }
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  tidySelectedFrames: () => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board || selectedFrameIds.length === 0) return
    let nextBoard = board
    let index = 0
    for (const pageId of selectedFrameIds) {
      if (!nextBoard.frames.some((f) => f.pageId === pageId)) continue
      const { x, y } = defaultFramePosition(index)
      nextBoard = upsertFrame(nextBoard, { pageId, x, y })
      index += 1
    }
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },
})

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)

/** Select the active drag's snap guides (empty outside of a drag). */
export const selectBoardSnapGuides = (s: EditorStore): SnapGuide[] => s.boardSnapGuides
