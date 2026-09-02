/**
 * entryStylesheetCache — process-scoped cache for `collectEntryStylesheets`'s
 * BFS import-graph walk (`collectPageStylesheets.ts`). That walk calls
 * ts-morph's `decl.getModuleSpecifierSourceFile()` per import edge — a
 * type-checker-backed resolution, not a syntactic one — and on a real
 * imported repo (`main -> App -> every route component -> ...`) that adds up
 * to 500-850ms of SYNCHRONOUS compute on every `loadStudioPages` call,
 * blocking Bun's single JS thread for the whole duration. This cache lets a
 * warm call skip the walk entirely when nothing it depends on has moved.
 *
 * Same in-memory, process-scoped, no-eviction posture as
 * `server/handlers/studio/pageParseCache.ts` — cleared on server restart,
 * never persisted to disk.
 *
 * ## Cache key
 *
 * `${resolvedWorkspaceRoot}::${resolvedEntryFile}` — NOT just the workspace
 * root. `findEntryFile` is cheap (a handful of `existsSync` calls plus one
 * regex over `index.html`, ~4ms) and is always re-run by the caller before
 * consulting this cache, so the entry file's OWN identity changing — the
 * entry disappearing, a different `ENTRY_CANDIDATES` file taking over, or
 * `index.html`'s `<script src>` now pointing elsewhere — is handled for
 * free by the key simply becoming a different string, with no separate
 * invalidation logic needed. `findEntryFile` returning `undefined` (no entry
 * at all) is never cached here — the caller short-circuits to `[]` before
 * this module is consulted, which is already as fast as a cache hit would
 * be.
 *
 * ## Invalidation contract
 *
 * `getCachedEntryStylesheets` is a hit only when EVERY one of the following
 * still holds; any single mismatch is a miss, and the caller re-runs the
 * full walk:
 *
 * 1. **`fileMtimes`** — every file the walk actually visited (parsed for
 *    import declarations) AND every stylesheet it resolved, each mapped to
 *    the mtime it had when the entry was written. Covers "a visited file was
 *    edited to add/remove/repoint an import" and "a resolved file was
 *    deleted" (a deleted file's mtime read comes back `null`, which never
 *    equals a recorded number).
 * 2. **`missingCandidates`** — absolute paths the walk checked and found
 *    ABSENT: a relative stylesheet specifier whose target didn't exist on
 *    disk, or a standard extension/index-file guess for a relative JS/TS
 *    import that didn't resolve. If ANY of these now exists, the cache is
 *    invalidated wholesale (not patched) — that file might pull in a whole
 *    new subgraph the stale entry never saw. Covers "a file that didn't
 *    exist when the walk ran now exists, and a previously-unresolvable
 *    import now resolves."
 * 3. **`watchedDirMtimes`** — a robustness net on top of (2).
 *    `moduleResolutionCandidates` mirrors TypeScript's plain extension +
 *    index-file lookup order, but NOT `package.json` "exports"/"main"
 *    resolution for a directory import, nor `baseUrl`/`paths` remapping.
 *    Rather than silently miss that class of case, the containing
 *    director{y,ies} of every unresolved guess are watched by mtime too — a
 *    new/removed/renamed entry in a directory bumps its mtime on the local
 *    filesystems this runs against (studio-workspace is always local disk,
 *    never a network mount), so a resolution style (2) doesn't explicitly
 *    enumerate still gets caught here, at the cost of an occasional
 *    unnecessary miss (a directory touched for an unrelated reason). An
 *    occasional extra miss is the safe failure mode; a stale hit is not.
 *
 * ## What is deliberately NOT covered, and why that's still sound
 *
 * `tsconfig.json`/`vite.config` path-alias changes are NOT tracked, on
 * purpose: `collectEntryStylesheets`'s walk only ever follows RELATIVE
 * specifiers (`./x`, `../x`) — see its own doc and the `specifier.startsWith
 * ('./')` guard before every `getModuleSpecifierSourceFile()` call — so
 * `paths` aliases never influence this walk's output in the first place; a
 * bare-specifier import is skipped identically whether or not it's aliased.
 * If that guard is ever loosened to follow aliased imports too, this
 * invalidation contract must be revisited (alias changes would then need
 * their own dependency entry, e.g. `tsconfig.json`'s own mtime).
 *
 * `createWorkspaceProject`'s `allowJs` is forced `true` unconditionally
 * (explicit `compilerOptions` beats a workspace tsconfig's own value — see
 * that function's doc), so a workspace's tsconfig cannot change whether a
 * `.js`/`.jsx` file resolves as a module either. Combined, the two rules
 * above make this cache's correctness independent of tsconfig/vite.config
 * content entirely.
 */
import { existsSync, statSync } from 'node:fs'
import type { PageStylesheet } from './pageStylesheet'

export interface EntryStylesheetDeps {
  fileMtimes: Record<string, number>
  missingCandidates: readonly string[]
  watchedDirMtimes: Record<string, number>
}

interface CacheEntry {
  result: readonly PageStylesheet[]
  deps: EntryStylesheetDeps
}

const cache = new Map<string, CacheEntry>()

/** `null` on any stat failure (deleted, unreadable, never existed) — never matches a recorded number, so this always misses. */
export function statMtimeOrNull(absPath: string): number | null {
  try {
    return statSync(absPath).mtimeMs
  } catch {
    return null
  }
}

export function entryStylesheetCacheKey(resolvedRoot: string, entryAbsPath: string): string {
  return `${resolvedRoot}::${entryAbsPath}`
}

/** The cached walk result for `cacheKey`, or `null` on any miss — see this module's doc for the exact invalidation contract. */
export function getCachedEntryStylesheets(cacheKey: string): readonly PageStylesheet[] | null {
  const entry = cache.get(cacheKey)
  if (!entry) return null

  for (const [absFile, recordedMtime] of Object.entries(entry.deps.fileMtimes)) {
    if (statMtimeOrNull(absFile) !== recordedMtime) return null
  }
  for (const [dir, recordedMtime] of Object.entries(entry.deps.watchedDirMtimes)) {
    if (statMtimeOrNull(dir) !== recordedMtime) return null
  }
  for (const candidate of entry.deps.missingCandidates) {
    if (existsSync(candidate)) return null
  }
  return entry.result
}

export function setCachedEntryStylesheets(
  cacheKey: string,
  result: readonly PageStylesheet[],
  deps: EntryStylesheetDeps,
): void {
  cache.set(cacheKey, { result, deps })
}

/** Test-only: drop every cached entry so a test doesn't leak state into the next one. */
export function clearEntryStylesheetCache(): void {
  cache.clear()
}
