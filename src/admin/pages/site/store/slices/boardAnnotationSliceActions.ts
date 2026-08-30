/**
 * boardAnnotationSliceActions — the `set`/`get` wiring for every sticky-note
 * and doc-card action, plus the annotation SELECTION and CLIPBOARD state those
 * actions operate on.
 *
 * Two sibling modules already split this concern in half; this is the third
 * and it closes the seam:
 *   - `boardAnnotationActions.ts` holds the pure `Board -> Board | null`
 *     transforms (no store, unit-testable on a plain `Board`).
 *   - this module holds the store wiring for them, the same way
 *     `boardFrameSelectionActions.ts` holds the store wiring for frame
 *     selection.
 * `boardSlice.ts` composes both and stays the board/frame slice its name
 * promises. The split is what keeps that file under the 700-line
 * `module-size-budgets` ceiling it was sitting exactly on.
 *
 * ## Why annotation selection is its own state, not `selectedFrameIds`
 *
 * `selectedFrameIds` is a list of PAGE ids — a frame IS a page, so a page id
 * identifies it. A note and a doc share neither an id space nor a kind, so an
 * annotation is addressed by `AnnotationRef` (`{ kind, id }`) and the two
 * selections are separate lists. They are also mutually exclusive with the
 * node and frame selections, for the reason `boardFrameSelectionActions.ts`
 * gives: the Properties panel shows exactly one inspector, so selecting a note
 * must clear whatever else was selected.
 *
 * This module also owns `clearAllSelections`, the "nothing is selected"
 * policy. It spans all three lists — nodes, board frames, annotations — and it
 * lives here because this is already the module that knows how the three
 * relate (see `setSelection` below). Two call sites need it, an empty-canvas
 * click and Escape, and spelling it out at both is how they drift apart: the
 * annotation list was added to one and forgotten in the other exactly once.
 *
 * ## The clipboard holds VALUES, not refs
 *
 * Copy snapshots the notes/docs themselves. A ref would dangle the moment the
 * source is deleted (copy → delete → paste is an ordinary sequence) and would
 * not survive a board switch, which is exactly when pasting furniture is most
 * useful.
 */
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import {
  getActiveBoard,
  upsertBoard,
  type AnnotationRef,
  type Board,
  type DocBlock,
  type StickyNote,
} from '@core/studio-board'
import * as annotations from './boardAnnotationActions'

/** A snapshot of copied annotations. See the module doc for why this holds values rather than refs. */
export interface AnnotationClipboard {
  notes: StickyNote[]
  docs: DocBlock[]
}

export const EMPTY_ANNOTATION_CLIPBOARD: AnnotationClipboard = { notes: [], docs: [] }

export function annotationRefKey(ref: AnnotationRef): string {
  return `${ref.kind}:${ref.id}`
}

export function isAnnotationSelected(selected: readonly AnnotationRef[], ref: AnnotationRef): boolean {
  const key = annotationRefKey(ref)
  return selected.some((r) => annotationRefKey(r) === key)
}

type AnnotationActions = Pick<
  EditorStore,
  | 'addNote'
  | 'moveNote'
  | 'updateNoteText'
  | 'setNoteColor'
  | 'removeNote'
  | 'addDoc'
  | 'moveDoc'
  | 'updateDocHtml'
  | 'removeDoc'
  | 'resizeAnnotation'
  | 'selectAnnotation'
  | 'setSelectedAnnotations'
  | 'clearAnnotationSelection'
  | 'deleteSelectedAnnotations'
  | 'duplicateSelectedAnnotations'
  | 'copySelectedAnnotations'
  | 'pasteAnnotations'
  | 'nudgeSelectedAnnotations'
  | 'reorderSelectedAnnotations'
  | 'clearAllSelections'
>

type Set = Parameters<EditorStoreSliceCreator<EditorStore>>[0]
type Get = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

