/**
 * structuralHistory — the two halves of "undo a gesture that changed the
 * user's markup, not just its values" (`store-08`).
 *
 * The store's history is a stack of Mutative patch pairs, and for a VALUE edit
 * that is complete: `saveSite` diffs node values, so replaying the inverse
 * patch and letting the autosave write it out is a real, durable undo.
 *
 * A STRUCTURAL edit is not like that. `saveSite` has no notion of parent,
 * order or child list at all — that is exactly why `struct-01` gave moves,
 * deletes and inserts their own one-shot source commits. So replaying a move's
 * inverse patch changes the canvas and nothing else: the `.tsx` still says the
 * element moved, and the next reparse snaps the canvas back to it. The undo
 * has to be the INVERSE WRITE.
 *
 * `tagStructuralGesture` tags the entry the eager tree mutation already pushed
 * as a `source` gesture (the optimistic preview stays; its patches are never
 * replayed). A DELETE and a MOVE (single or sequence) are tagged this way, and
 * their ⌘Z is the undo journal's `restore` (P3-F) once the commit reports the
 * token: every file back byte for byte, including the blank line and the
 * indentation a move changes. Re-issuing `moveNodes` by position could not.
 */
import type { SiteSliceHelpers, StructuralHistory } from './types'

/**
 * Mark the transaction just committed by `mutateActiveTree` as structural.
 *
 * Called AFTER the mutation, because that is when the entry exists — and only
 * when the gesture actually issued a source write, so a CMS/Visual-Component
 * tree (nothing on disk to disagree with) keeps plain patch-replay undo.
 *
 * Also ends any in-progress coalescing burst: a structural gesture is never
 * part of a typing run, and folding one into a text burst would make a single
 * Ctrl+Z revert a drag and five keystrokes together.
 */
export function tagStructuralGesture(
  set: SiteSliceHelpers['set'],
  structural: StructuralHistory,
): void {
  set((state) => {
    const top = state._historyPast[state._historyPast.length - 1]
    if (!top) return
    top.structural = structural
    // `store-15` — a `source` gesture's undo is a WRITE (or nothing), never a
    // patch replay: `structuralSourceHistory.ts`'s own contract for the rest
    // of the family is "the entry carries empty inverse/forward patch lists".
    // `delete` is the one caller of this function that tags a `source`
    // gesture onto an entry that did NOT start that way — its patches are the
    // real tree mutation `mutateActiveTree` already committed, and they name
    // the exact node id this gesture just made permanently gone. Left
    // standing, `historyPreservation.ts`'s reload-safety check reads them as
    // a still-live reference and wipes the WHOLE stack on the very next
    // reparse — including this gesture's own resync, before its `fill` even
    // lands. Clearing them here is safe for every OTHER `source` gesture too:
    // `recordStructuralSourceWrite`'s `push` already builds them empty, so
    // this is a no-op for any entry that reaches this function through them.
    if (structural.gesture === 'source') {
      top.inverse = []
      top.forward = []
    }
    state._historyCoalesceKey = null
  })
}

/**
 * What one structural undo/redo step came to (`undoRedoActions.ts`'s
 * `runStructuralStep` reads it):
 *  - `posted` — a write is on its way; `pendingCommitId` is the id its
 *    rollback answers to (ERR-6), when the write carries one;
 *  - `skipped` — the step can never happen as recorded, so the entry is
 *    dropped rather than left to jam the stack (ERR-2, ERR-28). `notice` is
 *    the one sentence saying why, or `null` when the refusal has already been
 *    presented (the move gate's own toast or dialog).
 */
export type StructuralStepOutcome =
  | { kind: 'posted'; pendingCommitId: number | null }
  | { kind: 'skipped'; notice: string | null }
