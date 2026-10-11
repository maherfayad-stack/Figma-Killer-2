/**
 * pendingStructuralOutcome — what a structural source write means for the
 * board once the board has read it back.
 *
 * A structural gesture on a studio-imported board mints nothing on the canvas:
 * the element does not exist until the codemod has written it, and its id is
 * the `line:col` that write produces (`studioSourceWrites.ts`'s own contract).
 * `store-13` made the server report the ids it CREATED, and `store-14` the ids
 * it RELOCATED, but neither can be acted on when the commit resolves — only
 * once the re-read has put a node with that id in the store.
 *
 * ## It travels WITH its re-read (ERR-10)
 *
 * This used to be a one-slot, expiring global box that "whichever re-read
 * lands next" drained. Two ways that lost an outcome: a later commit's answer
 * overwrote an earlier one's before its full reload had landed (the full
 * reload was fire-and-forget, so the queue ran the next gesture first), and an
 * unrelated re-read (an agent's live-reload patch) landing in the window
 * claimed it against a tree that did not contain the write yet — recording an
 * undo entry whose ids the commit's own resync then re-addressed as if they
 * were pre-write ids.
 *
 * Now `commitStructuralBody` hands the outcome to `resyncBoardAfterWrite`,
 * which puts it on the exact re-read it triggers: the narrow patch's event
 * detail (`CmsSitePagesPatchDetail.structuralOutcome`) or the full reload's
 * request (`requestCmsSiteReload({ structuralOutcome })`). `siteReloadApply.ts`
 * applies it after that re-read's `patchPages`/`loadSite`, and nowhere else.
 * No expiry is needed: an outcome whose re-read never happens is dropped with
 * it, instead of waiting to act on some unrelated reload later.
 *
 * ## Two answers, one value
 *
 * What to select and what ⌘Z should do depend on the same thing — what the
 * write reported making — and are applied at the same moment, after the
 * re-read and in order. Keeping them in one value means a re-read cannot apply
 * one and drop the other.
 */
import type { StructuralSourceGesture, StructuralWriteOutcome } from './structuralUndoPlan'

/**
 * What the re-read should do to the undo stack.
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
