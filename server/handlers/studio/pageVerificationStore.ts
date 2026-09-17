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
 * `.studio/cache/agent/<userKey>/` — deliberately, not `.studio/references/`
 * or `.studio/boards.json`'s durable tier. Every entry here is fully
 * regenerable (re-run `studio_compare`) and gitignored the same way
 * `styleCompile.ts`'s compiled-CSS cache already is (the `.studio/cache/`
 * glob in `.gitignore`) — no new ignore rule needed.
 *
 * Per ACCOUNT, because the gate it feeds is: user A's passing compare must
 * not satisfy user B's Stop gate for a page B just rewrote. See
 * `agentUserScope.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { agentCacheDir } from './agentUserScope'
import { FIDELITY_MODES, type FidelityMode } from './fidelityMode'
import { DESIGN_POLICIES, type DesignPolicy } from './designPolicy'

const PageVerificationEntrySchema = Type.Object({
  /** When this page last had a PASSING `studio_compare` verdict, epoch ms. */
  passedAtMs: Type.Number(),
  /** Which registered reference it passed against — display/debugging only, never re-validated. */
  referenceId: Type.String({ minLength: 1 }),
  /**
   * W9-2 — the fidelity mode this pass was GRADED at, which is not the same
   * question as "did it pass". A pass at `balanced` (92% / 6%) does not
   * satisfy a project working at `strict` (99% / 0.5% / area floor), and
   * before this field the Stop gate could not tell the two apart: it read a
   * boolean and let a loose pass close a strict turn. Optional so a record
   * written before this field still validates; `pageWriteVerification.ts`
   * treats a missing value as "not known to be strict", which is the safe
   * direction — it asks for one more compare, it never waves a page through.
   */
  fidelityMode: Type.Optional(Type.Union(FIDELITY_MODES.map((m) => Type.Literal(m)))),
})

/**
 * A9 — the last PASSING `studio_quality_check` for a page.
 *
 * Its own record rather than a second field on the compare entry, because it
 * answers a different question and is the ONLY answer available in creative
 * mode: a from-scratch screen has no reference, so "has it been verified since
 * it was written" cannot be a compare. Recorded on a run that produced no
 * finding at or above the policy's error severity — see
 * `designPolicy.ts`'s `findingSeverity`.
 */
const PageQualityCheckEntrySchema = Type.Object({
  /** When this page last had a CLEAN `studio_quality_check`, epoch ms. */
  passedAtMs: Type.Number(),
  /** How many findings the run returned in total, error-severity or not. Display only — a clean-at-`free` page with eleven suppressed token findings should read differently from one with none. */
  findingCount: Type.Number(),
  /** The design policy the run was graded under. A `free` pass does not satisfy a project that has since moved to `follow`, for the same reason a `balanced` compare does not satisfy `strict`. */
  designPolicy: Type.Optional(Type.Union(DESIGN_POLICIES.map((p) => Type.Literal(p)))),
})

/**
 * A9 — the LAST compare verdict for a page, pass or fail.
 *
 * `pages` above records only passes, which is all the strict gate needs. The
 * balanced gate needs the failing case too: its bar is "every differing region
 * is fixed or NAMED", and a gate that cannot see the regions can only ask for
 * another compare forever.
 *
 * Region labels, not rectangles: the gate's question is whether the reply
 * mentions each one, and a label is the smallest thing that makes that
 * answerable. `compareRegionLabel` builds them and `studio_compare` returns
 * the same strings to the model, so the string the agent is asked to quote is
 * the string the gate looks for.
 */
const PageCompareVerdictEntrySchema = Type.Object({
  atMs: Type.Number(),
  pass: Type.Boolean(),
  /** One label per differing region the verdict reported, worst first. Empty on a pass. */
  regionLabels: Type.Array(Type.String()),
})

const PageVerificationStoreSchema = Type.Object({
  version: Type.Literal(1),
  pages: Type.Record(Type.String(), PageVerificationEntrySchema),
  /** Optional so every store written before A9 still validates as-is. */
  qualityChecks: Type.Optional(Type.Record(Type.String(), PageQualityCheckEntrySchema)),
  compareVerdicts: Type.Optional(Type.Record(Type.String(), PageCompareVerdictEntrySchema)),
})
type PageVerificationStore = Static<typeof PageVerificationStoreSchema>
export type PageVerificationEntry = Static<typeof PageVerificationEntrySchema>
export type PageQualityCheckEntry = Static<typeof PageQualityCheckEntrySchema>
export type PageCompareVerdictEntry = Static<typeof PageCompareVerdictEntrySchema>

/**
 * The stable, quotable name of one differing region: `R1@y412`.
 *
 * Short enough that an agent will actually paste it into a sentence, unique
 * enough that two regions on one screen never collide, and stable across a
 * recapture as long as the region is (the index is worst-first and the top
 * edge is the region's own geometry). Built here — beside the gate that reads
 * it back — so the tool and the gate can never disagree about the format.
 */
export function compareRegionLabel(index: number, top: number): string {
  return `R${index + 1}@y${Math.round(top)}`
}

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

/**
 * The store's filename, exported because a second reader cares only whether a
 * file by this name exists ANYWHERE under the project's cache — see
 * `onboardingFacts.ts`, which globs both the legacy `.studio/cache/` and the
 * per-user `agent/<hash>/` directory. A literal copied into that module would
 * drift the day this path moves.
 */
export const PAGE_VERIFICATION_FILE_NAME = 'pageVerification.json'

function storeFile(dir: string, userKey: string): string {
  return join(agentCacheDir(dir, userKey), PAGE_VERIFICATION_FILE_NAME)
}

function readStore(dir: string, userKey: string): PageVerificationStore {
  const file = storeFile(dir, userKey)
  if (!existsSync(file)) return emptyStore()
  const raw = readFileSync(file, 'utf8')
  return parseJsonWithFallback(raw, PageVerificationStoreSchema, emptyStore())
}

function writeStore(dir: string, userKey: string, store: PageVerificationStore): void {
  const file = storeFile(dir, userKey)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2))
}

/** Records `pageId` as passing right now — called by `studio_compare`'s handler for every result that came back `pass: true`, cache hit or fresh capture alike (a cache hit still means the page's CURRENT on-disk bytes pass, since the cache is itself mtime-gated). Never throws; a write failure is logged and dropped — a missed record just means the next Stop-hook check treats the page as unverified, which is the safe direction to fail in. */
export function recordPassingCompare(
  dir: string,
  userKey: string,
  pageId: string,
  referenceId: string,
  fidelityMode: FidelityMode,
  atMs: number = Date.now(),
): void {
  try {
    const store = readStore(dir, userKey)
    writeStore(dir, userKey, { ...store, pages: { ...store.pages, [pageId]: { passedAtMs: atMs, referenceId, fidelityMode } } })
  } catch (err) {
    console.error('[pageVerificationStore] failed to record a passing compare — continuing:', err)
  }
}

/** The last passing-compare record for `pageId`, or `null` if it has never passed (or the store is unreadable). Never throws. */
export function readPassingCompare(dir: string, userKey: string, pageId: string): PageVerificationEntry | null {
  try {
    return readStore(dir, userKey).pages[pageId] ?? null
  } catch (err) {
    console.error('[pageVerificationStore] failed to read — treating as unverified:', err)
    return null
  }
}

/**
 * A9 — records a CLEAN `studio_quality_check` for `pageId`. Called by the
 * tool's handler for every page whose run returned no finding at error
 * severity under the resolved policy. Never throws, same posture and same
 * safe direction as `recordPassingCompare`: a missed record means one more
 * check, never a page waved through.
 */
export function recordPassingQualityCheck(
  dir: string,
  userKey: string,
  pageId: string,
  findingCount: number,
  designPolicy: DesignPolicy,
  atMs: number = Date.now(),
): void {
  try {
    const store = readStore(dir, userKey)
    writeStore(dir, userKey, {
      ...store,
      qualityChecks: { ...(store.qualityChecks ?? {}), [pageId]: { passedAtMs: atMs, findingCount, designPolicy } },
    })
  } catch (err) {
    console.error('[pageVerificationStore] failed to record a passing quality check — continuing:', err)
  }
}

/** The last clean-quality-check record for `pageId`, or `null`. Never throws. */
export function readPassingQualityCheck(dir: string, userKey: string, pageId: string): PageQualityCheckEntry | null {
  try {
    return readStore(dir, userKey).qualityChecks?.[pageId] ?? null
  } catch (err) {
    console.error('[pageVerificationStore] failed to read the quality-check record — treating as unchecked:', err)
    return null
  }
}

/**
 * A9 — records the LAST compare verdict for `pageId`, pass or fail, with the
 * labels of every differing region it reported.
 *
 * Called for every `ok` result, unlike `recordPassingCompare`, because the
 * balanced Stop gate's question is about the FAILING case: which regions are
 * still open, so it can ask whether the reply named them.
 */
export function recordCompareVerdict(
  dir: string,
  userKey: string,
  pageId: string,
  pass: boolean,
  regionLabels: readonly string[],
  atMs: number = Date.now(),
): void {
  try {
    const store = readStore(dir, userKey)
    writeStore(dir, userKey, {
      ...store,
      compareVerdicts: { ...(store.compareVerdicts ?? {}), [pageId]: { atMs, pass, regionLabels: [...regionLabels] } },
    })
  } catch (err) {
    console.error('[pageVerificationStore] failed to record a compare verdict — continuing:', err)
  }
}

/** The last compare verdict for `pageId`, pass or fail, or `null` if it has never been compared. Never throws. */
export function readCompareVerdict(dir: string, userKey: string, pageId: string): PageCompareVerdictEntry | null {
  try {
    return readStore(dir, userKey).compareVerdicts?.[pageId] ?? null
  } catch (err) {
    console.error('[pageVerificationStore] failed to read the compare verdict — treating as uncompared:', err)
    return null
  }
}
