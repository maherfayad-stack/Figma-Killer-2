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
 *     spend. It is a ceiling on COST, and it ends the turn.
 *   - {@link toolCallFingerprint} plus {@link duplicateCallOutput} stop the
 *     SAME mutating call running twice. That is a bound on CORRECTNESS —
 *     the observed failure was one gesture the user asked for arriving in
 *     the file four times — and it never ends the turn, it answers the
 *     repeat from the first call's own result.
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
 * The machine-readable code on a suppressed repeat of a mutating call.
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
 * The identity of one mutating call: its name plus its arguments in a form
 * where key order cannot make two identical calls look different.
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
 * The structured answer to a repeated mutating call. `ok: false` because the
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
      `${toolName} was already called this turn with identical arguments and was NOT run again. ` +
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

/** The one sentence a round-capped turn ends on. Names the last tool so the transcript says what it was looping on. */
export function toolRoundCapMessage(maxRounds: number, lastToolName: string): string {
  const onTool = lastToolName ? ` The last tool it called was ${lastToolName}.` : ''
  return (
    `This turn reached its limit of ${maxRounds} tool rounds and was stopped.${onTool} ` +
    'Anything already written is saved as a draft — send another message to carry on.'
  )
}
