/**
 * Provider-agnostic multi-turn tool loop for the direct HTTP drivers.
 *
 * Owns the agentic loop that the provider SDKs used to own:
 *
 *   1. Map the canonical `AiMessage[]` history into the provider's native
 *      message array (`adapter.mapHistory`).
 *   2. POST `{ ...body, stream: true }` and parse the SSE response into
 *      canonical `AiStreamEvent`s via a per-turn `TurnTranslator`.
 *   3. When the turn ends with tool calls, execute them (server handler or
 *      browser bridge) via `executeAiTool`, append the assistant `tool_use`
 *      turn + the `tool_result` turn to the working message array, and
 *      re-POST.
 *   4. Loop until the provider signals no more tool calls, then emit one
 *      aggregated `usage` event.
 *
 * Each provider supplies the small `ProviderAdapter` of pure functions; the
 * loop, SSE plumbing, tool dispatch, abort handling, and usage aggregation
 * live here once.
 *
 * ## The history is append-only
 *
 * The provider-native message array this loop builds is only ever appended to.
 * Nothing rewrites a message a previous round already sent — a mutated prefix
 * invalidates every prompt-cache entry downstream of it, and the whole point of
 * the cache breakpoints the adapters place (see `messageCacheBreakpoints`) is
 * that the prefix stays byte-identical round over round. Heavy-evidence elision
 * is therefore a per-request PROJECTION (`projectHeavyElision`), computed fresh
 * for each POST and thrown away, never written back.
 *
 * Abort: `req.signal` is passed straight to `fetch`. On abort (or an
 * `AbortError` mid-stream) the generator returns cleanly with no `error`
 * event — matching the prior SDK behaviour.
 *
 * ## The loop has two ceilings (Z3), and ends well at the first (AI-10)
 *
 *   - {@link MAX_TOOL_ROUNDS} (= `AGENT_TURN_ROUND_BUDGET`) caps how many
 *     tool rounds one turn may spend. {@link WIND_DOWN_ROUNDS_LEFT} rounds
 *     before it, the tool results carry a note telling the model to finish,
 *     verify and report. The last allowed round's results carry a second
 *     note, and the loop then makes ONE more request with tools switched off
 *     (`toolChoice: 'none'`), so the turn ends on the model's own summary. It
 *     used to end on an `error` event mid-work.
 *   - A per-turn write ledger suppresses a REPEATED WRITE. The second
 *     identical `(toolName, canonical args)` write in one turn, with no other
 *     write landing in between, is not executed; it is answered with a
 *     structured `{ code: 'duplicate-call', priorResult }` result carrying the
 *     first call's own outcome. See `TurnWriteLedger` for the four cases.
 *
 * Only `sideEffects: 'write'` tools are ledgered. Observers (`'none'`,
 * `'cache'`) are exempt on purpose: re-reading, re-capturing or re-checking
 * after a write is how the model checks its own work (AI-5).
 *
 * ## What a failed request does (AI-8, AI-11)
 *
 *   - **Transient** — a 408/429/5xx/529, a dropped connection, or a stream
 *     `overloaded_error` before the model produced anything: retried up to
 *     {@link MAX_TRANSIENT_RETRIES} times with backoff, honouring the
 *     provider's `retry-after`, with a quiet `retrying` event for the panel.
 *   - **The reasoning parameters were refused** — a 400 naming them: the round
 *     is re-sent without them, and they stay off for the rest of the turn.
 *   - **Replay overflow** — one retry with historical user images elided.
 *   - Anything else ends the turn with one `error` event.
 *
 * ## A truncated response continues (AI-11)
 *
 * When the output limit cuts a response off, `TurnResult.truncated` says so.
 * A tool call whose arguments were cut off is never run on half its input:
 * it is answered with {@link TRUNCATED_TOOL_CALL_ERROR}, which tells the model
 * how to fit. A plain reply that was cut off is continued with a user-side
 * note, at most {@link MAX_TRUNCATION_CONTINUATIONS} times. It used to read
 * as a normal stop, and the truncated tool call was silently dropped.
 */

