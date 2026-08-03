/**
 * boardAnnotationActions — the sticky-note and doc-block transforms, as PURE
 * `Board -> Board | null` functions. Split out of `boardSlice.ts` (which stays
 * the thin `set`/`get` wiring) purely to stay under the module-size-budget
 * ceiling — the same reasoning, and the same shape, as the sibling
 * `boardBulkFrameActions.ts`.
 *
 * The split was forced by `store-02`: the boards-load-failure fix added
 * `boardsLoadFailed`/`markBoardsLoadFailed` and pushed `boardSlice.ts` from
 * 690 to 732 lines, past the 700 ceiling `module-size-budgets.test.ts`
 * enforces. Notes and docs are the cleanest seam available — nine actions
 * that share one shape, touch only `board.notes`/`board.docs`, and are
 * entirely independent of the frame/selection/bulk machinery that makes up
 * the rest of the slice.
 *
 * ## The `null` contract, and why it is narrower than it looks
 *
 * `null` means "nothing to do", so `boardSlice.ts` can skip the `set()` call
 * rather than flipping `boardsDirty` for a no-op — same convention
 * `boardBulkFrameActions.ts` established.
 *
 * These functions deliberately reproduce the ORIGINAL dirty-flag behaviour
 * exactly, which is not uniform:
 *
 *   - `updateNoteText` / `setNoteColor` / `updateDocMarkdown` looked the
 *     target up first and returned early when it was missing → they return
 *     `null` here.
 *   - `moveNote` / `removeNote` / `moveDoc` / `removeDoc` did NOT — they
 *     called the core transform unconditionally and marked the board dirty
 *     even for an unknown id → they return a `Board` here, always.
 *
 * That asymmetry is inherited, not designed, and tightening it would change
 * when the 800 ms autosave in `AdminCanvasLayout` fires. `store-02` records
 * that the autosave path overwrites `boards.json` wholesale and has already
 * caused one data-loss incident, so this extraction is deliberately
 * behaviour-preserving: an unrelated dirty-semantics change does not belong
 * in a module-size fix. Tighten it in its own change, with its own test.
 */
import {
  upsertNote,
  moveNote as moveNoteOnBoard,
  removeNote as removeNoteFromBoard,
  upsertDoc,
  moveDoc as moveDocOnBoard,
  removeDoc as removeDocFromBoard,
  type Board,
  type DocBlock,
  type NoteColor,
  type StickyNote,
} from '@core/studio-board'

const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'
const DEFAULT_NOTE_WIDTH = 180
const DEFAULT_NOTE_HEIGHT = 120
const DEFAULT_DOC_WIDTH = 320
const DEFAULT_DOC_HEIGHT = 200

// --- sticky notes ---------------------------------------------------------

export function addNote(board: Board, x: number, y: number): Board {
  const note: StickyNote = {
    id: crypto.randomUUID(),
    x,
    y,
    w: DEFAULT_NOTE_WIDTH,
    h: DEFAULT_NOTE_HEIGHT,
    text: '',
    color: DEFAULT_NOTE_COLOR,
  }
  return upsertNote(board, note)
}

export function moveNote(board: Board, noteId: string, x: number, y: number): Board {
  return moveNoteOnBoard(board, noteId, x, y)
}

export function updateNoteText(board: Board, noteId: string, text: string): Board | null {
  const existing = board.notes.find((n) => n.id === noteId)
  if (!existing) return null
  return upsertNote(board, { ...existing, text })
}

export function setNoteColor(board: Board, noteId: string, color: NoteColor): Board | null {
  const existing = board.notes.find((n) => n.id === noteId)
  if (!existing) return null
  return upsertNote(board, { ...existing, color })
}

export function removeNote(board: Board, noteId: string): Board {
  return removeNoteFromBoard(board, noteId)
}

// --- doc blocks -----------------------------------------------------------

export function addDoc(board: Board, x: number, y: number): Board {
  const doc: DocBlock = {
    id: crypto.randomUUID(),
    x,
    y,
    w: DEFAULT_DOC_WIDTH,
    h: DEFAULT_DOC_HEIGHT,
    markdown: '',
  }
  return upsertDoc(board, doc)
}

export function moveDoc(board: Board, docId: string, x: number, y: number): Board {
  return moveDocOnBoard(board, docId, x, y)
}

export function updateDocMarkdown(board: Board, docId: string, markdown: string): Board | null {
  const existing = board.docs.find((d) => d.id === docId)
  if (!existing) return null
  return upsertDoc(board, { ...existing, markdown })
}

export function removeDoc(board: Board, docId: string): Board {
  return removeDocFromBoard(board, docId)
}
