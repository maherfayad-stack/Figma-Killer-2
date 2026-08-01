import type { Board, BoardFrame, BoardsFile, DocBlock, NoteColor, StickyNote } from './types'
import type { PreviewAxes } from './previewAxes'

const NOTE_COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'gray']

/**
 * WS-10 Phase 2/4 — `BoardFrame.axes`, a Partial<PreviewAxes>. `locale`
 * (Phase 4, `@site/store/slices/localizedPageSlice.ts`'s
 * `(pageId, locale)` rendering) is a plain non-empty string, same
 * tolerant-partial posture `studioMeta.ts` uses server-side for a
 * hand-edited or older-version file.
 */
function coerceAxesOverride(raw: unknown): Partial<PreviewAxes> | undefined {
  if (!isPlainObject(raw)) return undefined
  const override: Partial<PreviewAxes> = {}
  if (raw.direction === 'ltr' || raw.direction === 'rtl') override.direction = raw.direction
  if (raw.colorScheme === 'light' || raw.colorScheme === 'dark') override.colorScheme = raw.colorScheme
  if (typeof raw.locale === 'string' && raw.locale.length > 0) override.locale = raw.locale
  return Object.keys(override).length > 0 ? override : undefined
}

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
  // WS-10 Phase 2 — `id` is the frame's OWN identity (see `BoardFrame`'s
  // doc). A pre-Phase-2 `boards.json` never has one; synthesize it from
  // `pageId`, which was already a unique, stable, deterministic frame key
  // back when a board could only ever have ONE frame per page — so this is
  // not a guess, it reproduces the same id on every read, and a file with no
  // duplicated-variant frames round-trips byte-for-byte apart from gaining
  // this field (same "additive, no migration needed" precedent width/height
  // established for this function).
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : pageId
  const frame: BoardFrame = { id, pageId, x, y }
  // width/height are additive (Phase 6E) — omit them entirely when absent or
  // invalid rather than baking in a default here, so the render layer's own
  // `?? FRAME_WIDTH` / `?? FRAME_HEIGHT` fallback is the single source of
  // truth for "no saved size yet" and old boards.json files round-trip
  // byte-for-byte instead of gaining a synthesized width/height on next save.
  if (typeof raw.width === 'number' && raw.width > 0) frame.width = raw.width
  if (typeof raw.height === 'number' && raw.height > 0) frame.height = raw.height
  const axes = coerceAxesOverride(raw.axes)
  if (axes) frame.axes = axes
  return frame
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
