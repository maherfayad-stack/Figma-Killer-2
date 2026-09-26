/**
 * toolLoopBounds — the two ceilings one agent turn runs inside, and the
 * vocabulary each of them answers with (Z3).
 *
 * Split out of `toolLoop.ts` when that file passed the 700-line ceiling.
 * The seam is the one its own header draws: the loop is about TALKING to a
 * provider — streaming, retrying, translating messages — while everything
 * here is about REFUSING to keep going, and the two bounds are deliberately
 * different in kind.
 *
 *   - {@link MAX_TOOL_ROUNDS} caps how many provider rounds one turn may
 *     spend. It is a ceiling on COST. It ends the turn WELL (AI-10): the
 *     model is told {@link WIND_DOWN_ROUNDS_LEFT} rounds ahead, and the cap
 *     itself is one last request with tools off, for a summary — never an
 *     error event.
 *   - {@link TurnWriteLedger} plus {@link duplicateCallOutput} stop the
 *     SAME write running twice when nothing else was written in between.
 *     That is a bound on CORRECTNESS — the observed failure was one gesture
 *     the user asked for arriving in the file four times — and it never ends
 *     the turn, it answers the repeat from the first call's own result.
 *
 * The truncation vocabulary lives here too: a reply or a tool call the output
 * limit cut off is continued, never silently dropped (AI-11).
 *
 * Nothing here performs I/O or touches a provider, which is why every piece
 * of it is unit-testable on its own (`src/__tests__/ai/toolLoop.test.ts`).
 */
import type { AiToolOutput } from '@core/ai'
import { AGENT_TURN_ROUND_BUDGET, type ToolRefusalCode } from '@core/ai'

/**
 * How many provider rounds one turn may spend before the loop ends it itself.
 *
 * Read from {@link AGENT_TURN_ROUND_BUDGET}, never written here: A9 states
 * the same integer to the model in the system prompt and renders progress
 * against it in the panel, and a cap the prompt disagrees with is a control
 * that lies. `req.maxToolRounds` still overrides it per turn; nothing in
 * Studio raises it today, and a caller that does is choosing to pay for those
 * rounds.
 */
export const MAX_TOOL_ROUNDS = AGENT_TURN_ROUND_BUDGET

/**
 * The machine-readable code on a suppressed repeat of a write.
 *
 * Typed as a `ToolRefusalCode` so it cannot drift out of the shared
 * vocabulary: this code originates HERE rather than in a tool handler, which
 * is how it spent a wave outside `TOOL_REFUSAL_CODES` while every other code
 * was in it. Documented in `docs/features/agent.md`'s refusal table.
 */
export const DUPLICATE_CALL_CODE: ToolRefusalCode = 'duplicate-call'

/**
 * How much of the first call's `data` a `duplicate-call` result echoes back.
 * The prior result can be a whole page of HTML; the model needs to know WHAT
 * happened, not to be re-sent the evidence it already has in this same
 * transcript.
 */
const PRIOR_RESULT_DATA_CAP = 2_000

/**
 * The identity of one call: its name plus its arguments in a form where key
 * order cannot make two identical calls look different.
 *
 * Deliberately the canonical STRING rather than a digest of it. A hash would
 * buy a shorter map key and a collision risk whose symptom is the worst one
 * this whole mechanism has — a write silently not running because an unrelated
 * call happened to collide with it. The set is per turn and holds tens of
 * entries at most.
 *
 * The name is JSON-quoted rather than joined to the arguments by a separator:
 * a quoted string is self-terminating, so there is no separator character to
 * pick and no way for a name and an argument to run together into the same
 * key from opposite sides.
 */
export function toolCallFingerprint(toolName: string, input: unknown): string {
  return `${JSON.stringify(toolName)}${canonicalJson(input)}`
}

/** `JSON.stringify` with object keys sorted, recursively. `undefined` members are dropped, exactly as `JSON.stringify` drops them. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
}

/**
 * The per-turn record behind the duplicate-write bound (Z3, narrowed by AI-5).
 *
 * ## What counts as a duplicate
 *
 * A write whose fingerprint ({@link toolCallFingerprint}) was already recorded
 * **at the current write epoch**. The epoch advances once for every write that
 * LANDED (`ok: true`) this turn, so the key a lookup uses is really
 * `(toolName, canonical args, epoch)`:
 *
 *   - write A, write A — the second is answered from the first. Nothing moved
 *     between them, so running it again can only double the change (the
 *     four-copies-of-one-gesture failure this bound exists for).
 *   - write A, write B, write A — the third RUNS. B landed in between, so A is
 *     no longer the same instruction against the same state: "set width 390,
 *     set width 402, set width 390" is a model changing its mind, and
 *     answering the last call with the first one's result would leave the
 *     frame at 402 while telling the model it is at 390.
 *   - write A refused, write A — the second is answered: a refusal whose
 *     reason is in its own error text refuses identically when nothing
 *     changed.
 *   - write A refused, write B lands, write A — runs, because B may be exactly
 *     what A was refused for lacking.
 *
 * Observers never touch the ledger. Their `sideEffects` is `'none'` or
 * `'cache'`, the loop never suppresses a repeat of one (the second screenshot
 * after a fix is a new question with the same arguments), and they do not
 * advance the epoch (looking changes nothing a write depends on).
 *
 * Mutated in place, and only by the loop, one write at a time: a write always
 * runs in a group of its own (`groupToolCalls`), so two ledger updates can
 * never interleave.
 */
export interface TurnWriteLedger {
  /** How many writes have landed this turn. */
  epoch: number
  /** `fingerprint@epoch` → the outcome recorded there. */
  readonly outcomes: Map<string, AiToolOutput>
}

