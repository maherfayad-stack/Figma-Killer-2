/**
 * pageParseCache — the route parse cache behind `studioPageLoad.ts` (WS-5.5),
 * in two tiers: memory for this process, and `.studio/cache/parse/` on disk
 * for the next one (P6-B, PERF-7).
 *
 * `parsePageFile` + `resolveComponentSources` + `inlineLocalComponents` (the
 * ts-morph parse and §7 static-evaluator pass) are the expensive part of
 * `loadStudioPages` — a cold 40-page project measured ~2.5 s of it. This
 * cache lets a load skip it for every route whose inputs are unchanged, and
 * the disk tier lets a restarted server, an LRU-evicted project coming back,
 * and the agent's per-turn Stop hook process skip it too.
 *
 * ## What a route depends on
 *
 * An entry is keyed by the route (`${dir}::${route}` — a page's relative path,
 * an App Router route file, or `story:<pageId>`) and scoped by a
 * {@link RouteCacheScope}: the `configHash` covering PARSE-relevant workspace
 * state that is not a file the parse read — the framework, the preview
 * locale, the compiled CSS-Modules class map, and the tsconfig (which decides
 * where every aliased import lands).
 *
 * Beyond that, the entry is valid exactly while every file the parse READ is
 * unchanged — and "unchanged" includes "still missing". The callers build the
 * set from the parse's own out-params, one per layer:
 *
 * - **Structure** — `inlineLocalComponents`' `dependencyFiles`: every local
 *   component file it expanded, at every nesting level, every barrel an import
 *   passed through on its way (P3-B, `reexportChainFiles`), plus an App Router
 *   route's layout chain.
 * - **Values** (WB-2, P1-C) — `StaticEvalOptions.readFiles` (`evalReadFiles.ts`):
 *   every file the §7 evaluator read a value out of — a cross-file `const`, an
 *   i18n dictionary, a Tier B provider, a `?raw` icon or image import, a
 *   CSS-in-JS interpolation's theme token.
 * - **Absence** (P6-B) — every relative import in those files that resolved
 *   to NOTHING, as the files it would have resolved to
 *   (`unresolvedImportCandidates`, `studioPageLoad.ts`). A page importing a
 *   component that does not exist yet caches a placeholder; creating the file
 *   must invalidate it, and before this nothing did short of a restart.
 *
 * This module only RECORDS the set the caller hands it — it takes no part in
 * discovering it, which is what keeps it correct as the parser's own
 * definition of "depends on" evolves.
 *
 * What the set still does not cover, knowingly: a Tier B trace that found its
 * ONE `<Ctx.Provider>` is not told when a second one appears in a file it did
 * not read (the trace then becomes ambiguous). That takes a change to a file
 * in the set to show — and, now that the cache persists, a restart no longer
 * clears it; deleting `.studio/cache/` does.
 *
 * ## Tier 1 — memory, by stamp
 *
 * Each dependency's `size:mtimeMs` (`loadDigest.ts`), or `missing`. A hit
 * costs one `stat` per dependency.
 *
 * ## Tier 2 — disk, by content
 *
 * `parseCacheStore.ts`: a signed file per route, its dependencies recorded by
 * SHA-256 of their bytes, since a stamp means nothing to another process. A
 * disk hit re-hashes every dependency (a file is re-read only when its stamp
 * moved since this process last hashed it), and only then is promoted into
 * memory. The store's own doc covers why the file is treated as untrusted.
 *
 * ## The race rule
 *
 * The stamps and digests are taken AFTER the parse. A file written while the
 * parse ran would be recorded with its new stamp beside a result built from
 * its old text, and served from then on. So nothing is cached unless every
 * dependency is provably the version the parse read: for a file the kept
 * `Project` holds, its stamp must still be the one the `Project` read it at;
 * for one the evaluator read straight off disk, its mtime must predate
 * `scope.startedAt` (`loadDigest.ts`'s `consistentStamps`). Otherwise the
 * route is simply parsed again next time.
 *
 * Every entry, in either tier, is dropped with its project when
 * `loadedProjects.ts` evicts it; the disk tier is what brings it back cheaply.
 */
import { resolve } from 'node:path'
import { consistentStamps, fileContentDigest, stampsUnchanged } from './loadDigest'
import { onLoadedProjectEvicted } from './loadedProjects'
import {
  readStoredRouteParse,
  writeStoredRouteParse,
  type CachedRouteParse,
  type StoredDependency,
} from './parseCacheStore'
import { rememberSourceTexts } from './sourceTextHistory'

export type { CachedRouteParse } from './parseCacheStore'

/** Everything about ONE load that a route's cache entry is scoped by. Built once per load (`studioPageLoad.ts`). */
export interface RouteCacheScope {
  /** The project directory. */
  dir: string
  /** Parse-relevant workspace state that is not a dependency file — see this module's doc. */
  configHash: string
  /** The §7.4 preview locale this parse resolved dictionaries under; also part of the disk tier's key. */
  preferredKey: string | undefined
  /** Wall-clock ms when this load began syncing its `Project` with the disk — the race rule's moment for a file read straight off disk. */
  startedAt: number
  /** The stamp of the version of `absFile` the kept `Project` holds, or `undefined` when it is not one of the `Project`'s files (`WorkspaceProjectHandle.recordedStamp`). */
  projectStamp: (absFile: string) => string | undefined
}

/** A cached parse, with the stamps of the files it depends on. */
export interface RouteParseHit extends CachedRouteParse {
  dependencies: ReadonlyMap<string, string>
}