import type {
  AiContentBlock,
  AiMessage,
  AiStreamEvent,
  AiTool,
} from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import { parseSseStream } from './sse'
import type { ProviderAdapter, ProviderRequestOptions, TurnResult, TurnToolResult } from './toolLoopTypes'
import { isAbortError, classifyHttpFailure } from './errors'
import {
  MAX_TOOL_ROUNDS,
  MAX_TRUNCATION_CONTINUATIONS,
  TRUNCATED_REPLY_NOTE,
  TRUNCATED_TOOL_CALL_ERROR,
  WIND_DOWN_ROUNDS_LEFT,
  createTurnWriteLedger,
  roundCapSummaryNote,
  windDownNote,
} from './toolLoopBounds'
import { executeOneCall, groupToolCalls, type TurnPlanGate } from './toolDispatch'
import { PROPOSE_PLAN_TOOL_NAME } from '../../mcp/tools/studio/proposePlanTool'
import { heavyResultScope, isHeavyResult, projectHeavyElision } from './heavyElision'
import { wirePreviewImages } from '../../runtime/toolPreviewImages'
import {
  MAX_TRANSIENT_RETRIES,
  providerRetryTiming,
  retryAfterMs,
  transientRetryDelayMs,
} from './providerRetry'

// Re-exported because this module is the front door callers already use,
// and the bounds' own doc explains why they live one file over.
export { MAX_TOOL_ROUNDS }

export const PROVIDER_RETRY_IMAGE_OMITTED =
  '[Earlier attached images omitted after the provider rejected the full conversation context.]'


/** One tool-result message the loop appended, remembered for heavy-evidence elision. */
interface HeavyMessage {
  readonly index: number
  readonly results: TurnToolResult[]
  readonly notes: readonly string[]
}

/** The outcome of sending one round, after every retry it was entitled to. */
type RoundOutcome<TMessage> =
  | { readonly kind: 'turn'; readonly turn: TurnResult<TMessage> }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Drive the multi-turn loop for one provider. Yields canonical
 * `AiStreamEvent`s; the runner forwards them to the wire + DB.
 */
