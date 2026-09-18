/**
 * pendingCreatedSelection — the one-slot handoff between "the source write
 * that just created an element" and "the board reading that element back".
 *
 * ## Why a box and not a callback
 *
 * A structural gesture on a studio-imported board mints nothing on the canvas:
 * the element does not exist until the codemod has written it, and its id is
 * the `line:col` that write produces (`studioSourceWrites.ts`'s own contract).
 * `store-13` made the server report those ids, but they still cannot be
 * SELECTED at the moment the commit resolves — the board is re-read
 * afterwards, through either `patchPages` (the narrow path, dispatched as an
 * admin event) or a full `loadSite()` (fire-and-forget), and only then does a
 * node with that id exist in the store at all.
 *
 * A callback would have to reach the store from `studioStructuralCommits.ts`,
 * which is inside the store's OWN build graph (`store.ts -> nodeActions.ts ->
 * studioStructuralCommits.ts`). Importing `useEditorStore` there closes a
 * cycle — the same one `adminEvents.ts` documents and exists to break. So the
 * commit leaves its answer in this leaf module, and `usePersistence.ts` (which
 * already owns both re-read paths, and already has store access) drains it the
 * moment the new pages are in.
 *
 * ## One slot, and an expiry
 *
 * ONE slot, replaced rather than appended: two structural commits in flight is
 * already refused (`guardAgainstConcurrentStructuralCommit`), and if a later
 * gesture somehow does overtake an earlier one, the last thing the user asked
 * for is the right thing to select.
 *
 * The expiry is what keeps this from acting at a distance. A commit whose
 * re-read never arrives (the editor unmounted, the reload failed) must not
 * leave an id sitting here to be applied to some unrelated reload minutes
 * later — selecting something the user did not just make is worse than
 * selecting nothing.
 */

/** How long a created-selection stays claimable. A resync is a fetch plus a parse, not a user's think time. */
const PENDING_SELECTION_TTL_MS = 30_000

interface PendingCreatedSelection {
  nodeIds: readonly string[]
  expiresAt: number
}

let pending: PendingCreatedSelection | null = null

/**
 * Record the ids a structural write just created, for the board re-read that
 * is about to bring them in. An empty list clears the slot — a commit that
 * created nothing must not leave the previous one's answer standing.
 */
export function setPendingCreatedSelection(nodeIds: readonly string[], now = Date.now()): void {
  pending = nodeIds.length > 0 ? { nodeIds: [...nodeIds], expiresAt: now + PENDING_SELECTION_TTL_MS } : null
}

/**
 * Take whatever is waiting, clearing the slot. Returns an empty array when
 * nothing is pending or the wait expired — see this module's own doc for why
 * an expired entry is dropped rather than applied late.
 */
export function takePendingCreatedSelection(now = Date.now()): readonly string[] {
  const claimed = pending
  pending = null
  if (!claimed || claimed.expiresAt <= now) return []
  return claimed.nodeIds
}

/** Test seam: drop anything waiting, so one spec cannot hand its answer to the next. */
export function clearPendingCreatedSelection(): void {
  pending = null
}