export function createTurnWriteLedger(): TurnWriteLedger {
  return { epoch: 0, outcomes: new Map() }
}

function ledgerKey(toolName: string, input: unknown, epoch: number): string {
  return `${toolCallFingerprint(toolName, input)}@${epoch}`
}

/** The outcome of an identical write at the CURRENT epoch, or `undefined` when this call must run. */
export function priorWriteOutcome(ledger: TurnWriteLedger, toolName: string, input: unknown): AiToolOutput | undefined {
  return ledger.outcomes.get(ledgerKey(toolName, input, ledger.epoch))
}

/**
 * Record a write that just ran. A LANDED write advances the epoch first and is
 * recorded at the new one — so an immediate identical repeat finds it, and a
 * repeat after any other landed write does not. A refused write changed
 * nothing, so it is recorded at the epoch it ran in and advances nothing.
 */
export function recordWriteOutcome(
  ledger: TurnWriteLedger,
  toolName: string,
  input: unknown,
  output: AiToolOutput,
): void {
  if (output.ok) ledger.epoch += 1
  ledger.outcomes.set(ledgerKey(toolName, input, ledger.epoch), output)
}

/**
 * The structured answer to a repeated write. `ok: false` because the
 * call did not run; `code` is the machine-readable reason and `priorResult` is
 * what the first one actually produced, so the model can carry on from a real
 * outcome instead of guessing at a refusal.
 *
 * The payload is carried in BOTH `data` and, serialized, inside `error` — and
 * that is not redundancy. Every consumer that hands a tool result to a model
 * renders a failed one as its `error` string alone and drops `data`:
 * `anthropic.ts`'s `toolOutputToContent`, the same shape in
 * `chatCompletions.ts` / `responses-shared.ts`, and `mcp/server.ts`'s
 * `CallToolResult` builder for every external MCP client. So `data` is what
 * Studio's own transcript and UI keep, and the `error` text is the only thing
 * the MODEL ever sees. A machine-readable code the model cannot read would be
 * no code at all.
 *
 * That premise is now pinned by
 * `src/__tests__/architecture/failed-tool-result-drops-data.test.ts` rather
 * than by this paragraph: if a renderer ever starts carrying `data`, the gate
 * fails and names the serialised copy below as the one to delete. Never both.
 */
export function duplicateCallOutput(toolName: string, prior: AiToolOutput): AiToolOutput {
  const payload = { code: DUPLICATE_CALL_CODE, toolName, priorResult: boundedPriorResult(prior) }
  return {
    ok: false,
    error:
      `${toolName} was already called this turn with identical arguments, and nothing else has been written since, so it was NOT run again. ` +
      'Read `priorResult` below and move on, or call it with different arguments.\n' +
      JSON.stringify(payload),
    data: payload,
  }
}

/** The prior result, minus its images and with an oversized `data` replaced by a truncated rendering of it. */
function boundedPriorResult(prior: AiToolOutput): { ok: boolean; error?: string; data?: unknown } {
  const bounded: { ok: boolean; error?: string; data?: unknown } = { ok: prior.ok }
  if (prior.error !== undefined) bounded.error = prior.error
  if (prior.data !== undefined) {
    const json = JSON.stringify(prior.data) ?? ''
    bounded.data = json.length <= PRIOR_RESULT_DATA_CAP ? prior.data : `${json.slice(0, PRIOR_RESULT_DATA_CAP)}… [truncated]`
  }
  return bounded
}


// ---------------------------------------------------------------------------
// Ending well: the wind-down, the summary round, and truncation (AI-10, AI-11)
// ---------------------------------------------------------------------------

/**
 * How many rounds before the ceiling the model is told it is running out.
 *
 * The ceiling used to arrive unannounced and end the turn with an error, so a
 * model mid-way through a fix loop was cut off with files half written and no
 * report. Three rounds is one write, one look and one reply.
 */
export const WIND_DOWN_ROUNDS_LEFT = 3

/** Appended to the tool results of the round that leaves {@link WIND_DOWN_ROUNDS_LEFT} rounds. */
export function windDownNote(roundsLeft: number): string {
  return (
    `[Studio] ${roundsLeft} tool rounds are left in this turn. Finish what you are doing now: `
    + 'complete the write in progress, verify it once, and report. Do not start anything new.'
  )
}

/**
 * Appended to the tool results of the LAST allowed round. The loop then runs
 * one more request with tools switched off, so the turn ends on the model's
 * own account of itself instead of an error.
 */
export function roundCapSummaryNote(maxRounds: number): string {
  return (
    `[Studio] This turn has used all ${maxRounds} of its tool rounds, and your tools are now switched off. `
    + 'Reply to the user now, in a few lines: what you did, what you verified and how, and what is left undone. '
    + 'Anything already written is saved. Do not claim anything you did not check.'
  )
}

/**
 * How many times one turn continues a reply the output limit cut off. Each
 * continuation is also a round, so the round ceiling bounds it anyway; this
 * stops a model that answers every "continue" with more than the limit again.
 */
export const MAX_TRUNCATION_CONTINUATIONS = 2

/** The user-side note that asks for the rest of a reply the output limit cut off. */
export const TRUNCATED_REPLY_NOTE =
  '[Studio] Your last reply was cut off by the output limit. Continue exactly where it stopped, without repeating what you already wrote.'

/**
 * The result a tool call gets when the output limit cut it off before its
 * arguments were complete. It never ran — running it on half its arguments
 * would write half a file — and the model is told how to avoid the limit.
 */
export const TRUNCATED_TOOL_CALL_ERROR =
  'This call was cut off by the output limit before its arguments were complete, so it did NOT run. '
  + 'Issue it again, smaller: write a large file in parts (create it with the first part, then add the rest with edits), '
  + 'or split a long list of edits across several calls.'
