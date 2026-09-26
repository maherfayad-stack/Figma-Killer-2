/**
 * structuralCommitQueue — one structural write on the wire at a time, and
 * every gesture that arrives while it is in flight runs next instead of being
 * thrown away.
 *
 * ## What this replaces, and why
 *
 * `store-11` found a real race: `insert`/`duplicate`/`wrap`/`group`/`ungroup`/
 * `paste` mint NOTHING on the canvas — the element does not exist until the
 * codemod has written it, and its id is the `line:col` that write produces —
 * so a second gesture fired before the first one's resync plans against the
 * still-unshifted original and posts a SECOND real write. Two honest-looking
 * successes, one gesture.
 *
 * The first fix was a REFUSAL: a second gesture while one was in flight got
 * "Still writing your last change" and never touched the network. `verify-3`
 * then measured what that feels like — ⌘D five times inside 300 ms writes ONE
 * copy, with the four refusals collapsed onto a single warning card. Z1 was
 * working; the gesture was not. A designer who presses a key five times has
 * asked for five things.
 *
 * So the serialization stays and the refusal goes. A gesture that arrives
 * mid-flight is parked here as a THUNK and re-run the moment the queue is
 * clear. The race is still closed — nothing is planned against an unshifted
 * tree, because a parked gesture re-reads the tree and re-plans from scratch
 * when it runs — and the five presses become five writes.
 *
 * ## A thunk, not a pre-planned edit
 *
 * Parking the already-planned `StudioEdit` would reintroduce exactly the bug
 * the guard closed: the plan names `rel:line:col` ids, and the commit ahead of
 * it in the queue is about to move them. The thunk re-enters the gesture's own
 * writer, which re-reads the tree the resync just replaced, re-runs every
 * refusal gate, and posts against ids that are current. A gesture whose target
 * no longer exists therefore refuses by name rather than writing somewhere
 * else.
 *
 * ## …and the ids it names are re-found, not re-read (P1-A, ERR-4)
 *
 * Re-planning against the fresh tree is only honest if the ids handed to the
 * re-plan still name what the user acted on. They do not, in general: the
 * commit ahead renumbered the file, so a Delete pressed on `a.tsx:5:5` while a
 * move was in flight would re-run as "delete whatever is at 5:5 now" — the
 * element that just MOVED there (the audit reproduced exactly that). So the
 * queue captures each id's identity when the gesture is made
 * (`sourceIdentity.ts`), and hands the thunk a `relocate` that re-finds each
 * one by that identity in the re-read board. When any cannot be found exactly
 * once, the gesture does not run, and says so once — a guess is how the wrong
 * element got written.
 *
 * ## The ceiling
 *
 * A held ⌘D auto-repeats about thirty times a second and each commit is a POST
 * plus a re-parse, so an unbounded queue would keep writing copies for a
 * minute after the key came up — the plan's habit 2 ("loops have no ceilings")
 * wearing a new hat. {@link MAX_DEFERRED_STRUCTURAL_GESTURES} bounds it.
 *
 * ERR-25 — the overflow is dropped WITHOUT a toast. The only way to get past
 * twenty queued gestures is a held key auto-repeating, and what the person
 * sees is right: the copies keep appearing while the writer catches up, and
 * the extra repeats simply do not happen, exactly as a held key past a
 * program's own limit does anywhere else. "Too many changes at once" blamed
 * the user for holding a key. Logged for devtools.
 */
import { pushToast } from '@ui/components/Toast'
import { captureIdentities, relocateCapturedIds } from './sourceIdentity'
import { listRowRemapGeneration, remapListRowId } from './listRowRemap'

/**
 * How many gestures may wait behind the one on the wire.
 *
 * Sized for a hand, not for a held key: a fast deliberate burst is five to ten
 * presses, and twenty is comfortably past anything a person means while still
 * bounding a stuck key to under a second of extra writing.
 */
export const MAX_DEFERRED_STRUCTURAL_GESTURES = 20

/**
 * True from the moment a structural commit starts posting until its resync (or
 * refusal) has fully resolved.
 *
 * Read by the toolbar's save-status chip (Z6) through
 * {@link subscribeStructuralCommitInFlight}: a structural commit bypasses the
 * autosave path entirely, so without this the chip would read "Saved" during
 * the one write most likely to be slow.
 */
