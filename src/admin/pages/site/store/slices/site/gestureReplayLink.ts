/**
 * gestureReplayLink — the three small pieces every "do a write first, then
 * replay the gesture the user tried" flow shares: link the preparatory write's
 * history entry to the replay's so ONE ⌘Z undoes both, unlink it again when
 * the replay landed nothing, and wait until no structural write is on the wire.
 *
 * Born in OD-7 (`instanceOnlyGesture.ts`: detach, then replay) and reused,
 * unchanged, by G-9's "Unroll list" and G-8's "Edit layout" replays
 * (`unrollListActions.ts`, `layoutEditMode.ts`).
 */
import { isStructuralCommitInFlight, subscribeStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { EditorStore } from '@site/store/types'
import type { EditorStoreSetter } from './types'

/**
 * Mark the entry at `at` (the preparatory write) as undone WITH the one above
 * it. Set BEFORE the replay runs, not after it lands: a ⌘Z pressed while the
 * replay is still being written waits for that write and then runs at once —
 * before any code after the write could still link.
 */
export function linkReplay(get: () => EditorStore, set: EditorStoreSetter, at: number, linked: boolean): void {
  if (!get()._historyPast[at]) return
  set((state) => {
    const entry = state._historyPast[at]
    if (!entry) return
    if (linked) entry.linkedToNext = true
    else delete entry.linkedToNext
  })
}

/** The replay pushed no entry of its own (refused, or nothing to write): the link has nothing to join. */
export function unlinkIfNothingLanded(get: () => EditorStore, set: EditorStoreSetter, at: number): void {
  const past = get()._historyPast
  if (past[at]?.linkedToNext && !past[at + 1]?.structural) linkReplay(get, set, at, false)
}

/** Resolves once no structural write is on the wire — the replayed gesture's own write included. */
export function structuralWritesIdle(): Promise<void> {
  if (!isStructuralCommitInFlight()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = subscribeStructuralCommitInFlight(() => {
      if (isStructuralCommitInFlight()) return
      unsubscribe()
      resolve()
    })
  })
}
