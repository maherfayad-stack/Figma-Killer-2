import type { Board, BoardFrame, BoardsFile, StickyNote } from './types'

export function createBoardsFile(): BoardsFile {
  return { version: 1, boards: [] }
}

export function createBoard(id: string, name: string): Board {
  return { id, name, frames: [], notes: [] }
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

export function upsertFrame(board: Board, frame: BoardFrame): Board {
  const index = board.frames.findIndex((f) => f.pageId === frame.pageId)
  const frames =
    index === -1
      ? [...board.frames, frame]
      : board.frames.map((f, i) => (i === index ? frame : f))
  return { ...board, frames }
}

export function moveFrame(board: Board, pageId: string, x: number, y: number): Board {
  const index = board.frames.findIndex((f) => f.pageId === pageId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, x, y } : f))
  return { ...board, frames }
}

export function removeFrame(board: Board, pageId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.pageId !== pageId) }
}
