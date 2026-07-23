import type { Board, BoardFrame, BoardsFile, DocBlock, StickyNote } from './types'

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

export function upsertFrame(board: Board, frame: Partial<BoardFrame> & { pageId: string }): Board {
  const index = board.frames.findIndex((f) => f.pageId === frame.pageId)
  const frames =
    index === -1
      ? [...board.frames, { ...frame, x: frame.x ?? 0, y: frame.y ?? 0 }]
      : // MERGE on update — a partial upsert (e.g. `setFramePosition` passing
        // only `{ pageId, x, y }`) must preserve fields it doesn't mention,
        // notably `width`/`height`. Replacing the frame outright dropped a
        // resized frame's size the moment it was moved.
        board.frames.map((f, i) => (i === index ? { ...f, ...frame } : f))
  return { ...board, frames }
}

export function moveFrame(board: Board, pageId: string, x: number, y: number): Board {
  const index = board.frames.findIndex((f) => f.pageId === pageId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, x, y } : f))
  return { ...board, frames }
}

/** No-op for a missing pageId, mirroring `moveFrame`. */
export function resizeFrame(board: Board, pageId: string, width: number, height: number): Board {
  const index = board.frames.findIndex((f) => f.pageId === pageId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, width, height } : f))
  return { ...board, frames }
}

export function removeFrame(board: Board, pageId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.pageId !== pageId) }
}
