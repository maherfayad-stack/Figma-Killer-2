/**
 * pageParseCache — WS-5.5 page-level parse cache for `studioPageLoad.ts`.
 *
 * `parsePageFile` + `resolveComponentSources` + `inlineLocalComponents` (the
 * ts-morph parse and §7 static-evaluator pass) are the expensive part of
 * `loadStudioPages` — reopening a 40-page project re-ran that sequence for
 * every route on every load, even when only one file had changed. This cache
 * lets the caller skip it for a route whose relevant inputs are unchanged.
 *
 * Cache key: an opaque string the caller controls (`${dir}::${relFile}`, or
 * an App Router route's own relPath) plus a `configHash` covering
 * PARSE-relevant workspace state that isn't a per-file mtime — the project's
 * framework, the preview locale, and the compiled CSS-Modules class map
 * (`compileProjectStyles`'s `moduleClassMaps` feeds `StaticEvalOptions`, so a
 * changed Tailwind/PostCSS/CSS-Modules build must invalidate every route, not
 * just the ones whose OWN file changed).
 *
 * Per-file validity, not per-project: `setCachedRouteParse` records the mtime
 * of the route's own file AND every file the caller says this parse actually
 * depended on (its resolved LOCAL component sources, an App Router route's
 * layout chain). `getCachedRouteParse` is a hit only when every one of those
 * recorded mtimes still matches — so editing `Hero.tsx` invalidates every
 * page that imports it directly, and editing an unrelated page's own file
 * invalidates only that one page.
 *
 * KNOWN LIMITATION: dependency tracking is ONE LEVEL deep — the local
 * component sources `resolveComponentSources` finds directly on the route's
 * own file, not the transitive closure through a chain of local components
 * importing further local components (`inlineLocalComponents` resolves those
 * internally but doesn't surface the file list back to this caller). A
 * change three components deep in a nested composition can go unnoticed
 * until the page whose cache entry it should have invalidated is itself
 * touched, or the process restarts. Acceptable for the common case (a page
 * imports a handful of section components directly); a full transitive
 * dependency graph is a larger undertaking left for a follow-up if this
 * proves to matter in practice.
 *
 * In-memory, process-scoped — cleared on server restart, never persisted to
 * disk. No eviction policy: a dev server's lifetime and project count don't
 * warrant one yet.
 */
import { statSync } from 'node:fs'
import type { ComponentSource, ParsedPage } from '@core/page-parser'

export interface CachedRouteParse {
  expanded: ParsedPage
  componentSources: Record<string, ComponentSource>
}

interface CacheEntry {
  configHash: string
  /** Absolute file path -> the mtime it had when this entry was written. */
  depMtimes: Record<string, number>
  result: CachedRouteParse
}

const cache = new Map<string, CacheEntry>()

function fileMtimeMs(absFile: string): number | null {
  try {
    return statSync(absFile).mtimeMs
  } catch {
    return null // deleted/unreadable — never matches a recorded mtime, so this always misses.
  }
}

/**
 * A cheap, non-cryptographic hash of parse-relevant workspace config —
 * changes only need to be DETECTED, never resisted. Callers build the input
 * array from whatever actually feeds `StaticEvalOptions` beyond per-file
 * mtimes (framework, preferred locale, compiled CSS-Modules class maps).
 */
export function hashWorkspaceConfig(parts: readonly unknown[]): string {
  const payload = JSON.stringify(parts)
  let hash = 0
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 31 + payload.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

/** The cached parse for `cacheKey`, or `null` on any miss — cold entry, a tracked file's mtime moved, a tracked file disappeared, or `configHash` changed. */
export function getCachedRouteParse(cacheKey: string, configHash: string): CachedRouteParse | null {
  const entry = cache.get(cacheKey)
  if (!entry || entry.configHash !== configHash) return null
  for (const [absFile, recordedMtime] of Object.entries(entry.depMtimes)) {
    if (fileMtimeMs(absFile) !== recordedMtime) return null
  }
  return entry.result
}

/** Records a fresh parse result and the exact set of files whose mtimes must stay unchanged for it to remain valid — always include the route's own file in `depFiles`. */
export function setCachedRouteParse(
  cacheKey: string,
  configHash: string,
  depFiles: readonly string[],
  result: CachedRouteParse,
): void {
  const depMtimes: Record<string, number> = {}
  for (const absFile of depFiles) {
    const mtime = fileMtimeMs(absFile)
    if (mtime !== null) depMtimes[absFile] = mtime
  }
  cache.set(cacheKey, { configHash, depMtimes, result })
}

/** Test-only: drop every cached entry so a test doesn't leak state into the next one. */
export function clearPageParseCache(): void {
  cache.clear()
}
