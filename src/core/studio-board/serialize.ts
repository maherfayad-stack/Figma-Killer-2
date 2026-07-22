import type { Board, BoardFrame, BoardsFile, DocBlock, NoteColor, StickyNote } from './types'

const NOTE_COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'gray']

export function serializeBoardsFile(file: BoardsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

function emptyBoardsFile(): BoardsFile {
  return { version: 1, boards: [] }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceFrame(raw: unknown): BoardFrame | undefined {
  if (!isPlainObject(raw)) return undefined
  const pageId = raw.pageId
  if (typeof pageId !== 'string' || pageId.length === 0) return undefined
  const x = typeof raw.x === 'number' ? raw.x : 0
  const y = typeof raw.y === 'number' ? raw.y : 0
  return { pageId, x, y }
}

function coerceNote(raw: unknown): StickyNote | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const x = typeof raw.x === 'number' ? raw.x : 0
  const y = typeof raw.y === 'number' ? raw.y : 0
  const w = typeof raw.w === 'number' ? raw.w : 200
  const h = typeof raw.h === 'number' ? raw.h : 120
  const text = typeof raw.text === 'string' ? raw.text : ''
  const color = NOTE_COLORS.includes(raw.color as NoteColor) ? (raw.color as NoteColor) : 'yellow'
  return { id, x, y, w, h, text, color }
}

function coerceDoc(raw: unknown): DocBlock | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const x = typeof raw.x === 'number' ? raw.x : 0
  const y = typeof raw.y === 'number' ? raw.y : 0
  const w = typeof raw.w === 'number' ? raw.w : 320
  const h = typeof raw.h === 'number' ? raw.h : 200
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : ''
  return { id, x, y, w, h, markdown }
}

function coerceBoard(raw: unknown): Board | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = raw.id
  const name = raw.name
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof name !== 'string') return undefined

  const frames: BoardFrame[] = Array.isArray(raw.frames)
    ? raw.frames.map(coerceFrame).filter((f): f is BoardFrame => f !== undefined)
    : []
  const notes: StickyNote[] = Array.isArray(raw.notes)
    ? raw.notes.map(coerceNote).filter((n): n is StickyNote => n !== undefined)
    : []
  // `docs` is new — existing boards.json files predate it. Missing or
  // malformed input defaults to an empty list rather than failing the parse.
  const docs: DocBlock[] = Array.isArray(raw.docs)
    ? raw.docs.map(coerceDoc).filter((d): d is DocBlock => d !== undefined)
    : []

  return { id, name, frames, notes, docs }
}

export function parseBoardsFile(raw: unknown): BoardsFile {
  let value: unknown = raw

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return emptyBoardsFile()
    }
  }

  if (!isPlainObject(value)) return emptyBoardsFile()
  if (!Array.isArray(value.boards)) return emptyBoardsFile()

  const boards = value.boards
    .map(coerceBoard)
    .filter((b): b is Board => b !== undefined)

  return { version: 1, boards }
}
