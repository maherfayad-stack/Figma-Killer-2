/**
 * studioLoadWarningsStore — the last `/load`'s `warnings` (WB-23/WB-24,
 * P3-B WB-5): what the load degraded instead of failing.
 *
 * Same tiny-external-store shape as `studioRawCssStores.ts`, for the same
 * reason: per-load, server-derived, never part of the `SiteDocument`, and read
 * by canvas chrome through `useSyncExternalStore` rather than by subscribing to
 * `site`, whose reference changes on every edit.
 *
 * Replaced wholesale on every load — `fsCodemodAdapter.ts`'s `loadSite` and
 * `studioLiveReloadFetch.ts`'s narrowed reload both receive the FULL list (the
 * server computes it for the whole project either way), so a warning that
 * stops applying disappears on the next load of any kind.
 */
import type { StudioLoadWarning } from './studioLoadStreamSchema'

let warnings: readonly StudioLoadWarning[] = []
const listeners = new Set<() => void>()

export function getStudioLoadWarnings(): readonly StudioLoadWarning[] {
  return warnings
}

export function subscribeStudioLoadWarnings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Called by both load paths with the `warnings` the `/load` meta line carried (absent on a hand-written test fixture = none). */
export function setStudioLoadWarnings(next: readonly StudioLoadWarning[] | undefined): void {
  const value = next ?? []
  if (value.length === 0 && warnings.length === 0) return
  warnings = value
  for (const listener of listeners) listener()
}

/** WB-5 — the sentence naming why `pageId`'s default export could not be drawn, or `undefined` when it could. */
export function unreadablePageExportMessage(all: readonly StudioLoadWarning[], pageId: string): string | undefined {
  for (const warning of all) {
    if (warning.code === 'unreadable-page-export' && warning.pageId === pageId) return warning.message
  }
  return undefined
}
