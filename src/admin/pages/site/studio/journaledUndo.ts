/**
 * journaledUndo — the undo entry for an instance rewrite the Properties panel
 * posts on its own (swap, extract), outside `commitStructural` (DET-4, P3-F).
 * A detach is not one of them any more: P5-C's `detachInstances` commits it
 * through `commitStructural` with the same `restore-journal` template.
 *
 * Those used to push NO entry: ⌘Z after a detach silently undid
 * whatever came before it, and the rewrite itself could only be taken back
 * with `git`. Their undo is the server's undo journal — the write's own
 * `undoToken`, posted back as a `restore`.
 *
 * The entry rides the re-read the write already requests
 * (`requestCmsSiteReload({ structuralOutcome })`, ERR-10), exactly like every
 * other source gesture's: it lands with the board that describes the file the
 * write left, and this module never has to import the store.
 *
 * `forward` is what a redo re-posts; its write records a fresh token, which
 * the resync resolves into the entry's inverse (`restore-journal`). An
 * extract has no `/save` edit to re-post, so its `forward` is empty and redo
 * says so.
 *
 * No token (the server could not journal the write — `undoJournal.ts` says
 * when): the entry is still pushed, with no inverse, so ⌘Z lands on it and
 * says it cannot rather than passing over it silently.
 */
import type { PendingStructuralOutcome } from './pendingStructuralOutcome'
import { restoreEdit, type StructuralEditPayload } from './structuralUndoPlan'

export function journaledWriteOutcome(
  label: string,
  forward: StructuralEditPayload[],
  undoToken: string | undefined,
): PendingStructuralOutcome {
  return {
    selectNodeIds: [],
    history: {
      kind: 'push',
      gesture: {
        label,
        forward,
        inverseTemplate: { kind: 'restore-journal' },
        inverse: undoToken === undefined ? null : [restoreEdit(undoToken)],
      },
    },
  }
}
