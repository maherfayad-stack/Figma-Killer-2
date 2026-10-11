/**
 * pendingGestures — gestures that are PAINTED but not yet COMMITTED.
 *
 * A burst of arrow taps (or any gesture that previews on the canvas and writes
 * the store once it settles — `useCanvasNodeArrowKeys`) holds its edit in a
 * transient preview for a few hundred ms so the burst is one undo entry and
 * one source write. That window must never let a LATER edit overtake it: an
 * undo pressed 100 ms after the last tap must undo the nudge, and an
 * inspector edit made right after must land on top of it, not under it.
 *
 * So the store flushes every registered gesture before it records anything
 * else: `runHistoricMutation`, `commitBoardChange`, `undo` and `redo` call
 * {@link flushPendingGestures} first. A flush COMMITS the gesture (it does not
 * cancel it) and unregisters it; the commit's own store write then finds
 * nothing left to flush, so there is no re-entry.
 *
 * Leaf module: it imports nothing, so the store can depend on it without the
 * canvas depending back on the store's internals.
 */

const pending = new Set<() => void>()

/** Registers a gesture's commit. Returns the unregister function — call it when the gesture commits on its own. */
export function registerPendingGesture(commit: () => void): () => void {
  pending.add(commit)
  return () => {
    pending.delete(commit)
  }
}

/** Commits every gesture that is still waiting on its settle timer, oldest first. */
export function flushPendingGestures(): void {
  if (pending.size === 0) return
  const commits = [...pending]
  pending.clear()
  for (const commit of commits) commit()
}