let structuralCommitInFlight = false
const inFlightListeners = new Set<() => void>()
const deferred: (() => void)[] = []

/** A parked gesture's view of its own ids after the commit ahead of it re-read the board: where each element it named is NOW. */
export type RelocateNodeId = (nodeId: string) => string

export function isStructuralCommitInFlight(): boolean {
  return structuralCommitInFlight
}

/** Subscribe to in-flight transitions. Returns an unsubscribe fn. Read through `useSyncExternalStore`. */
export function subscribeStructuralCommitInFlight(listener: () => void): () => void {
  inFlightListeners.add(listener)
  return () => {
    inFlightListeners.delete(listener)
  }
}

function setStructuralCommitInFlight(next: boolean): void {
  if (structuralCommitInFlight === next) return
  structuralCommitInFlight = next
  for (const listener of inFlightListeners) listener()
}

/** Called by `commitStructural` before its first `await`, so the flag is true by the time the synchronous caller returns. */
export function beginStructuralCommit(): void {
  setStructuralCommitInFlight(true)
}

/**
 * Called by `commitStructural` once its resync (or refusal) has resolved.
 * Clears the flag and immediately runs whatever was parked behind it.
 *
 * The drain is SYNCHRONOUS rather than scheduled: between clearing the flag
 * and starting the next gesture there must be no window in which a fresh
 * gesture can jump the queue, or a burst would land out of order. It is a loop
 * rather than a single shift because a parked gesture can be REFUSED — that
 * posts nothing, leaves the flag down, and must not strand the rest of the
 * burst. There is no recursion: the gesture it runs re-enters `commitStructural`,
 * which sets the flag before its first `await` and returns a promise, so the
 * loop sees the flag up and stops.
 */
export function endStructuralCommit(): void {
  setStructuralCommitInFlight(false)
  while (!structuralCommitInFlight && deferred.length > 0) {
    deferred.shift()!()
  }
}

/**
 * Park `gesture` when a structural commit is already in flight. Returns true
 * when the caller must stop — the gesture will run itself later.
 *
 * Call this BEFORE planning anything, in the same place the old
 * `guardAgainstConcurrentStructuralCommit` refusal sat: the whole point is
 * that the plan is built when the gesture RUNS, against the tree the previous
 * commit's resync left behind.
 */
export function deferWhileStructuralCommitInFlight(
  gesture: (relocate: RelocateNodeId) => void,
  /** Every node id the gesture will act on — captured now, re-found when it runs. See this module's doc. */
  nodeIds: readonly string[] = [],
): boolean {
  if (!structuralCommitInFlight) return false
  if (deferred.length >= MAX_DEFERRED_STRUCTURAL_GESTURES) {
    console.warn(`[structuralCommitQueue] ${MAX_DEFERRED_STRUCTURAL_GESTURES} gestures already queued; dropping a repeat`)
    return true
  }
  const identities = captureIdentities(nodeIds)
  // OD-8 — a `.map` row id is a position; a list write since may have moved
  // the row it named (`listRowRemap.ts`).
  const rowGeneration = listRowRemapGeneration()
  deferred.push(() => {
    const relocated = relocateCapturedIds(identities, nodeIds)
    if (!relocated) {
      pushToast({
        kind: 'warning',
        title: 'Not done — the file changed',
        body: 'An element this change was aimed at moved or changed while Studio was writing your previous change, and it could not be found again with certainty, so nothing was written. Try it again on the board as it is now.',
        location: 'site-editor',
      })
      return
    }
    gesture((nodeId) => remapListRowId(relocated.get(nodeId) ?? nodeId, rowGeneration))
  })
  return true
}

/** How many gestures are waiting. A test seam and the queue's own honest reading — nothing in the product branches on it. */
export function deferredStructuralGestureCount(): number {
  return deferred.length
}

/**
 * Test seam: drop everything waiting and put the flag down, so one spec's
 * unsettled burst cannot poison the next. The flag is a module-level `let` and
 * is not reset between test files on its own.
 */
export function resetStructuralCommitQueue(): void {
  deferred.length = 0
  setStructuralCommitInFlight(false)
}
