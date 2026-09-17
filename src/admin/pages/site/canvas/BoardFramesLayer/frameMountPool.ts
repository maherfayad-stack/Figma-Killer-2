/**
 * frameMountPool — which frames keep a live iframe, beyond the ones the
 * viewport can currently see (S1, `perf-06` Phase B).
 *
 * ## The measurement
 *
 * `isFrameOnScreen` (`frameVirtualization.ts`) unmounts a frame's iframe the
 * moment its board rect leaves the viewport margin, and mounts a fresh one
 * when it comes back. On an 18-frame board a pan that swept 3-6 frames out and
 * back cost a **148 ms worst animation frame and 13 frames over 50 ms**, all of
 * it re-doing work that had just been thrown away: a new document, a fresh
 * parse of the vendor / authored / class / user stylesheets into it, a fresh
 * node tree. Panning back to where you just were is the single most ordinary
 * thing anyone does on a board, and it was the most expensive.
 *
 * ## The policy
 *
 * A frame that goes offscreen is RETAINED — kept mounted, invisible, doing
 * nothing — for as long as there is room in the pool. Coming back is then
 * free: no document, no reparse, no remount, because nothing was ever
 * unmounted. The pool is `max(8, onScreen + 4)` total live frames, so it
 * always holds at least a few departures worth of history and always has
 * headroom over whatever is currently visible. Eviction is least-recently
 * on screen: the frame you looked at longest ago is the one that gives up its
 * iframe.
 *
 * **Memory is what the cap is for.** Each live frame is a whole document with
 * its own copy of every stylesheet; without a ceiling, panning across a
 * 40-frame board would end with 40 of them resident. `max(8, …)` is a floor,
 * not a target — a board showing two frames keeps eight, a board showing
 * thirty keeps thirty-four.
 *
 * Deliberately pure — no React, no DOM — so the policy is unit-testable
 * independently of the layer that applies it, exactly like
 * `frameVirtualization.ts` next door.
 */

/** Lower bound on the pool, so a zoomed-in board still remembers its neighbours. */
export const MIN_FRAME_POOL = 8

/** Headroom over the visible set, so a departure always has somewhere to go. */
export const FRAME_POOL_HEADROOM = 4

/** How many frames may hold a live iframe at once, given `onScreenCount` visible. */
export function frameMountBudget(onScreenCount: number): number {
  return Math.max(MIN_FRAME_POOL, onScreenCount + FRAME_POOL_HEADROOM)
}

/**
 * The next retention order (most-recently-on-screen first), given the previous
 * one and the frames on screen now.
 *
 * On-screen frames always lead, in the layer's own order, so they can never be
 * evicted by their own neighbours. Behind them come the previously-retained
 * frames in their existing order — which is what makes eviction
 * least-recently-on-screen — truncated to the budget.
 *
 * `knownIds` drops frames that have left the board entirely (removed from the
 * board, or their page deleted) rather than letting them hold a pool slot
 * forever.
 */
export function nextFrameRetention(
  previous: readonly string[],
  onScreenIds: readonly string[],
  knownIds: ReadonlySet<string>,
): string[] {
  const budget = frameMountBudget(onScreenIds.length)
  const next: string[] = []
  const seen = new Set<string>()
  for (const id of onScreenIds) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  for (const id of previous) {
    if (next.length >= budget) break
    if (seen.has(id) || !knownIds.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/**
 * Did the retention order actually change? `BoardFramesLayer` recomputes this
 * on every pan/zoom commit and must not re-render when the answer is "no" —
 * a state write per wheel tick is exactly the re-render storm WS-5.4 exists to
 * prevent.
 */
export function sameFrameRetention(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
