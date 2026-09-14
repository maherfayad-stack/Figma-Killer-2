/**
 * liveFramePool — L8 Phase B (`perf-06`, STATE.md). Pure hot-set (LRU-ish)
 * policy deciding which Tier-2 (`trust === 'run-project'`) board frames keep
 * a real, expensive cross-origin bridge iframe mounted, versus which
 * degrade back to a poster/fallback placeholder.
 *
 * Same posture as `frameVirtualization.ts` in this folder: pure, no React,
 * no DOM reads, trivially unit tested, and the caller (`BoardFramesLayer.tsx`)
 * owns the state (a `useRef<string[]>` holding the previous hot-set) — this
 * module only computes the next one.
 *
 * Key = `BoardFrame.id`, never `page.id` — "duplicate as variant" frames
 * (WS-10 Phase 2) share a `page.id` but are independent live iframes with
 * independent hot/cold state; see `BoardFramesLayer.tsx`'s own
 * `CanvasFrameContext` doc for why frame-scoped ids exist at all.
 *
 * Only relevant for Tier-2 boards. Tier 0/1 boards render every on-screen
 * frame unconditionally (portal iframes are same-process/same-origin and
 * cheap — there is nothing to pool) and never call this function at all;
 * `BoardFramesLayer.tsx` computes the hot set for every frame regardless of
 * trust tier (it's cheap and trust-independent to compute), but only
 * `BoardFrameView`'s Tier-2 branch ever reads the resulting `isLiveMounted`
 * flag for anything beyond "same as `isOnScreen`".
 */

/** The plan's own default (`STUDIO-LIVE-CANVAS-PLAN.md` §L8) — how many Tier-2 frames may keep a live bridge iframe mounted at once. */
export const LIVE_FRAME_POOL_SIZE = 8

/**
 * Computes the next hot-set of frame ids, given this render's on-screen
 * frame ids and the PREVIOUS render's hot-set (most-recently-visible first).
 *
 * Every visible id wins, unconditionally — a frame the user can currently
 * see never gets evicted for being over the pool budget; `poolSize` only
 * caps how many EXTRA, now-invisible ids ride along for warm-reopen. Beyond
 * the visible set, as many previously-hot ids as fit under `poolSize` are
 * kept, most-recently-visible first (LRU); the rest are dropped — their
 * `BoardFrameView` flips `isLiveMounted` to `false` next render, tearing
 * down the bridge iframe exactly the way an offscreen Tier 0/1 frame does
 * today.
 *
 * The returned order is: every visible id first (order among them doesn't
 * matter — they're all "now"), then the kept previously-hot ids in their
 * original (most-recent-first) order. This ordering IS the LRU record the
 * next call's `previousHot` argument should be — see `BoardFramesLayer.tsx`'s
 * `useRef` usage.
 */
export function computeHotFrameIds(
  visibleIds: readonly string[],
  previousHot: readonly string[],
  poolSize: number,
): string[] {
  const visibleSet = new Set(visibleIds)
  const hot = [...visibleIds]

  // How many pooled (invisible) slots remain after every visible id is
  // guaranteed a spot. A visible set larger than `poolSize` is real (a huge
  // board fully zoomed out) and is never itself truncated — only the EXTRA
  // off-screen slots shrink to zero.
  const remainingSlots = Math.max(0, poolSize - visibleSet.size)

  let kept = 0
  for (const id of previousHot) {
    if (kept >= remainingSlots) break
    if (visibleSet.has(id)) continue // already in `hot`, don't duplicate
    hot.push(id)
    kept += 1
  }

  return hot
}
