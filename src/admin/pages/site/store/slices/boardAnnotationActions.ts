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
import { sanitizeBoardDocHtml } from '@core/sanitize'
import {
  upsertNote,
  moveNote as moveNoteOnBoard,
  removeNote as removeNoteFromBoard,
  upsertDoc,
  moveDoc as moveDocOnBoard,
  removeDoc as removeDocFromBoard,
  resizeAnnotation as resizeAnnotationOnBoard,
  reorderAnnotations as reorderAnnotationsOnBoard,
  DEFAULT_DOC_WIDTH,
  DEFAULT_DOC_HEIGHT,
  type AnnotationRef,
  type Board,
  type DocBlock,
  type NoteColor,
  type StickyNote,
} from '@core/studio-board'

const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'
const DEFAULT_NOTE_WIDTH = 180
const DEFAULT_NOTE_HEIGHT = 120

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
    html: '',
  }
  return upsertDoc(board, doc)
}

export function moveDoc(board: Board, docId: string, x: number, y: number): Board {
  return moveDocOnBoard(board, docId, x, y)
}

/**
 * Sanitizes before storing — this is the WRITE boundary for a doc card's rich
 * text, so nothing unsanitized ever reaches `boards.json`. `DocBlockView`
 * sanitizes again on render, which covers a hand-edited file that never went
 * through here.
 */
export function updateDocHtml(board: Board, docId: string, html: string): Board | null {
  const existing = board.docs.find((d) => d.id === docId)
  if (!existing) return null
  const clean = sanitizeBoardDocHtml(html)
  if (clean === existing.html) return null
  return upsertDoc(board, { ...existing, html: clean })
}

export function removeDoc(board: Board, docId: string): Board {
  return removeDocFromBoard(board, docId)
}

// --- shared: geometry, stacking, duplication ------------------------------

export function resizeAnnotation(
  board: Board,
  ref: AnnotationRef,
  rect: { x: number; y: number; w: number; h: number },
): Board {
  return resizeAnnotationOnBoard(board, ref, rect)
}

export function reorderAnnotations(
  board: Board,
  refs: readonly AnnotationRef[],
  to: 'front' | 'back',
): Board | null {
  if (refs.length === 0) return null
  return reorderAnnotationsOnBoard(board, refs, to)
}

export function removeAnnotations(board: Board, refs: readonly AnnotationRef[]): Board | null {
  if (refs.length === 0) return null
  return refs.reduce(
    (acc, ref) => (ref.kind === 'note' ? removeNoteFromBoard(acc, ref.id) : removeDocFromBoard(acc, ref.id)),
    board,
  )
}

/** Board-unit offset a duplicate or paste lands at, so the copy is visibly its own object rather than hidden exactly under the original. Matches the diagonal nudge Figma and Miro both use. */
export const ANNOTATION_CLONE_OFFSET = 24

/**
 * Copies `refs` onto the board, offset by `ANNOTATION_CLONE_OFFSET`, and
 * returns the new board plus refs to the copies — the caller selects them, so
 * a duplicate leaves you holding the duplicate (and a second Cmd+D walks
 * diagonally) rather than the original.
 *
 * The copies are appended, so they paint above their sources without needing
 * an explicit `z`; a source that HAS a `z` passes it on, keeping a raised
 * annotation's copy raised too.
 */
export function duplicateAnnotations(
  board: Board,
  refs: readonly AnnotationRef[],
  offset = ANNOTATION_CLONE_OFFSET,
): { board: Board; created: AnnotationRef[] } | null {
  if (refs.length === 0) return null
  const created: AnnotationRef[] = []
  const next = refs.reduce((acc, ref) => {
    if (ref.kind === 'note') {
      const source = acc.notes.find((n) => n.id === ref.id)
      if (!source) return acc
      const id = crypto.randomUUID()
      created.push({ kind: 'note', id })
      return upsertNote(acc, { ...source, id, x: source.x + offset, y: source.y + offset })
    }
    const source = acc.docs.find((d) => d.id === ref.id)
    if (!source) return acc
    const id = crypto.randomUUID()
    created.push({ kind: 'doc', id })
    return upsertDoc(acc, { ...source, id, x: source.x + offset, y: source.y + offset })
  }, board)
  if (created.length === 0) return null
  return { board: next, created }
}

/**
 * Pastes previously-copied annotation VALUES (not refs — the source may have
 * been deleted, or come from another board) at `offset` from where they were
 * copied. Fresh ids are minted so a repeated paste never collides.
 */
export function pasteAnnotations(
  board: Board,
  clipboard: { notes: readonly StickyNote[]; docs: readonly DocBlock[] },
  offset: number,
): { board: Board; created: AnnotationRef[] } | null {
  const created: AnnotationRef[] = []
  let next = board
  for (const note of clipboard.notes) {
    const id = crypto.randomUUID()
    created.push({ kind: 'note', id })
    next = upsertNote(next, { ...note, id, x: note.x + offset, y: note.y + offset })
  }
  for (const doc of clipboard.docs) {
    const id = crypto.randomUUID()
    created.push({ kind: 'doc', id })
    next = upsertDoc(next, { ...doc, id, x: doc.x + offset, y: doc.y + offset })
  }
  if (created.length === 0) return null
  return { board: next, created }
}

/** Move `refs` by a board-unit delta — the arrow-key nudge. */
export function nudgeAnnotations(board: Board, refs: readonly AnnotationRef[], dx: number, dy: number): Board | null {
  if (refs.length === 0) return null
  return refs.reduce((acc, ref) => {
    if (ref.kind === 'note') {
      const source = acc.notes.find((n) => n.id === ref.id)
      return source ? moveNoteOnBoard(acc, ref.id, source.x + dx, source.y + dy) : acc
    }
    const source = acc.docs.find((d) => d.id === ref.id)
    return source ? moveDocOnBoard(acc, ref.id, source.x + dx, source.y + dy) : acc
  }, board)
}