export async function* runToolLoop<TMessage>(
  adapter: ProviderAdapter<TMessage>,
  req: AiStreamRequest,
): AsyncIterable<AiStreamEvent> {
  const toolsByName = new Map<string, AiTool>(req.tools.map((t) => [t.name, t]))
  // Append-only. See the module doc: a rewritten past message would invalidate
  // the prompt cache from that point on, every single round.
  let history = adapter.mapHistory(req)
  // How much of `history` came from the persisted conversation rather than from
  // this loop's own rounds. Everything below this index is fixed for the whole
  // turn, which makes it the one cache anchor elision can never disturb.
  let persistedLength = history.length
  const headers = adapter.buildHeaders(req)
  let replayOverflowRetried = false

  // Track tool-result messages that carry heavy evidence (screenshots,
  // full-page HTML/CSS). Once superseded they describe stale page state and are
  // worthless, so only the LATEST per heavy tool name is sent at full fidelity
  // and the rest are stubbed at request-build time — this is what bounds
  // context growth across a long build loop (a single screenshot inlined as
  // text was blowing past 1M tokens).
  const heavyMessages: HeavyMessage[] = []

  // Usage is reported per API call; aggregate across the whole loop so the
  // runner persists a single total (and prices it via pricing.ts when the
  // provider omits costUsd).
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let costUsd: number | undefined

  const aggregateUsageEvent = (): Extract<AiStreamEvent, { type: 'usage' }> => ({
    type: 'usage',
    promptTokens,
    completionTokens,
    costUsd,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
  })

  // The two ceilings — see the module doc. The write ledger is per TURN, not
  // per conversation: a write the user asks for again in their next message
  // is a new instruction and must run.
  const maxRounds = req.maxToolRounds ?? MAX_TOOL_ROUNDS
  const writeLedger = createTurnWriteLedger()
  // AI-22 — Plan mode is enforced for a turn that was offered the plan tool.
  const planGate: TurnPlanGate = { required: toolsByName.has(PROPOSE_PLAN_TOOL_NAME), approved: false }
  let round = 0
  let summaryRound = false
  let continuations = 0
  // Only an explicitly chosen effort turns reasoning on; a refusal of the
  // parameters turns it off for the rest of the turn.
  let reasoning = req.effort !== undefined

  for (;;) {
    if (req.signal.aborted) return
    round += 1

    // One round: send, retrying what a retry can fix. Written inline (not a
    // helper generator) because the retry path yields wire events of its own.
    let outcome: RoundOutcome<TMessage> | null = null
    for (let attempt = 1; outcome === null; attempt += 1) {
      const requestMessages = projectHeavyElision(history, heavyMessages, adapter)
      const options: ProviderRequestOptions = { toolChoice: summaryRound ? 'none' : 'auto', reasoning }
      let res: Response
      try {
        res = await fetch(adapter.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(
            adapter.buildRequestBody(requestMessages, req, messageCacheBreakpoints(persistedLength, requestMessages.length), options),
          ),
          signal: req.signal,
        })
      } catch (err) {
        if (isAbortError(err) || req.signal.aborted) return
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`[ai/${adapter.label.toLowerCase()}] request failed:`, err)
        const delay = attempt <= MAX_TRANSIENT_RETRIES ? transientRetryDelayMs(attempt, null) : null
        if (delay === null) {
          outcome = { kind: 'failed', message: `${adapter.label} request failed: ${detail}` }
          break
        }
        yield retryingEvent(attempt, delay, `${adapter.label} could not be reached`)
        await providerRetryTiming.sleep(delay, req.signal)
        continue
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        console.error(`[ai/${adapter.label.toLowerCase()}] HTTP ${res.status}:`, bodyText.slice(0, 500))
        const failure = classifyHttpFailure(adapter.label, res.status, bodyText)
        if (failure.kind === 'replayOverflow' && round === 1 && !replayOverflowRetried) {
          const projected = elideHistoricalUserImages(req.messages)
          if (projected) {
            replayOverflowRetried = true
            history = adapter.mapHistory({ ...req, messages: projected })
            persistedLength = history.length
            continue
          }
        }
        if (failure.kind === 'unsupportedParameter' && reasoning) {
          reasoning = false
          continue
        }
        const delay = failure.kind === 'transient' && attempt <= MAX_TRANSIENT_RETRIES
          ? transientRetryDelayMs(attempt, retryAfterMs(res.headers))
          : null
        if (delay === null) {
          outcome = { kind: 'failed', message: failure.message }
          break
        }
        yield retryingEvent(attempt, delay, failure.message)
        await providerRetryTiming.sleep(delay, req.signal)
        continue
      }

      const translator = adapter.createTurnTranslator()
      // Whether any of this response already reached the user. A failure after
      // that point cannot be retried without showing them the start twice.
      let spoke = false
      let streamFailure: string | null = null
      let transient = false
      try {
        for await (const frame of parseSseStream(res)) {
          for (const event of translator.translate(frame)) {
            if (event.type === 'error') {
              streamFailure = event.message
              transient = translator.isTransientFailure()
              break
            }
            if (event.type === 'text' || event.type === 'toolCall' || event.type === 'reasoning') spoke = true
            yield event
          }
          if (streamFailure !== null) break
        }
      } catch (err) {
        if (isAbortError(err) || req.signal.aborted) return
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`[ai/${adapter.label.toLowerCase()}] stream error:`, err)
        streamFailure = `${adapter.label} stream error: ${detail}`
        transient = true
      }
      if (req.signal.aborted) return
      if (streamFailure !== null) {
        const delay = transient && !spoke && attempt <= MAX_TRANSIENT_RETRIES ? transientRetryDelayMs(attempt, null) : null
        if (delay === null) {
          outcome = { kind: 'failed', message: streamFailure }
          break
        }
        yield retryingEvent(attempt, delay, streamFailure)
        await providerRetryTiming.sleep(delay, req.signal)
        continue
      }
      outcome = { kind: 'turn', turn: translator.finish() }
    }
    if (req.signal.aborted) return
    if (outcome.kind === 'failed') {
      if (summaryRound) {
        // The turn already did its work; a failed courtesy summary is not an
        // error the user needs to see. Its usage is still owed.
        console.error(`[ai/${adapter.label.toLowerCase()}] the round-cap summary request failed:`, outcome.message)
        break
      }
      // Rounds already completed were billed; persist them before the error.
      if (round > 1) yield aggregateUsageEvent()
      yield { type: 'error', message: outcome.message }
      return
    }

    const turn = outcome.turn
    if (turn.usage) {
      promptTokens += turn.usage.promptTokens
      completionTokens += turn.usage.completionTokens
      cacheReadTokens += turn.usage.cacheReadTokens ?? 0
      cacheCreationTokens += turn.usage.cacheCreationTokens ?? 0
      if (turn.usage.costUsd != null) costUsd = (costUsd ?? 0) + turn.usage.costUsd
      // Live meter: emit THIS round's input as the current context size. Each
      // round (including the final one, before the break below) reports the
      // running context — the handler normalises + forwards it so the meter
      // updates mid-turn instead of only at the end.
      yield {
        type: 'context',
        promptTokens: turn.usage.promptTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheCreationTokens: turn.usage.cacheCreationTokens,
      }
    }

    // The summary round is the last word, whatever it contains.
    if (summaryRound) break

    if (turn.toolCalls.length === 0) {
      // A reply the output limit cut off is continued, not taken as the end.
      if (turn.truncated && continuations < MAX_TRUNCATION_CONTINUATIONS && round < maxRounds) {
        continuations += 1
        if (turn.assistantMessage !== null) history.push(turn.assistantMessage)
        history.push(adapter.buildUserNoteMessage(TRUNCATED_REPLY_NOTE))
        continue
      }
      break
    }

    if (turn.assistantMessage !== null) {
      history.push(turn.assistantMessage)
    }

    // Execute every complete tool call — observers concurrently, writes one
    // at a time (see `groupToolCalls`) — then answer any call the output limit
    // cut off, then append the combined tool-result turn before re-POSTing.
    const results: TurnToolResult[] = []
    const runnable = turn.toolCalls.filter((call) => !call.incomplete)
    for (const group of groupToolCalls(runnable, toolsByName)) {
      const settled = await Promise.all(
        group.map((call) => executeOneCall(call, toolsByName, req, writeLedger, planGate)),
      )
      if (req.signal.aborted) return

      // Emission stays in the model's own call order regardless of which tool
      // finished first, so the transcript reads the way the turn was written.
      for (const entry of settled) {
        if (entry.output === null) {
          // Browser tools communicate domain failures by resolving an
          // `AiToolOutput`. Rejection means the bridge transport disappeared
          // (timeout, server reload, closed stream). Retrying within this turn
          // would hit the same dead bridge and can burn repeated provider rounds.
          yield {
            type: 'toolResult',
            toolCallId: entry.call.id,
            toolName: entry.call.name,
            ok: false,
            error: entry.error,
          }
          // The provider already completed and billed this round before the
          // bridge failed. Persist its accumulated usage before the terminal
          // error so conversation totals and the failed-turn audit stay honest.
          yield aggregateUsageEvent()
          yield {
            type: 'error',
            message: `Browser tool transport failed: ${entry.error}`,
          }
          return
        }
        yield {
          type: 'toolResult',
          toolCallId: entry.call.id,
          toolName: entry.call.name,
          ok: entry.output.ok,
          error: entry.output.ok ? undefined : entry.output.error ?? 'Tool call failed.',
          // A bridged tool's images came FROM the browser, which already has them.
          ...(toolsByName.get(entry.call.name)?.execution === 'bridge' ? {} : wirePreviewImages(entry.output.images)),
        }
        results.push({ id: entry.call.id, name: entry.call.name, output: entry.output, scope: heavyResultScope(entry.call.input) })
      }
    }
    for (const call of turn.toolCalls.filter((c) => c.incomplete)) {
      yield { type: 'toolResult', toolCallId: call.id, toolName: call.name, ok: false, error: TRUNCATED_TOOL_CALL_ERROR }
      results.push({ id: call.id, name: call.name, output: { ok: false, error: TRUNCATED_TOOL_CALL_ERROR } })
    }

    const notes: string[] = []
    if (maxRounds - round === WIND_DOWN_ROUNDS_LEFT) notes.push(windDownNote(WIND_DOWN_ROUNDS_LEFT))
    if (round >= maxRounds) {
      notes.push(roundCapSummaryNote(maxRounds))
      summaryRound = true
    }
    const msgIndex = history.push(adapter.buildToolResultMessage(results, notes)) - 1
    if (results.some(isHeavyResult)) heavyMessages.push({ index: msgIndex, results, notes })
  }

  yield aggregateUsageEvent()
}

