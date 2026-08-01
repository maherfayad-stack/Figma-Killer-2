import type { Board, BoardFrame, BoardsFile, DocBlock, StickyNote } from './types'
import type { PreviewAxes } from './previewAxes'

export function createBoardsFile(): BoardsFile {
  return { version: 1, boards: [] }
}

export function createBoard(id: string, name: string): Board {
  return { id, name, frames: [], notes: [], docs: [] }
}

export function upsertBoard(file: BoardsFile, board: Board): BoardsFile {
  const index = file.boards.findIndex((b) => b.id === board.id)
  const boards =
    index === -1
      ? [...file.boards, board]
      : file.boards.map((b, i) => (i === index ? board : b))
  return { ...file, boards }
}

export function removeBoard(file: BoardsFile, boardId: string): BoardsFile {
  return { ...file, boards: file.boards.filter((b) => b.id !== boardId) }
}

export function renameBoard(board: Board, name: string): Board {
  return { ...board, name }
}

export function upsertNote(board: Board, note: StickyNote): Board {
  const index = board.notes.findIndex((n) => n.id === note.id)
  const notes =
    index === -1
      ? [...board.notes, note]
      : board.notes.map((n, i) => (i === index ? note : n))
  return { ...board, notes }
}

export function moveNote(board: Board, noteId: string, x: number, y: number): Board {
  const index = board.notes.findIndex((n) => n.id === noteId)
  if (index === -1) return board
  const notes = board.notes.map((n, i) => (i === index ? { ...n, x, y } : n))
  return { ...board, notes }
}

export function removeNote(board: Board, noteId: string): Board {
  return { ...board, notes: board.notes.filter((n) => n.id !== noteId) }
}

export function upsertDoc(board: Board, doc: DocBlock): Board {
  const index = board.docs.findIndex((d) => d.id === doc.id)
  const docs =
    index === -1
      ? [...board.docs, doc]
      : board.docs.map((d, i) => (i === index ? doc : d))
  return { ...board, docs }
}

export function moveDoc(board: Board, docId: string, x: number, y: number): Board {
  const index = board.docs.findIndex((d) => d.id === docId)
  if (index === -1) return board
  const docs = board.docs.map((d, i) => (i === index ? { ...d, x, y } : d))
  return { ...board, docs }
}

export function removeDoc(board: Board, docId: string): Board {
  return { ...board, docs: board.docs.filter((d) => d.id !== docId) }
}

// ---------------------------------------------------------------------------
// Frames — keyed by `BoardFrame.id` (WS-10 Phase 2), NOT `pageId`. Before
// "duplicate as variant" a board never had two frames of the same page, so
// `pageId` alone was already a unique frame key; a duplicated variant breaks
// that (two frames, one `pageId`, different `axes`), so every per-frame
// mutation below addresses a SPECIFIC frame by its own `id`. `pageId` stays
// on `BoardFrame` purely to say which page's tree a frame renders — see
// `types.ts`'s doc.
// ---------------------------------------------------------------------------

/**
 * Insert a NEW frame (an `id` the board doesn't have yet) or merge the given
 * fields onto the EXISTING frame with that `id` — merging (not replacing)
 * preserves fields the caller didn't mention (notably `width`/`height`),
 * which is what lets `setFramePosition` pass just `{ id, pageId, x, y }`
 * without dropping a previously-resized frame's size.
 */
export function upsertFrame(board: Board, frame: Partial<BoardFrame> & { id: string; pageId: string }): Board {
  const index = board.frames.findIndex((f) => f.id === frame.id)
  const frames =
    index === -1
      ? [...board.frames, { ...frame, x: frame.x ?? 0, y: frame.y ?? 0 }]
      : board.frames.map((f, i) => (i === index ? { ...f, ...frame } : f))
  return { ...board, frames }
}

export function moveFrame(board: Board, frameId: string, x: number, y: number): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, x, y } : f))
  return { ...board, frames }
}

/** No-op for a missing frame id, mirroring `moveFrame`. */
export function resizeFrame(board: Board, frameId: string, width: number, height: number): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, width, height } : f))
  return { ...board, frames }
}

/**
 * Removes ONE frame by id — surgical, so removing a "duplicate as variant"
 * never touches its sibling.
 */
export function removeFrame(board: Board, frameId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.id !== frameId) }
}

/**
 * Removes EVERY frame of a page — the pre-Phase-2 `removeFrame(pageId)`
 * behaviour, kept as its own named function for callers that genuinely mean
 * "this page" rather than "this one frame instance" (the bulk multi-select
 * path, `FrameBulkInspector.tsx` — `selectedFrameIds` is still page-id-keyed,
 * see `boardSlice.ts`'s module doc for why that's an accepted, documented
 * scope boundary rather than a Phase 2 requirement).
 */
export function removeFramesForPage(board: Board, pageId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.pageId !== pageId) }
}

/** WS-10 Phase 2 — set (`axes` provided) or clear (`undefined`) a frame's per-axis preview override. No-op for a missing frame id. */
export function setFrameAxes(board: Board, frameId: string, axes: Partial<PreviewAxes> | undefined): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => {
    if (i !== index) return f
    if (!axes) {
      const { axes: _drop, ...rest } = f
      return rest
    }
    return { ...f, axes }
  })
  return { ...board, frames }
}

/**
 * WS-10 Phase 2 (§4.3-§4.4) — "duplicate as variant": a new frame of the
 * SAME page (`sourceFrameId`'s `pageId`, size), its OWN `id` (caller-
 * supplied — this module stays a pure function, no `crypto.randomUUID()`
 * inside it, matching how `boardSlice.ts` already mints every other id),
 * positioned at `x`/`y` and carrying `axes` as its preview override. `null`
 * when `sourceFrameId` doesn't exist. Never touches the source frame, never
 * writes to the user's source (`studio-workspace/*` is user data, trap #12 —
 * this is purely a `boards.json` object).
 */
export function duplicateFrame(
  board: Board,
  sourceFrameId: string,
  next: { id: string; x: number; y: number; axes: Partial<PreviewAxes> },
): Board | null {
  const source = board.frames.find((f) => f.id === sourceFrameId)
  if (!source) return null
  const frame: BoardFrame = {
    ...source,
    id: next.id,
    x: next.x,
    y: next.y,
    axes: next.axes,
  }
  return { ...board, frames: [...board.frames, frame] }
}
