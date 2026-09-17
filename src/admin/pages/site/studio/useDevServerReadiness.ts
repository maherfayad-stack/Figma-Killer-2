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
 *
 * **The poll backs off, and it reports once per condition** (Z3). It used to
 * be a flat 1 s tick that logged its failure on every single one of them. A
 * dev server that is down is down for minutes, so what that produced was a
 * console filling at one line a second with the same sentence — noise that
 * hides the one line that actually said something new, and a request per
 * second going nowhere. The interval now doubles from
 * {@link POLL_INTERVAL_START_MS} to a {@link POLL_INTERVAL_MAX_MS} ceiling
 * while nothing changes, and RESETS the moment `phase` does: a boot that just
 * moved is worth watching closely again. Logging is keyed on the condition, so
 * a repeating failure is reported once and a genuinely new one still gets
 * through.
 */
import { useSyncExternalStore } from 'react'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getDevServerStatus, type DevServerStatus } from './devServerRequests'
import { getStudioTrustTier, subscribeStudioTrustTier } from './studioProjectTrust'

/** The first interval, and the one a phase change returns to. */
export const POLL_INTERVAL_START_MS = 1000
/** The ceiling the interval doubles up to while nothing changes. */
export const POLL_INTERVAL_MAX_MS = 10_000
const POLL_BACKOFF_FACTOR = 2

/**
 * One backoff step. Pure and exported so the curve is checkable without
 * spending ten real seconds proving it; the reset on a phase change is the
 * caller's decision, not this function's, because only the caller knows one
 * happened.
 */
export function nextPollDelayMs(currentMs: number): number {
  return Math.min(currentMs * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS)
}

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
  /** The delay the next scheduled poll will use. Doubles while nothing changes; resets on a phase change. */
  delayMs: number
  /**
   * The condition this entry last reported, so the same one is never reported
   * twice running. `null` once something changed, which is what lets a
   * recurring failure speak again after a recovery.
   */
  lastLogged: string | null
}

const entries = new Map<string, PollEntry>()

function getEntry(dir: string): PollEntry {
  let entry = entries.get(dir)
  if (!entry) {
    entry = {
      state: DEFAULT_READINESS,
      listeners: new Set(),
      timer: null,
      inFlight: false,
      delayMs: POLL_INTERVAL_START_MS,
      lastLogged: null,
    }
    entries.set(dir, entry)
  }
  return entry
}

function notify(entry: PollEntry): void {
  for (const listener of entry.listeners) listener()
}

/** Report `message` unless this entry's last report said exactly the same thing. */
function logOncePerCondition(entry: PollEntry, key: string, message: string): void {
  if (entry.lastLogged === key) return
  entry.lastLogged = key
  console.error(`[useDevServerReadiness] ${message}`)
}

async function pollOnce(dir: string, entry: PollEntry): Promise<void> {
  entry.inFlight = true
  const previousPhase = entry.state.phase
  try {
    const status = await getDevServerStatus(dir)
    entry.state = { phase: status.phase, log: status.log }
  } catch (err: unknown) {
    logOncePerCondition(entry, `poll-failed:${getErrorMessage(err, 'unknown error')}`, `status poll failed: ${getErrorMessage(err, 'unknown error')}`)
    // Leave the previous state in place — a transient network hiccup mid-boot
    // shouldn't flip a booting frame back to "stopped" and reset its fallback.
  }
  const phaseChanged = entry.state.phase !== previousPhase
  if (phaseChanged) {
    // A change is the one thing worth resetting BOTH bounds for: poll tightly
    // again, and let the next condition report itself even if it repeats one
    // from before the change.
    entry.lastLogged = null
    if (entry.state.phase === 'failed') {
      logOncePerCondition(entry, 'phase:failed', `dev server failed to start for ${dir}`)
    }
  }
  entry.inFlight = false
  notify(entry)
  entry.timer = null
  if (entry.listeners.size > 0 && !isSettled(entry.state.phase)) {
    if (phaseChanged) entry.delayMs = POLL_INTERVAL_START_MS
    entry.timer = setTimeout(() => void pollOnce(dir, entry), entry.delayMs)
    entry.delayMs = nextPollDelayMs(entry.delayMs)
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
