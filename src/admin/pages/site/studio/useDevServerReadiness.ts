/**
 * useDevServerReadiness — L8 Phase A (`perf-06`, STATE.md): polls
 * `getDevServerStatus(dir)` (already existed, never called before this)
 * while a Tier 2 project's dev server is booting, so `LiveBoardFrame` knows
 * when it's safe to stop showing its Tier-0 fallback and hand off to the
 * bridge iframe.
 *
 * **One poll loop per `dir`, shared by every mounted board frame** — dev-
 * server readiness is project-wide, not per-page, so a board with N Tier-2
 * frames must not open N independent `setInterval`s. Reference-counted
 * per-`dir` entries: the first `useDevServerReadiness(dir)` subscriber for a
 * given directory starts polling, the last one to unmount stops it. Matches
 * `useLiveOrigin.ts`'s "one fetch feeds every frame" posture, and the
 * `useSyncExternalStore` shape `useDevServerPrewarm.ts` already established
 * for `trustTier`.
 *
 * Stops polling the instant `phase` settles (`'ready'` or `'failed'`) —
 * there is nothing left to learn from another status round trip once a dev
 * server has finished booting or given up. Never starts at all below Tier 2
 * (`getDevServerStatus` 409s there — no reason to pay the round trip).
 */
import { useSyncExternalStore } from 'react'
import { getDevServerStatus, type DevServerStatus } from './devServerRequests'
import { getStudioTrustTier, subscribeStudioTrustTier } from './studioProjectTrust'

const POLL_INTERVAL_MS = 1000

export interface DevServerReadiness {
  phase: DevServerStatus['phase']
  log: string
}

const DEFAULT_READINESS: DevServerReadiness = { phase: 'stopped', log: '' }

function isSettled(phase: DevServerStatus['phase']): boolean {
  return phase === 'ready' || phase === 'failed'
}

interface PollEntry {
  state: DevServerReadiness
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
}

const entries = new Map<string, PollEntry>()

function getEntry(dir: string): PollEntry {
  let entry = entries.get(dir)
  if (!entry) {
    entry = { state: DEFAULT_READINESS, listeners: new Set(), timer: null, inFlight: false }
    entries.set(dir, entry)
  }
  return entry
}

function notify(entry: PollEntry): void {
  for (const listener of entry.listeners) listener()
}

async function pollOnce(dir: string, entry: PollEntry): Promise<void> {
  entry.inFlight = true
  try {
    const status = await getDevServerStatus(dir)
    entry.state = { phase: status.phase, log: status.log }
  } catch (err: unknown) {
    console.error('[useDevServerReadiness] status poll failed', err)
    // Leave the previous state in place — a transient network hiccup mid-boot
    // shouldn't flip a booting frame back to "stopped" and reset its fallback.
  }
  entry.inFlight = false
  notify(entry)
  entry.timer = null
  if (entry.listeners.size > 0 && !isSettled(entry.state.phase)) {
    entry.timer = setTimeout(() => void pollOnce(dir, entry), POLL_INTERVAL_MS)
  }
}

function ensurePolling(dir: string, entry: PollEntry): void {
  if (entry.timer || entry.inFlight || isSettled(entry.state.phase)) return
  void pollOnce(dir, entry)
}

interface SubscriptionPair {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => DevServerReadiness
}

/** The `dir === null` / `trust !== 'run-project'` case — a stable, module-level constant so it never re-subscribes. */
const INACTIVE_SUBSCRIPTION: SubscriptionPair = {
  subscribe: () => () => {},
  getSnapshot: () => DEFAULT_READINESS,
}

/**
 * One `{ subscribe, getSnapshot }` pair per `dir`, cached forever (a session
 * opens only a handful of distinct project directories, unlike
 * `BoardFrameView.tsx`'s per-pixel-width breakpoint cache, which needs a
 * size cap). Deliberately NOT a `useMemo` inside the hook below: this pair
 * feeds `useSyncExternalStore`'s `subscribe` argument, which React treats
 * exactly like an effect dependency internally — an unstable identity would
 * tear down and reopen the subscription on every commit, and because a
 * poll's own status update IS a commit, that turns the 1s throttle into a
 * tight synchronous poll loop. A hand-written `useMemo` returning a closure
 * can't be verified by the React Compiler either (confirmed: `bun run lint`
 * reports `react-hooks/preserve-manual-memoization` for exactly that shape),
 * so this uses the SAME plain module-level cache idiom
 * `BoardFrameView.tsx`'s `activatePageHandler`/`buildStudioBreakpoint`
 * already establish for "a stable identity the compiler can't be trusted to
 * produce in `bun test`, where it doesn't run at all."
 */
const subscriptionsByDir = new Map<string, SubscriptionPair>()

function getSubscription(dir: string): SubscriptionPair {
  let pair = subscriptionsByDir.get(dir)
  if (pair) return pair
  pair = {
    subscribe: (listener) => {
      const entry = getEntry(dir)
      entry.listeners.add(listener)
      ensurePolling(dir, entry)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = null
        }
      }
    },
    getSnapshot: () => getEntry(dir).state,
  }
  subscriptionsByDir.set(dir, pair)
  return pair
}

/** `dir === null` (no project open yet) or `trust !== 'run-project'` both return the default `'stopped'` readiness and never poll. */
export function useDevServerReadiness(dir: string | null): DevServerReadiness {
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const active = Boolean(dir) && trust === 'run-project'
  const { subscribe, getSnapshot } = active && dir ? getSubscription(dir) : INACTIVE_SUBSCRIPTION

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/**
 * Clears every per-`dir` poll entry and cancels its timer. `bun test` runs
 * every matched file in one shared process, so a `dir` string reused across
 * two test FILES (not just two tests in one file) would otherwise read the
 * previous file's leftover state.
 */
export function __resetDevServerReadinessForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  entries.clear()
}
