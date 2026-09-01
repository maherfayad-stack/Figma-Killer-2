/**
 * pageWriteVerification — for every page written in the tracked turn, was it
 * ever measured afterward, and how many times was it written.
 *
 * The one computation two very different consumers share:
 *
 *   - `server/ai/tools/studio/liveDigest.ts` — reports it as VISIBILITY, at
 *     the start of the NEXT turn ("here is what you wrote last time and
 *     never verified"). Runs in-process, already holds a loaded `Page[]`.
 *   - `hooks/stopGateCheck.ts` — enforces it as a GATE, at the end of THIS
 *     turn, from a standalone `bun` process spawned by the `claude` CLI's own
 *     `Stop` hook, with no access to anything the admin server holds in
 *     memory. Loads its own `Page[]` first.
 *
 * Both need the identical verdict — a page flagged in the digest and a page
 * that blocks the Stop hook must be the same set, computed the same way, or
 * the digest would train the model to distrust its own gate. Hence one
 * function, taking an already-loaded `pages` array rather than loading it
 * itself, so `liveDigest.ts` never pays `loadStudioPages` twice (see that
 * module's "trap #11" cost-discipline note) while the standalone hook script
 * still can.
 *
 * ## Known limitation
 *
 * Matches ONLY a page's own component source file (`resolvePageSourceFile`)
 * against the turn's write log — a stylesheet-only edit (`Screen.module.css`
 * with the component file untouched) is not tracked as "written". The
 * observed failure this exists to catch (WS-9's 58-writes-across-4-screens
 * session) was overwhelmingly `.tsx` composition, not CSS-only churn;
 * widening this to a page's stylesheets too would mean pulling in
 * `collectPageStylesheets`'s full parse (`compareVerdictCache.ts` already
 * pays that cost, but only on a `studio_compare` MISS — paying it again here,
 * on every Stop attempt after ANY write, is the wrong trade for a case this
 * rare). Revisit if stylesheet-only edits turn out to need the same net.
 */
import type { Page } from '@core/page-tree'
import { resolvePageSourceFile } from './pageSourceFile'
import { readTurnWriteLog } from './turnWriteLog'
import { readPassingCompare } from './pageVerificationStore'
import { resolveDesignReference } from '../../ai/mcp/tools/studio/referenceResolve'

/** More than this many writes to the same page in one turn is the thrash pattern WS-9 measured (58 writes / 4 screens ≈ 14/screen) — chosen well below that so the digest surfaces the pattern before it reaches double digits, while staying above the 1-Write-plus-a-couple-of-fix-Edits shape of ordinary, healthy work. */
export const WRITE_THRASH_THRESHOLD = 5

export interface PageWriteVerificationEntry {
  readonly pageId: string
  readonly title: string
  readonly writeCount: number
  readonly lastWrittenAtMs: number
  readonly hasReference: boolean
  readonly referenceId?: string
  /** Epoch ms of the last PASSING `studio_compare` for this page, if any — regardless of whether it happened before or after the write being reported. */
  readonly passingCompareAtMs?: number
  /** `true` only when a passing compare exists AND it happened AT OR AFTER `lastWrittenAtMs` — a pass recorded before the write in question proves nothing about the code as it stands now. */
  readonly verifiedSinceWrite: boolean
}

/**
 * One entry per page that appears in the turn's write log, matched against
 * `pages` by `resolvePageSourceFile`. A page with zero matching writes is
 * simply absent — this is never a full page listing, only the ones that
 * moved. Never throws (a bad reference-resolution or store read degrades
 * that ONE page to `hasReference: false`, never aborts the batch).
 */
export function computePageWriteVerification(dir: string, pages: readonly Page[]): PageWriteVerificationEntry[] {
  const writeLog = readTurnWriteLog(dir)
  if (writeLog.length === 0) return []

  const writesByFile = new Map<string, { count: number; lastAtMs: number }>()
  for (const entry of writeLog) {
    const existing = writesByFile.get(entry.file)
    if (existing) {
      existing.count += 1
      existing.lastAtMs = Math.max(existing.lastAtMs, entry.atMs)
    } else {
      writesByFile.set(entry.file, { count: 1, lastAtMs: entry.atMs })
    }
  }
  if (writesByFile.size === 0) return []

  const results: PageWriteVerificationEntry[] = []
  for (const page of pages) {
    const rel = resolvePageSourceFile(page)
    if (!rel) continue
    const writes = writesByFile.get(rel)
    if (!writes) continue

    let hasReference = false
    let referenceId: string | undefined
    try {
      const resolved = resolveDesignReference(dir, page.id, undefined)
      if (resolved.ok) {
        hasReference = true
        referenceId = resolved.reference.id
      }
    } catch (err) {
      console.error('[pageWriteVerification] reference resolution failed — treating as unarmed:', err)
    }

    const passing = readPassingCompare(dir, page.id)
    const verifiedSinceWrite = passing !== null && passing.passedAtMs >= writes.lastAtMs

    results.push({
      pageId: page.id,
      title: page.title,
      writeCount: writes.count,
      lastWrittenAtMs: writes.lastAtMs,
      hasReference,
      ...(referenceId ? { referenceId } : {}),
      ...(passing ? { passingCompareAtMs: passing.passedAtMs } : {}),
      verifiedSinceWrite,
    })
  }
  return results
}

/** `true` when this entry is dense enough with unverified rewrites to name the thrash pattern explicitly — shared by the digest line and the gate reason so the two never disagree about which pages are thrashing. */
function isThrashing(entry: PageWriteVerificationEntry): boolean {
  return entry.writeCount >= WRITE_THRASH_THRESHOLD
}

/**
 * The specific, actionable instruction for a page that is NOT yet verified —
 * shared by the Stop-hook gate's block reason and the digest's action line,
 * so a model reading the digest sees the exact sentence the gate would use if
 * it stopped without doing this. `figmaConfigured` picks the arm-the-ruler
 * phrasing: a project with a live Figma connector is told to export and
 * register; one without is told to register directly or fall back to
 * `studio_quality_check` for a from-scratch brief with nothing to match.
 */
export function describeUnverifiedPage(entry: PageWriteVerificationEntry, figmaConfigured: boolean): string {
  const thrashNote = isThrashing(entry) ? ` (written ${entry.writeCount}x this turn — compose the whole screen and write once)` : ''
  if (!entry.hasReference) {
    const howToArm = figmaConfigured
      ? `export it from the Figma connector, then call studio_register_design_reference with pageId:"${entry.pageId}"`
      : `call studio_register_design_reference with pageId:"${entry.pageId}" (or, if this is a from-scratch screen with nothing to match, call studio_quality_check instead)`
    return `"${entry.title}"${thrashNote} has NO design reference registered — ${howToArm}, then studio_compare, before calling this done.`
  }
  return `"${entry.title}"${thrashNote} has not passed studio_compare since its last write — call studio_compare({pages:["${entry.title}"]}) before calling this done.`
}

/** One digest line per page written this turn — full detail when action is needed, a single word when it is not (the digest's own cost-discipline rule: state only what is actionable). A verified page that is ALSO thrashing still gets the thrash note; thrashing is a behavioural signal independent of verification status. */
export function describePageForDigest(entry: PageWriteVerificationEntry, figmaConfigured: boolean): string {
  if (!entry.verifiedSinceWrite) return describeUnverifiedPage(entry, figmaConfigured)
  return isThrashing(entry)
    ? `"${entry.title}": verified; written ${entry.writeCount}x this turn — compose the whole screen and write once.`
    : `"${entry.title}": verified.`
}
