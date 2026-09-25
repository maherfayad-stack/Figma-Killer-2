/**
 * journaledUndo — the undo entry for an instance rewrite the Properties panel
 * posts on its own (detach, swap, extract), outside `commitStructural`
 * (DET-4, P3-F).
 *
 * Those three used to push NO entry: ⌘Z after a detach silently undid
 * whatever came before it, and the rewrite itself could only be taken back
 * with `git`. Their undo is the server's undo journal — the write's own
 * `undoToken`, posted back as a `restore` — so the entry can be pushed the
 * moment the response arrives: the inverse names no element, so there is
 * nothing for the board's re-read to resolve first.
 *
 * `forward` is what a redo re-posts; its write records a fresh token, which
 * the resync resolves into the entry's inverse (`restore-journal`). An
 * extract has no `/save` edit to re-post, so its `forward` is empty and redo
 * says so.
 *
 * No token (the server could not journal the write — `undoJournal.ts` says
 * when): the entry is still pushed, with no inverse, so ⌘Z lands on it and
 * says it cannot rather than undoing something older.
 */
import { useEditorStore } from '@site/store/store'
import { restoreEdit, type StructuralEditPayload } from './structuralUndoPlan'

export function recordJournaledWrite(label: string, forward: StructuralEditPayload[], undoToken: string | undefined): void {
  useEditorStore.getState().recordStructuralSourceWrite({
    kind: 'push',
    gesture: {
      label,
      forward,
      inverseTemplate: { kind: 'restore-journal' },
      inverse: undoToken === undefined ? null : [restoreEdit(undoToken)],
    },
  })
}
