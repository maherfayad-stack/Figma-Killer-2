/**
 * pageVerificationStore — a durable, per-project record of the last PASSING
 * `studio_compare` verdict for each page, keyed by page id.
 *
 * ## Why this exists (the write-verification gate — "kill the edit thrash")
 *
 * `compareVerdictCache.ts` already remembers a verdict, but only IN-MEMORY,
 * process-scoped, keyed by a cache key that also includes the threshold
 * knobs — it answers "would a repeat call be free", not "has this page ever
 * genuinely passed, and when". Two callers need exactly that second
 * question, and neither one is `studio_compare` itself:
 *
 *   - `pageWriteVerification.ts` (the shared write/verify-status computation
 *     `liveDigest.ts`'s digest lines and the Stop-hook gate both consume) —
 *     "does this page's CURRENT on-disk state have a passing compare AFTER
 *     its last write" needs a timestamp that survives the server process
 *     restarting AND is readable from a completely separate `bun` process
 *     (the Stop hook script, spawned by the `claude` CLI, shares nothing
 *     with the running admin server except the filesystem).
 *
 * A pass is recorded; a fail is not. Absence therefore means exactly one of
 * "never compared" or "last compare failed" — `pageWriteVerification.ts`
 * treats both the same way (unverified), so the distinction costs nothing to
 * skip and keeps this store's shape trivial.
 *
 * ## Where it lives
 *
 * `.studio/cache/` — deliberately, not `.studio/references/` or
 * `.studio/boards.json`'s durable tier. Every entry here is fully
 * regenerable (re-run `studio_compare`) and gitignored the same way
 * `styleCompile.ts`'s compiled-CSS cache already is (the `.studio/cache/`
 * glob in `.gitignore`) — no new ignore rule needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

const PageVerificationEntrySchema = Type.Object({
  /** When this page last had a PASSING `studio_compare` verdict, epoch ms. */
  passedAtMs: Type.Number(),
  /** Which registered reference it passed against — display/debugging only, never re-validated. */
  referenceId: Type.String({ minLength: 1 }),
})

const PageVerificationStoreSchema = Type.Object({
  version: Type.Literal(1),
  pages: Type.Record(Type.String(), PageVerificationEntrySchema),
})
type PageVerificationStore = Static<typeof PageVerificationStoreSchema>
export type PageVerificationEntry = Static<typeof PageVerificationEntrySchema>

/**
 * A FRESH empty store every call — never a shared module-level constant.
 * `recordPassingCompare` mutates whatever `readStore` hands it
 * (`store.pages[pageId] = …`) before writing it back; handing out one
 * shared object here would mean the first project ever compared with no
 * prior store on disk POISONS every other project's "no store yet" read for
 * the lifetime of the process — exactly the cross-test (and, in production,
 * cross-project) leak this function exists to prevent.
 */
function emptyStore(): PageVerificationStore {
  return { version: 1, pages: {} }
}

function storeFile(dir: string): string {
  return join(dir, '.studio', 'cache', 'pageVerification.json')
}

function readStore(dir: string): PageVerificationStore {
  const file = storeFile(dir)
  if (!existsSync(file)) return emptyStore()
  const raw = readFileSync(file, 'utf8')
  return parseJsonWithFallback(raw, PageVerificationStoreSchema, emptyStore())
}

function writeStore(dir: string, store: PageVerificationStore): void {
  const file = storeFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2))
}

/** Records `pageId` as passing right now — called by `studio_compare`'s handler for every result that came back `pass: true`, cache hit or fresh capture alike (a cache hit still means the page's CURRENT on-disk bytes pass, since the cache is itself mtime-gated). Never throws; a write failure is logged and dropped — a missed record just means the next Stop-hook check treats the page as unverified, which is the safe direction to fail in. */
export function recordPassingCompare(dir: string, pageId: string, referenceId: string, atMs: number = Date.now()): void {
  try {
    const store = readStore(dir)
    writeStore(dir, { ...store, pages: { ...store.pages, [pageId]: { passedAtMs: atMs, referenceId } } })
  } catch (err) {
    console.error('[pageVerificationStore] failed to record a passing compare — continuing:', err)
  }
}

/** The last passing-compare record for `pageId`, or `null` if it has never passed (or the store is unreadable). Never throws. */
export function readPassingCompare(dir: string, pageId: string): PageVerificationEntry | null {
  try {
    return readStore(dir).pages[pageId] ?? null
  } catch (err) {
    console.error('[pageVerificationStore] failed to read — treating as unverified:', err)
    return null
  }
}
