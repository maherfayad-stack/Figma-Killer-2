/**
 * framePool — THE module that answers "does board frame X hold a live
 * iframe, and why".
 *
 * There used to be two: `frameMountPool.ts` (S1, `perf-07`) for the portal
 * frames every Tier 0/1 board renders, and `liveFramePool.ts` (L8 Phase B,
 * `perf-06`) for the cross-origin bridge frames a Tier-2 board renders. They
 * were written three weeks apart against the same problem and ran the same
 * algorithm — every on-screen frame, plus as many recently-on-screen frames
 * as the budget allows, evicted least-recently-on-screen — differing only in
 * how big the budget is. `BoardFramesLayer` computed BOTH on every render
 * and threw one away, and `BoardFrameView` re-derived which of the two
 * applied from the trust tier, so "is this frame mounted" had three
 * fallbacks (`isLiveMounted ?? isMounted ?? isOnScreen`) spread over two
 * files. `meta-14` deferred the merge; this is it.
 *
 * ## One policy, parameterised by what a frame costs
 *
 * A frame's cost is a property of the board's trust tier, and it is the only
 * thing the two pools ever disagreed about:
 *
 * | `FrameMountCost` | A mounted frame is | Budget |
 * |---|---|---|
 * | `'portal'` (Tier 0/1) | one same-origin `srcDoc` iframe — ~12 ms to create, cheap and plentiful | `max(8, onScreen + 4)` |
 * | `'live'` (Tier 2) | `LiveBoardFrame`: a Tier-0 fallback frame AND a cross-origin bridge iframe against a real dev-server process — **two** documents until it reports ready | `max(onScreen, 8)` |
 *
 * The portal budget is a FLOOR with headroom: a board showing two frames
 * still keeps eight, so panning back to where you just were costs nothing;
 * a board showing thirty keeps thirty-four. The live budget is a CEILING
 * that only the visible set may exceed: a frame the user is looking at is
 * never evicted, but no warm cache is kept beyond eight, because eight live
 * frames is already sixteen documents and a dev server answering all of
 * them.
 *
 * Both budgets are measured, not guessed — `perf-07` for the portal side,
 * `docs/audits/2026-09-13-live-frame-memory-baseline.md` for the live side.
 *
 * ## Why the eviction order is the same for both
 *
 * On-screen frames lead the list, in the layer's own order, so they can
 * never be evicted by their own neighbours. Behind them come the
 * previously-retained frames in their existing order, which is what makes
 * eviction least-recently-on-screen. The returned order IS the record the
 * next call reads back as `previous`.
 *
 * Deliberately pure — no React, no DOM — so the policy is unit-testable
 * independently of the layer that applies it, exactly like
 * `frameVirtualization.ts` next door (which owns the board→screen geometry
 * that decides what "on screen" means; this module owns what happens to a
 * frame once it is or is not).
 */

/**
 * What one mounted frame costs on this board. Derived from the project's
 * trust tier by `BoardFramesLayer`, and nothing else — a Tier-2 board's
 * frames are live frames, every other board's are portal frames.
 */
export type FrameMountCost = 'portal' | 'live'

/** Lower bound on the portal pool, so a zoomed-in board still remembers its neighbours. */
export const MIN_FRAME_POOL = 8

/** Headroom over the visible set for portal frames, so a departure always has somewhere to go. */
export const FRAME_POOL_HEADROOM = 4

/**
 * Ceiling on live (Tier-2) frames — `STUDIO-LIVE-CANVAS-PLAN.md` §L8's own
 * default. Only the visible set may exceed it.
 */
export const LIVE_FRAME_POOL_SIZE = 8

/** How many frames of this cost may hold a live iframe at once, given `onScreenCount` visible. */
export function framePoolBudget(cost: FrameMountCost, onScreenCount: number): number {
  return cost === 'live'
    ? Math.max(onScreenCount, LIVE_FRAME_POOL_SIZE)
    : Math.max(MIN_FRAME_POOL, onScreenCount + FRAME_POOL_HEADROOM)
}

/**
 * The next pool membership (most-recently-on-screen first), given the
 * previous one and the frames on screen now.
 *
 * `knownIds` drops frames that have left the board entirely (removed from
 * the board, or their page deleted) rather than letting them hold a pool
 * slot forever.
 *
 * Every on-screen id is always in the result: both budgets are `>=
 * onScreenIds.length` by construction, so the truncation below can only ever
 * bite into the retained tail.
 */
export function nextFramePool(
  previous: readonly string[],
  onScreenIds: readonly string[],
  knownIds: ReadonlySet<string>,
  cost: FrameMountCost,
): string[] {
  const next: string[] = []
  const seen = new Set<string>()
  for (const id of onScreenIds) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  const budget = framePoolBudget(cost, next.length)
  for (const id of previous) {
    if (next.length >= budget) break
    if (seen.has(id) || !knownIds.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/**
 * Did the pool membership actually change? `BoardFramesLayer` recomputes
 * this on every pan/zoom commit and must not re-render when the answer is
 * "no" — a state write per wheel tick is exactly the re-render storm WS-5.4
 * exists to prevent. Order-sensitive, because the order IS the LRU record.
 */
export function sameFramePool(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Why a frame is (or is not) mounted. Written to the frame element as
 * `data-frame-mount` by `BoardFrameView`, so the answer is readable from the
 * DOM — by a test counting the live set against `framePoolBudget`, by the
 * agent's capture path when a frame it wanted never mounted, and by a human
 * dogfooding a pan with devtools open.
 *
 * - `on-screen` — its board rect intersects the viewport plus margin.
 * - `pooled` — off screen, but the pool is still holding it so panning back
 *   is free.
 * - `offscreen` — off screen and not pooled: a poster placeholder, no iframe.
 */
export type FrameMountReason = 'on-screen' | 'pooled' | 'offscreen'

/** The attribute `BoardFrameView` stamps a `FrameMountReason` onto. */
export const FRAME_MOUNT_ATTR = 'data-frame-mount'

export interface FrameMount {
  /** Does this frame render its real iframe body, rather than a poster placeholder? */
  mounted: boolean
  reason: FrameMountReason
}

/**
 * The single answer, for one frame.
 *
 * `isPooled` is optional on purpose. A caller that takes no part in a pool —
 * a unit test, or any future surface rendering one frame outside
 * `BoardFramesLayer` — means "mounted exactly while visible", which is the
 * pre-pool behaviour and the only honest default. `BoardFrameView`'s
 * `isMounted` prop is optional for the same reason, and `meta-14` landmine 1
 * is what happens when it stops being: a caller that omits it silently
 * renders no frame at all, and `tsc` does not catch it.
 * `boardFrameViewTierFork.test.tsx` does.
 */
export function resolveFrameMount({
  isOnScreen,
  isPooled,
}: {
  isOnScreen: boolean
  isPooled?: boolean
}): FrameMount {
  if (isOnScreen) return { mounted: true, reason: 'on-screen' }
  if (isPooled) return { mounted: true, reason: 'pooled' }
  return { mounted: false, reason: 'offscreen' }
}

const FRAME_MOUNT_REASONS: readonly FrameMountReason[] = ['on-screen', 'pooled', 'offscreen']

/**
 * Read a frame element's stamped reason back. Returns `null` for an element
 * that is not a board frame, or a board frame from a build that predates the
 * stamp — callers treat that as "no answer", never as "not mounted".
 */
export function readFrameMountReason(element: Element | null | undefined): FrameMountReason | null {
  const raw = element?.getAttribute(FRAME_MOUNT_ATTR)
  return FRAME_MOUNT_REASONS.find((reason) => reason === raw) ?? null
}
