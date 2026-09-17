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
import { readCompareVerdict, readPassingCompare, readPassingQualityCheck } from './pageVerificationStore'
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
  /**
   * A9, CREATIVE mode only — whether a clean `studio_quality_check` postdates
   * this page's last write. In creative mode this IS the verification: there
   * may be no reference to compare against at all, so a gate that demanded a
   * compare would be demanding a measurement the mode does not define.
   */
  readonly qualityCheckedSinceWrite?: boolean
  /**
   * A9, BALANCED mode only — the labels of the differing regions the last
   * post-write compare reported that the reply did NOT name.
   *
   * Empty (and absent) when the compare passed, when every region was named,
   * or when the caller passed no reply text to check against. Non-empty is
   * exactly the balanced bar failing: the screen was measured, it differs, and
   * nothing said why.
   */
  readonly unnamedRegions?: readonly string[]
}

/**
 * Does `reply` name `label`?
 *
 * Case-insensitive substring, and deliberately nothing cleverer. The label is
 * a short, unusual token (`R2@y412`) the compare result hands the agent and
 * the balanced prompt block tells it to quote verbatim — so a substring test
 * has no realistic false positive, and any fuzzier match would start accepting
 * "the second region" as having named something.
 */
function replyNamesRegion(reply: string, label: string): boolean {
  return reply.toLowerCase().includes(label.toLowerCase())
}

export interface PageWriteVerificationOptions {
  /**
   * W9-2/A9 — the mode this project is working at, from
   * `resolveProjectFidelityMode`. Each mode defines "verified" differently,
   * and the whole point of threading it here is that the gate never asks for
   * a measurement the mode does not define:
   *
   *   - `creative` — a clean `studio_quality_check` since the last write.
   *     There may be no reference at all.
   *   - `balanced` — a compare has RUN since the last write, and every
   *     differing region it reported is either gone or named in the reply.
   *   - `strict` — a passing compare since the last write, GRADED at strict.
   *
   * Omitted preserves the pre-W9-2 behaviour exactly — any post-write pass
   * counts — which is the right answer for a caller with no mode in hand.
   */
  readonly fidelityMode?: FidelityMode
  /**
   * The turn's final assistant reply, plain text — the balanced half of the
   * gate reads it to decide whether each still-differing region was named.
   *
   * Omitted (the digest's case: it runs at the START of the next turn, where
   * there is no reply yet) means no region can be credited as named, so a
   * failing balanced compare reads as unverified. That is the safe direction
   * and it is also the truth at that moment.
   */
  readonly replyText?: string
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
  options: PageWriteVerificationOptions = {},
): PageWriteVerificationEntry[] {
  const { fidelityMode, replyText } = options
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

    // A9 — the two mode-specific halves. Each is computed unconditionally (both
    // reads are one JSON file already in hand) but only one decides the
    // verdict, so the entry always carries the evidence for the mode it is
    // being graded under and never invents evidence for another.
    const qualityCheck = readPassingQualityCheck(dir, userKey, page.id)
    const qualityCheckedSinceWrite = qualityCheck !== null && qualityCheck.passedAtMs >= writes.lastAtMs

    const verdict = readCompareVerdict(dir, userKey, page.id)
    const comparedSinceWrite = verdict !== null && verdict.atMs >= writes.lastAtMs
    const unnamedRegions = comparedSinceWrite && !verdict.pass
      ? verdict.regionLabels.filter((label) => !replyText || !replyNamesRegion(replyText, label))
      : []

    const verifiedSinceWrite = fidelityMode === 'creative'
      // Creative: a clean quality check IS the verification. A passing compare
      // does not substitute — the creative DONE definition in the prompt asks
      // for the quality check by name, and a gate that accepted something else
      // would be enforcing a different bar than the one the agent was given.
      ? qualityCheckedSinceWrite
      : fidelityMode === 'balanced'
        // Balanced: measured, and every region that still differs is named.
        // A passing compare short-circuits — nothing differs, so there is
        // nothing to name — and it is checked through BOTH records, because
        // the two are written by different calls and a page that passed is
        // verified whether or not a verdict row happens to exist beside it.
        ? passedAfterWrite || (comparedSinceWrite && (verdict.pass || unnamedRegions.length === 0))
        // Strict and the no-mode caller: unchanged — a passing compare, graded
        // at a bar this project accepts.
        : passedAfterWrite && staleFidelityMode === undefined

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
      ...(fidelityMode === 'creative' ? { qualityCheckedSinceWrite } : {}),
      ...(unnamedRegions.length > 0 ? { unnamedRegions } : {}),
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
  // A9, FIRST: both of these are mode-specific bars, and every branch below
  // them would send the page to a measurement its mode does not define — a
  // creative screen to register a design reference it was never going to
  // have, a balanced screen to re-run a compare that already ran.
  if (entry.qualityCheckedSinceWrite === false) {
    return `"${entry.title}"${thrashNote} has not passed studio_quality_check since its last write. This project is working at CREATIVE fidelity, where that check is the verification — there may be no design to compare against, so a clean quality check and a passing typecheck are the whole bar. Call studio_quality_check({pages:["${entry.title}"]}) and fix what it returns before calling this done.`
  }
  if (entry.unnamedRegions && entry.unnamedRegions.length > 0) {
    const shown = entry.unnamedRegions.slice(0, 6).join(', ')
    const more = entry.unnamedRegions.length - Math.min(6, entry.unnamedRegions.length)
    return `"${entry.title}"${thrashNote} was measured, and ${entry.unnamedRegions.length} differing region${entry.unnamedRegions.length === 1 ? '' : 's'} ${entry.unnamedRegions.length === 1 ? 'is' : 'are'} still open: ${shown}${more > 0 ? `, and ${more} more` : ''}. This project is working at BALANCED fidelity, where the bar is that every differing region is either FIXED or NAMED as a deliberate deviation with a one-line reason. Fix them and re-run studio_compare, or name each remaining one in your reply using its label exactly as written above. A region you have not looked at is not a deliberate deviation.`
  }
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
