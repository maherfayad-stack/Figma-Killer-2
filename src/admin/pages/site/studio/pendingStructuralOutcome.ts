/**
 * pendingStructuralOutcome — the one-slot handoff between "the source write
 * that just changed the user's markup" and "the board reading that markup
 * back".
 *
 * ## Why a box and not a callback
 *
 * A structural gesture on a studio-imported board mints nothing on the canvas:
 * the element does not exist until the codemod has written it, and its id is
 * the `line:col` that write produces (`studioSourceWrites.ts`'s own contract).
 * `store-13` made the server report the ids it CREATED, and `store-14` the
 * ids it RELOCATED, but neither can be acted on at the moment the commit
 * resolves — the board is re-read afterwards, through either `patchPages` (the
 * narrow path, dispatched as an admin event) or a full `loadSite()`
 * (fire-and-forget), and only then does a node with that id exist in the store
 * at all.
 *
 * A callback would have to reach the store from `studioStructuralCommits.ts`,
 * which is inside the store's OWN build graph (`store.ts -> nodeActions.ts ->
 * studioStructuralCommits.ts`). Importing `useEditorStore` there closes a
 * cycle — the same one `adminEvents.ts` documents and exists to break. So the
 * commit leaves its answer in this leaf module, and `usePersistence.ts` (which
 * already owns both re-read paths, and already has store access) drains it the
 * moment the new pages are in.
 *
 * ## Two answers, one box
 *
 * The slot used to carry only "select these ids" (it was `pendingCreatedSelection.ts`).
 * It now carries the gesture's UNDO as well, because both answers depend on the
 * same thing — what the write reported making — and both have to be applied at
 * the same moment, after the re-read and in one store transaction. Splitting
 * them into two boxes would let a reload claim one and drop the other.
 *
 * ## One slot, and an expiry
 *
 * ONE slot, replaced rather than appended: only one structural commit is ever
 * on the wire (`structuralCommitQueue.ts` serializes them), and if a later
 * gesture somehow does overtake an earlier one, the last thing the user asked
 * for is the right thing to select.
 *
 * The expiry is what keeps this from acting at a distance. A commit whose
 * re-read never arrives (the editor unmounted, the reload failed) must not
 * leave an id sitting here to be applied to some unrelated reload minutes
 * later — selecting something the user did not just make, or pushing an undo
 * entry for a gesture they have forgotten, is worse than doing nothing.
 */
import type { StructuralSourceGesture, StructuralWriteOutcome } from './structuralUndoPlan'

/** How long a pending outcome stays claimable. A resync is a fetch plus a parse, not a user's think time. */
const PENDING_OUTCOME_TTL_MS = 30_000

/**
 * What the drain should do to the undo stack.
 *
 * - `push` — an ordinary gesture that mutated NO tree at gesture time: a new
 *   entry, one ⌘Z.
 * - `fill` (`store-15`) — a `delete`'s own forward commit. `delete` DOES
 *   mutate the tree at gesture time (`deleteNodesAction.ts`'s optimistic
 *   removal), so an entry already exists — `tagStructuralGesture` tagged it
 *   synchronously, before this write's outcome was known, with `inverse:
 *   null`. This fills that SAME entry's `source.inverse` in from what the
 *   write reported, rather than pushing a second one for a gesture that only
 *   happened once.
 * - `refresh` — this commit WAS an undo or a redo re-issuing a stored entry.
 *   The stack bookkeeping already happened in `undoRedoActions.ts`; what is
 *   left is to re-resolve the entry's inverse against the ids this re-issue
 *   reported, so the next step in the same direction addresses the elements
 *   that exist now.
 */
export type PendingStructuralHistory =
  | { kind: 'push'; gesture: StructuralSourceGesture }
  | { kind: 'fill'; outcome: StructuralWriteOutcome }
  | { kind: 'refresh'; direction: 'undo' | 'redo'; outcome: StructuralWriteOutcome }

export interface PendingStructuralOutcome {
  /** Ids to put the selection on once they resolve — what the gesture created, or where it moved what it moved. */
  selectNodeIds: readonly string[]
  /** What the gesture means for the undo stack, or `null` when it is not an undoable structural write. */
  history: PendingStructuralHistory | null
}

interface StoredOutcome extends PendingStructuralOutcome {
  expiresAt: number
}

let pending: StoredOutcome | null = null

/**
 * Record what the structural write that just landed means for the board
 * re-read that is about to happen. Replaces whatever was there — a commit that
 * created nothing and changed no history must not leave the previous one's
 * answer standing.
 */
export function setPendingStructuralOutcome(outcome: PendingStructuralOutcome, now = Date.now()): void {
  pending =
    outcome.selectNodeIds.length === 0 && outcome.history === null
      ? null
      : { selectNodeIds: [...outcome.selectNodeIds], history: outcome.history, expiresAt: now + PENDING_OUTCOME_TTL_MS }
}

/**
 * Take whatever is waiting, clearing the slot. Returns `null` when nothing is
 * pending or the wait expired — see this module's own doc for why an expired
 * entry is dropped rather than applied late.
 */
export function takePendingStructuralOutcome(now = Date.now()): PendingStructuralOutcome | null {
  const claimed = pending
  pending = null
  if (!claimed || claimed.expiresAt <= now) return null
  return { selectNodeIds: claimed.selectNodeIds, history: claimed.history }
}

/** Test seam: drop anything waiting, so one spec cannot hand its answer to the next. */
export function clearPendingStructuralOutcome(): void {
  pending = null
}
