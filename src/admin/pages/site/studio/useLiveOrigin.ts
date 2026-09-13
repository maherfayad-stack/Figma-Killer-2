/**
 * useLiveOrigin — L8 Phase A prerequisite (`perf-06`, STATE.md): where the
 * client learns L2's live-origin base (`server/liveOrigin.ts`'s second,
 * cookie-free `Bun.serve` listener) so `resolveLiveFrameSrc.ts` can build a
 * real `<liveOrigin>/__screen/<key>` URL for a bridge-mode board frame.
 *
 * **Deviation from `perf-06`'s own recon.** The work order's design pass
 * assumed nothing exposes the live origin to the browser and recommended
 * adding a `liveOrigin` field to `/admin/api/studio/load`. Re-checking the
 * actual tree at implementation time found that assumption stale:
 * `GET /admin/api/studio/live-origin` (`server/handlers/studio/liveOriginInfo.ts`)
 * already exists, already returns exactly `{ liveOrigin: string | null }`,
 * and already has zero callers anywhere in the client — it was built (Track
 * L, L2) but never wired up. Reusing it needs no server change at all, so
 * that's what this hook does instead of widening `/load`'s response. Same
 * external-store shape the CONTRACTS block specified either way
 * (`getLiveOrigin`/`subscribeLiveOrigin`/`setLiveOrigin`), so nothing
 * downstream (Phase B) has to know which route filled it in.
 *
 * Server topology, not project-scoped data — the live listener's origin
 * doesn't change per project, so this fetches once per page load (module-
 * scoped, deduplicated), not once per `useLiveOrigin()` call site. Every
 * `LiveBoardFrame` on a board shares the one fetch and the one store, the
 * same "one thing feeds every frame" posture `useDevServerReadiness.ts`
 * uses for dev-server status.
 *
 * `null` means the live listener never bound at server boot (see
 * `getLiveOriginRuntimeOrigin`'s own doc) — callers must not point a bridge
 * iframe's `src` at a dead origin; `LiveBoardFrame` treats `null` the same
 * as "not ready yet" and stays on its Tier-0 fallback subtree.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'

/** Mirrors `LiveOriginInfoSchema` in `server/handlers/studio/liveOriginInfo.ts` — this file runs in the browser, so it only needs to agree on the wire shape, same posture as `studioProjectTrust.ts`'s `TrustTierSchema`. */
const LiveOriginInfoSchema = Type.Object({
  liveOrigin: Type.Union([Type.String(), Type.Null()]),
})

let liveOrigin: string | null = null
const liveOriginListeners = new Set<() => void>()

export function getLiveOrigin(): string | null {
  return liveOrigin
}

export function subscribeLiveOrigin(listener: () => void): () => void {
  liveOriginListeners.add(listener)
  return () => liveOriginListeners.delete(listener)
}

/** Written by the fetch below; exported so a future project-load response field (if one ever lands) can also feed this store without changing any consumer. */
export function setLiveOrigin(next: string | null): void {
  if (next === liveOrigin) return
  liveOrigin = next
  for (const listener of liveOriginListeners) listener()
}

/** Deduplicates the one-time fetch across every `useLiveOrigin()` call site. */
let fetchInFlight: Promise<void> | null = null

function ensureLiveOriginFetched(): void {
  if (fetchInFlight) return
  fetchInFlight = apiRequest('/admin/api/studio/live-origin', { schema: LiveOriginInfoSchema })
    .then((info) => setLiveOrigin(info.liveOrigin))
    .catch((err: unknown) => {
      console.error('[useLiveOrigin] could not resolve the live origin', err)
    })
}

/** The current live-origin base, fetched once and shared by every mounted board frame. */
export function useLiveOrigin(): string | null {
  const origin = useSyncExternalStore(subscribeLiveOrigin, getLiveOrigin, getLiveOrigin)
  useEffect(() => {
    ensureLiveOriginFetched()
  }, [])
  return origin
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/**
 * Clears the resolved value AND the fetch-dedup cache. Needed because `bun
 * test` runs every matched file in one shared process — without this, an
 * EARLIER file's stub `fetch` response (or an earlier test's real value)
 * permanently wins the dedup for every later file that also mounts
 * `useLiveOrigin`, since `ensureLiveOriginFetched` never fires a second real
 * request once `fetchInFlight` has resolved once.
 */
export function __resetLiveOriginForTests(): void {
  liveOrigin = null
  fetchInFlight = null
}