interface CacheEntry {
  configHash: string
  /** Absolute file path → its stamp when this entry was recorded. */
  stamps: ReadonlyMap<string, string>
  result: CachedRouteParse
}

const cache = new Map<string, CacheEntry>()

function cacheKey(dir: string, route: string): string {
  return `${resolve(dir)}::${route}`
}

onLoadedProjectEvicted((dirKey) => {
  const prefix = `${dirKey}::`
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
})

/**
 * The disk entry for `route`, verified dependency by dependency, as the stamps
 * the memory tier should record — or `null` for any miss.
 */
function verifiedStoredParse(scope: RouteCacheScope, route: string): { stamps: Map<string, string>; result: CachedRouteParse } | null {
  const stored = readStoredRouteParse({ dir: scope.dir, route, preferredKey: scope.preferredKey })
  if (!stored || stored.configHash !== scope.configHash) return null
  const stamps = new Map<string, string>()
  for (const dep of stored.deps) {
    const now = fileContentDigest(dep.file)
    if (!now || now.digest !== dep.digest) return null
    stamps.set(dep.file, now.stamp)
  }
  return { stamps, result: stored.result }
}

/** The cached parse for `route` under `scope`, from memory or disk, or `null` on any miss. */
export function getCachedRouteParse(scope: RouteCacheScope, route: string): RouteParseHit | null {
  const key = cacheKey(scope.dir, route)
  const entry = cache.get(key)
  if (entry && entry.configHash === scope.configHash && stampsUnchanged(entry.stamps)) {
    return { ...entry.result, dependencies: entry.stamps }
  }

  const stored = verifiedStoredParse(scope, route)
  if (!stored) return null
  cache.set(key, { configHash: scope.configHash, stamps: stored.stamps, result: stored.result })
  // P1-D — the texts this parse was built from are exactly the ones on disk
  // (their digests just matched), and an edit that arrives after one of them
  // changes is re-found by diffing against them (`sourceTextHistory.ts`).
  rememberSourceTexts(stored.stamps.keys())
  return { ...stored.result, dependencies: stored.stamps }
}

/**
 * Records a fresh parse and the exact set of files it depended on — always
 * include the route's own file in `depFiles`. Returns the recorded stamps, or
 * `null` when the race rule refused to cache it (see this module's doc).
 */
export function setCachedRouteParse(
  scope: RouteCacheScope,
  route: string,
  depFiles: Iterable<string>,
  result: CachedRouteParse,
): ReadonlyMap<string, string> | null {
  const key = cacheKey(scope.dir, route)
  const stamps = consistentStamps(depFiles, { startedAtMs: scope.startedAt, knownStamp: scope.projectStamp })
  if (!stamps) {
    cache.delete(key)
    return null
  }
  cache.set(key, { configHash: scope.configHash, stamps, result })
  // P1-D — these are exactly the files whose positions this parse put into
  // node ids and literal origins, as the board is about to read them. An edit
  // that arrives after one of them changed on disk is re-found by diffing
  // against this text (`sourceTextHistory.ts`).
  rememberSourceTexts(stamps.keys())

  const deps: StoredDependency[] = []
  for (const [file, stamp] of stamps) {
    const digest = fileContentDigest(file)
    // A file that moved since it was stamped: the disk entry could not say
    // which bytes the parse saw, so there is no disk entry this time.
    if (!digest || digest.stamp !== stamp) return stamps
    deps.push({ file, digest: digest.digest })
  }
  writeStoredRouteParse({ dir: scope.dir, route, preferredKey: scope.preferredKey }, scope.configHash, deps, result)
  return stamps
}

/** Test-only: drop every in-memory entry (the disk tier stays — that is the point of it). */
export function clearPageParseCache(): void {
  cache.clear()
}

/**
 * Track C5 (reload surgery) — the dependency data behind a TARGETED reload:
 * for every cached route of `dir`, the exact set of ABSOLUTE files that
 * route's own parse depended on (its own file, its resolved local-component
 * imports, every file a value was read out of, every import target it found
 * missing, and — for App Router — its layout chain). `reloadScope.ts` inverts
 * this map to answer the only question a narrow reload needs: *given the
 * file(s) a write just touched, which routes' parsed content is now stale?*
 *
 * Keyed by the route half of the cache key (`${dir}::` stripped), which is
 * exactly the `relPath` `studioPageLoad.ts` built the key from — so the caller
 * can map it back to a page id with the SAME `assignPageIds` /
 * `assignAppRouterPageIds` a full load uses.
 *
 * `null` — not an empty map — when the cache holds NO entries at all for
 * `dir` (a cold cache: server restart, an evicted project, or nothing has
 * parsed this project in this process yet). "No data" and "no dependency" are
 * different answers with different consequences, and the caller must widen on
 * the first rather than guessing "probably fine".
 *
 * Reads only the RECORDED dependency keys, never the stamps: a stale entry
 * (the write that triggered this reload moved a tracked file, by construction)
 * still tells the truth about which files that route read.
 */
export function cachedRouteDependencies(dir: string): Map<string, ReadonlySet<string>> | null {
  const prefix = `${resolve(dir)}::`
  const byRoute = new Map<string, ReadonlySet<string>>()
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix)) continue
    byRoute.set(key.slice(prefix.length), new Set(entry.stamps.keys()))
  }
  return byRoute.size > 0 ? byRoute : null
}