/** The quiet status the panel shows while a transient failure is retried — never an error. */
function retryingEvent(attempt: number, delayMs: number, reason: string): AiStreamEvent {
  return { type: 'retrying', attempt, maxAttempts: MAX_TRANSIENT_RETRIES, delayMs, reason }
}

/**
 * One provider-directed retry projection: retain the newest/current user
 * turn verbatim and replace images on earlier user turns with one breadcrumb
 * per turn. Persistence and the caller-owned history remain untouched.
 */
function elideHistoricalUserImages(messages: readonly AiMessage[]): AiMessage[] | null {
  let newestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      newestUserIndex = index
      break
    }
  }
  if (newestUserIndex <= 0) return null

  let changed = false
  const projected = messages.map((message, messageIndex): AiMessage => {
    if (messageIndex >= newestUserIndex || message.role !== 'user') return message
    if (!message.content.some((block) => block.kind === 'image')) return message

    changed = true
    let breadcrumbAdded = false
    const content: AiContentBlock[] = []
    for (const block of message.content) {
      if (block.kind !== 'image') {
        content.push(block)
      } else if (!breadcrumbAdded) {
        content.push({ kind: 'text', text: PROVIDER_RETRY_IMAGE_OMITTED })
        breadcrumbAdded = true
      }
    }
    return { role: 'user', content }
  })
  return changed ? projected : null
}