export function createAnnotationActions(set: Set, get: Get): AnnotationActions {
  /** Apply a pure transform to the active board. `null`/absent board = no-op, so `boardsDirty` never flips for nothing. */
  const withBoard = (transform: (board: Board) => Board | null) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const next = transform(board)
    if (!next) return
    set({ boards: upsertBoard(boards, next), boardsDirty: true })
  }

  /**
   * Replace the annotation selection.
   *
   * `clearOthers` distinguishes the two ways a selection is made, which
   * genuinely want different behaviour:
   *   - CLICKING an annotation (`selectAnnotation`) says "this one thing" —
   *     it clears the node and frame selections, so exactly one kind of object
   *     is selected and the Properties panel shows one inspector. Same rule
   *     `boardFrameSelectionActions.ts` applies when a frame is clicked.
   *   - MARQUEEING a region (`setSelectedAnnotations`) says "everything in
   *     here", and a region can legitimately contain both frames and notes.
   *     Clearing there would make one drag silently discard half of what it
   *     just swept over, depending on the order the two setters ran in.
   */
  const setSelection = (refs: AnnotationRef[], clearOthers: boolean) => {
    set((state) => {
      state.selectedAnnotations = refs
      if (refs.length === 0 || !clearOthers) return
      if (state.selectedNodeIds.length > 0) {
        state.selectedNodeIds = []
        state.selectedNodeId = null
      }
      if (state.selectedFrameIds.length > 0) state.selectedFrameIds = []
    })
  }

  return {
    addNote: (x, y) => withBoard((board) => annotations.addNote(board, x, y)),
    moveNote: (noteId, x, y) => withBoard((board) => annotations.moveNote(board, noteId, x, y)),
    updateNoteText: (noteId, text) => withBoard((board) => annotations.updateNoteText(board, noteId, text)),
    setNoteColor: (noteId, color) => withBoard((board) => annotations.setNoteColor(board, noteId, color)),
    removeNote: (noteId) => withBoard((board) => annotations.removeNote(board, noteId)),

    addDoc: (x, y) => withBoard((board) => annotations.addDoc(board, x, y)),
    moveDoc: (docId, x, y) => withBoard((board) => annotations.moveDoc(board, docId, x, y)),
    updateDocHtml: (docId, html) => withBoard((board) => annotations.updateDocHtml(board, docId, html)),
    removeDoc: (docId) => withBoard((board) => annotations.removeDoc(board, docId)),

    resizeAnnotation: (ref, rect) => withBoard((board) => annotations.resizeAnnotation(board, ref, rect)),

    selectAnnotation: (ref, mode = 'replace') => {
      const { selectedAnnotations } = get()
      const key = annotationRefKey(ref)
      const next =
        mode === 'toggle'
          ? isAnnotationSelected(selectedAnnotations, ref)
            ? selectedAnnotations.filter((r) => annotationRefKey(r) !== key)
            : [...selectedAnnotations, ref]
          : [ref]
      setSelection(next, true)
    },

    setSelectedAnnotations: (refs) => setSelection([...refs], false),

    clearAnnotationSelection: () => {
      if (get().selectedAnnotations.length === 0) return
      set({ selectedAnnotations: [] })
    },

    deleteSelectedAnnotations: () => {
      const refs = get().selectedAnnotations
      withBoard((board) => annotations.removeAnnotations(board, refs))
      if (refs.length > 0) set({ selectedAnnotations: [] })
    },

    duplicateSelectedAnnotations: () => {
      const { boards, activeBoardId, selectedAnnotations } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      const result = annotations.duplicateAnnotations(board, selectedAnnotations)
      if (!result) return
      // Select the COPIES: a duplicate leaves you holding what you just made,
      // so a second Cmd+D walks diagonally instead of stacking clones on one
      // spot.
      set({ boards: upsertBoard(boards, result.board), boardsDirty: true, selectedAnnotations: result.created })
    },

    copySelectedAnnotations: () => {
      const { boards, activeBoardId, selectedAnnotations } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board || selectedAnnotations.length === 0) return
      const keys = new Set(selectedAnnotations.map(annotationRefKey))
      set({
        annotationClipboard: {
          notes: board.notes.filter((n) => keys.has(annotationRefKey({ kind: 'note', id: n.id }))),
          docs: board.docs.filter((d) => keys.has(annotationRefKey({ kind: 'doc', id: d.id }))),
        },
        // A fresh copy restarts the paste ladder — the first paste of NEW
        // content belongs one step off its source, not N steps off wherever
        // the previous clipboard's last paste happened to land.
        annotationPasteCount: 0,
      })
    },

    pasteAnnotations: () => {
      const { boards, activeBoardId, annotationClipboard, annotationPasteCount } = get()
      const board = getActiveBoard(boards, activeBoardId)
      if (!board) return
      // Each successive paste of the SAME clipboard steps further out, so
      // pasting three times gives three visible cards rather than one visible
      // card with two hidden underneath.
      const offset = annotations.ANNOTATION_CLONE_OFFSET * (annotationPasteCount + 1)
      const result = annotations.pasteAnnotations(board, annotationClipboard, offset)
      if (!result) return
      set({
        boards: upsertBoard(boards, result.board),
        boardsDirty: true,
        selectedAnnotations: result.created,
        annotationPasteCount: annotationPasteCount + 1,
      })
    },

    nudgeSelectedAnnotations: (dx, dy) => {
      const refs = get().selectedAnnotations
      withBoard((board) => annotations.nudgeAnnotations(board, refs, dx, dy))
    },

    reorderSelectedAnnotations: (to) => {
      const refs = get().selectedAnnotations
      withBoard((board) => annotations.reorderAnnotations(board, refs, to))
    },

    clearAllSelections: () => {
      const state = get()
      if (state.selectedNodeIds.length > 0 || state.selectedNodeId !== null) state.clearSelection()
      if (state.selectedFrameIds.length > 0) state.clearFrameSelection()
      if (state.selectedAnnotations.length > 0) set({ selectedAnnotations: [] })
    },
  }
}
