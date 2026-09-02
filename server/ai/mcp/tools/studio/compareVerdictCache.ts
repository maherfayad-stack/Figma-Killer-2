/**
 * compareVerdictCache — mcp-tooling CHANGE B: `studio_compare` cache.
 *
 * During a fix-verify loop the agent frequently calls `studio_compare` again
 * on a page it has not written to since the last call — paying a full bridge
 * round trip, a live-reload wait, browser rasterization and a pixelmatch diff
 * for a result that cannot have changed. This cache lets `compare.ts` skip
 * ALL of that (including the bridge connection itself, when every requested
 * page hits) for a page whose relevant inputs are provably unchanged.
 *
 * Same technique as `../../../../handlers/studio/pageParseCache.ts` — read
 * that file first. A cache entry records the mtime of every file whose
 * content could change the verdict; a hit requires every recorded mtime to
 * still match exactly. There is no partial reuse and no TTL: a stale PASS is
 * far worse than a slow compare, so ANY tracked file moving, or a cold/absent
 * entry, is always a miss.
 *
 * ## What the KEY covers (a different verdict, not a stale one)
 *
 * `passScore`, `maxRegionCoverage`, and `topN` change what the SAME
 * underlying pixels MEAN, not the pixels themselves — two calls that differ
 * only in threshold get two independent cache entries rather than one
 * serving a verdict computed under the other's numbers. `dir`, `pageId`, and
 * the resolved reference's own `id` complete the key (`registerDesignReference`
 * always mints a fresh id and never mutates an existing entry in place —
 * `designReferenceStore.ts` — so the id alone is a stable, sufficient
 * "which bytes" identity; no separate content hash needed in the key).
 *
 * ## What the MTIME set covers (could the pixels have changed)
 *
 * Recorded by the caller at write time (`compare.ts`), always including:
 *   - the page's own source file
 *   - every stylesheet `collectPageStylesheets` finds it importing directly
 *     (the SAME one-level discovery `studio_quality_check` already accepts —
 *     see that tool's own scope, not a new limitation introduced here)
 *   - `.studio/framework.json` — Studio's generated design-token store; a
 *     token used by ANY of the page's classes changes its rendering without
 *     touching the page's own files at all
 *   - `.studio/boards.json` — a resized board frame changes the dpr
 *     `captureDprFor` picks and the pixel dimensions of the whole capture,
 *     again without touching the page's own files
 *
 * A file that does not exist yet is tracked as mtime `0` rather than skipped
 * (`fileMtimeOrZero`, NOT `pageParseCache.ts`'s `fileMtimeMs`, which returns
 * `null` and is simply omitted from the recorded set): omitting an
 * as-yet-nonexistent file would mean its LATER creation — `.studio/
 * framework.json` written for the first time by a token extraction — is
 * invisible to this cache, since the validity check only walks the KEYS
 * already recorded. `studio_compare`'s correctness bar (a stale pass is far
 * worse than a slow compare) is higher than the read-path parse cache's, so
 * this closes that gap explicitly rather than inheriting it.
 *
 * ## KNOWN LIMITATION
 *
 * A project-wide Tailwind/PostCSS/Sass toolchain change (an edited
 * `tailwind.config`, a new dependency) is not tracked. `studio_compare` never
 * runs that compile step itself, and adding it here purely to widen cache
 * coverage would make every cache-validity CHECK (paid on every call, hit or
 * miss) as expensive as the capture this cache exists to avoid. Rare mid
 * verify-loop; `forceRecapture` is the explicit escape hatch for it.
 *
 * In-memory, process-scoped, no eviction — same posture as
 * `pageParseCache.ts`: one entry per distinct
 * (dir, pageId, referenceId, passScore, maxRegionCoverage, topN) tuple ever
 * compared in this process.
 */
import { statSync } from 'node:fs'
import type { DiffRegion } from './frameDiffEngine'

export interface CachedCompareImages {
  screenBase64: string
  referenceBase64: string
  referenceMimeType: string
  diffBase64: string
}

export interface CachedCompareVerdict {
  pass: boolean
  verdict: string
  similarityScore: number
  diffPercent: number
  capture: {
    width: number
    height: number
    dpr: number
    dimensionMatch: 'exact' | 'resampled'
    dimensionMatchNote?: string
  }
  structuralRegionCount: number
  regions: DiffRegion[]
  regionsTruncated: boolean
  worstRegionNodeIds?: string[]
  images: CachedCompareImages
}

interface CacheEntry {
  /** Absolute file path -> the mtime it had when this entry was written; `0` for "did not exist". */
  depMtimes: Record<string, number>
  result: CachedCompareVerdict
}

const cache = new Map<string, CacheEntry>()

/** `0` for a missing/unreadable file rather than `null` — see this module's doc for why a create/delete transition must stay visible to the validity check. */
function fileMtimeOrZero(absFile: string): number {
  try {
    return statSync(absFile).mtimeMs
  } catch {
    return 0
  }
}

export function buildCompareCacheKey(
  dir: string,
  pageId: string,
  referenceId: string,
  passScore: number,
  maxRegionCoverage: number,
  topN: number,
): string {
  return `${dir}::${pageId}::${referenceId}::${passScore}::${maxRegionCoverage}::${topN}`
}

/**
 * The cached verdict for `cacheKey`, or `null` on any miss — cold entry, or a
 * tracked file's mtime moved (including a create/delete transition). Reads
 * ONLY the file list already recorded in the entry from its last write — no
 * rediscovery, no parsing, just a `statSync` per already-known path. This is
 * what keeps a cache-hit check itself cheap.
 */
export function getCachedCompareVerdict(cacheKey: string): CachedCompareVerdict | null {
  const entry = cache.get(cacheKey)
  if (!entry) return null
  for (const [absFile, recordedMtime] of Object.entries(entry.depMtimes)) {
    if (fileMtimeOrZero(absFile) !== recordedMtime) return null
  }
  return entry.result
}

/** Records a fresh verdict and the exact set of files whose mtimes must stay unchanged for it to remain valid. */
export function setCachedCompareVerdict(
  cacheKey: string,
  depFiles: readonly string[],
  result: CachedCompareVerdict,
): void {
  const depMtimes: Record<string, number> = {}
  for (const absFile of depFiles) depMtimes[absFile] = fileMtimeOrZero(absFile)
  cache.set(cacheKey, { depMtimes, result })
}

/** Test-only: drop every cached entry so a test doesn't leak state into the next one. */
export function clearCompareVerdictCache(): void {
  cache.clear()
}