// ---------------------------------------------------------------------------
// Prompt-cache breakpoint policy
// ---------------------------------------------------------------------------

/**
 * Where a provider should place message-level prompt-cache breakpoints for ONE
 * request, as ascending indices into that request's message array. Two anchors,
 * and the reason for each:
 *
 *   - **the end of the persisted history** this run started from. Heavy-evidence
 *     elision only ever touches messages the LOOP appended, so this prefix is
 *     byte-identical on every round of the turn. It is the anchor that still
 *     hits after a fresh screenshot supersedes an earlier one.
 *   - **the last message of this request.** Nothing after it exists yet, so the
 *     next round reads everything up to here from the cache and pays full price
 *     only for its own delta — which is what turns an N-round tool loop from N²
 *     input tokens into N.
 *
 * Two is also the budget: Anthropic allows four `cache_control` markers per
 * request and its driver spends the other two on the static system prefix and
 * the tool block. On the first round both anchors collapse to the same index.
 */
export function messageCacheBreakpoints(persistedLength: number, length: number): number[] {
  if (length === 0) return []
  const anchors = new Set<number>()
  if (persistedLength > 0) anchors.add(Math.min(persistedLength, length) - 1)
  anchors.add(length - 1)
  return [...anchors].sort((a, b) => a - b)
}
