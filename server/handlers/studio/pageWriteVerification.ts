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
import type { FidelityMode } from './fidelityMode'

/** More than this many writes to the same page in one turn is the thrash pattern WS-9 measured (58 writes / 4 screens ≈ 14/screen) — chosen well below that so the digest surfaces the pattern before it reaches double digits, while staying above the 1-Write-plus-a-couple-of-fix-Edits shape of ordinary, healthy work. */
export const WRITE_THRASH_THRESHOLD = 5

export interface PageWriteVerificationEntry {
  readonly pageId: string
  readonly title: string
  readonly writeCount: number
  readonly lastWrittenAtMs: number
  readonly hasReference: boolean
  readonly referenceId?: string
  /**
   * Set when this page HAS candidate references but resolution refused to
   * pick between them — the message naming the ids and the `referenceId`
   * argument that settles it.
   *
   * Kept distinct from `hasReference: false` because the two need opposite
   * instructions: an unarmed page is told to register a design, and telling an
   * ambiguous page the same thing sends the agent to add a third candidate to
   * a set it already cannot choose from.
   */
  readonly referenceAmbiguity?: string
  /** Epoch ms of the last PASSING `studio_compare` for this page, if any — regardless of whether it happened before or after the write being reported. */
  readonly passingCompareAtMs?: number
  /**
   * `true` only when a passing compare exists AND it happened AT OR AFTER
   * `lastWrittenAtMs` — a pass recorded before the write in question proves
   * nothing about the code as it stands now — AND (W9-2) that pass was graded
   * at a bar this project accepts. See `staleFidelityMode`.
   */
  readonly verifiedSinceWrite: boolean
  /**
   * Set when a passing, post-write compare EXISTS but was graded too loosely
   * for the mode this project is working at — e.g. the page passed at
   * `balanced` (92% / 6%) and the project is now `strict` (99% / 0.5% plus an
   * absolute per-region area floor). Carries the mode it actually passed at.
   *
   * Its own field rather than a silent `verifiedSinceWrite: false`, because
   * the instruction is completely different: this page does not need a design
   * reference and does not need to be rewritten, it needs ONE more
   * `studio_compare` call. Telling it what an unverified page is told would
   * send it to redo work that is probably already correct.
   */
  readonly staleFidelityMode?: FidelityMode
}

/**
 * One entry per page that appears in the turn's write log, matched against
 * `pages` by `resolvePageSourceFile`. A page with zero matching writes is
 * simply absent — this is never a full page listing, only the ones that
 * moved. Never throws (a bad reference-resolution or store read degrades
 * that ONE page to `hasReference: false`, never aborts the batch).
 *
 * Both halves of the question — what was written, and what has passed a
 * compare — are read from ONE account's cache (`userKey`, see
 * `agentUserScope.ts`). A gate that could be satisfied by a colleague's
 * compare, or tripped by a colleague's write, is not a gate on this session.
 */
export function computePageWriteVerification(
  dir: string,
  userKey: string,
  pages: readonly Page[],
  /**
   * W9-2 — the mode this project is working at, from
   * `resolveProjectFidelityMode`. Only `strict` changes any verdict here:
   * under strict, a pass recorded at a looser mode is not a pass, because it
   * cleared a lower bar than the one the agent was told it was working to.
   * Omitted (the default) preserves the pre-W9-2 behaviour exactly — any
   * post-write pass counts — which is correct for `creative` and `balanced`,
   * whose bars a strict pass also clears.
   */
  fidelityMode?: FidelityMode,
): PageWriteVerificationEntry[] {
  const writeLog = readTurnWriteLog(dir, userKey)
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
    let referenceAmbiguity: string | undefined
    try {
      const resolved = resolveDesignReference(dir, page.id, undefined)
      if (resolved.ok) {
        hasReference = true
        referenceId = resolved.reference.id
      } else if (resolved.failure === 'ambiguous') {
        referenceAmbiguity = resolved.error
      }
    } catch (err) {
      console.error('[pageWriteVerification] reference resolution failed — treating as unarmed:', err)
    }

    const passing = readPassingCompare(dir, userKey, page.id)
    const passedAfterWrite = passing !== null && passing.passedAtMs >= writes.lastAtMs
    // A record with no mode predates W9-2 and is treated as "not known to be
    // strict" — one extra compare, never a page waved through.
    const staleFidelityMode = passedAfterWrite && fidelityMode === 'strict' && passing.fidelityMode !== 'strict'
      ? (passing.fidelityMode ?? 'balanced')
      : undefined

    results.push({
      pageId: page.id,
      title: page.title,
      writeCount: writes.count,
      lastWrittenAtMs: writes.lastAtMs,
      hasReference,
      ...(referenceId ? { referenceId } : {}),
      ...(referenceAmbiguity ? { referenceAmbiguity } : {}),
      ...(passing ? { passingCompareAtMs: passing.passedAtMs } : {}),
      ...(staleFidelityMode ? { staleFidelityMode } : {}),
      verifiedSinceWrite: passedAfterWrite && staleFidelityMode === undefined,
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
 *
 * Three cases, three different instructions — and the ambiguous one is here
 * because it is the one this gate used to get WRONG. A page whose references
 * cannot be told apart resolves to NO reference, so it fell into the unarmed
 * branch and was told to register a design: the single worst move available,
 * since it already holds more candidates than it can choose between and a new
 * one makes the next call refuse identically.
 */
export function describeUnverifiedPage(entry: PageWriteVerificationEntry, figmaConfigured: boolean): string {
  const thrashNote = isThrashing(entry) ? ` (written ${entry.writeCount}x this turn — compose the whole screen and write once)` : ''
  // W9-2, FIRST: this page's problem is the BAR it was measured against, not
  // a missing measurement. Every branch below would send it to redo work it
  // has probably already done.
  if (entry.staleFidelityMode) {
    return `"${entry.title}"${thrashNote} passed studio_compare at ${entry.staleFidelityMode} fidelity, but this project is working at strict — a strict pass needs 99% similarity, a 0.5%-of-frame region ceiling and the per-region area floor that catches a small element rendered entirely wrong. Re-measure it: studio_compare({pages:["${entry.title}"], fidelityMode:"strict"}). Do not rewrite the screen first; it may already pass.`
  }
  // Ambiguity FIRST, because an ambiguous page is also `hasReference: false`
  // and the unarmed branch's instruction ("register a design reference") is
  // actively wrong for it — it sends the agent to add a third candidate to a
  // set it already cannot choose from. The refusal message carries the ids and
  // says how to settle it; all this adds is the concrete call that ends the
  // block, which is the one thing the gate owes a model it just stopped.
  if (entry.referenceAmbiguity) {
    return `"${entry.title}"${thrashNote} has not passed studio_compare since its last write, and its design reference could not be chosen for it. ${entry.referenceAmbiguity} Then call studio_compare({pages:["${entry.title}"], referenceId:"<the id you picked>"}) before calling this done.`
  }
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
