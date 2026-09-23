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
 * ## The loop has two ceilings (Z3)
 *
 * It used to be a bare `for (;;)` whose only exits were "the model stopped",
 * "the transport died", and abort. A model that kept issuing tool calls kept
 * the turn running, and a model that issued the SAME write over and over
 * executed it over and over — the observed shape being one gesture the user
 * asked for arriving in the file four times. Two bounds close that, and they
 * are deliberately different in kind:
 *
 *   - {@link MAX_TOOL_ROUNDS} (= `AGENT_TURN_ROUND_BUDGET`) caps how many provider rounds one turn may
 *     spend. Reaching it ends the turn with a single `error` event that names
 *     the last tool the model was on, so the transcript says what it was
 *     looping on rather than just stopping.
 *   - A per-turn write ledger suppresses a REPEATED WRITE. The second
 *     identical `(toolName, canonical args)` write in one turn, with no other
 *     write landing in between, is not executed; it is answered with a
 *     structured `{ code: 'duplicate-call', priorResult }` result carrying the
 *     first call's own outcome, so the model learns the write already
 *     happened instead of being told nothing and trying again. A write that
 *     lands in between advances the ledger's epoch, and the repeat then runs
 *     — see `TurnWriteLedger` for the four cases.
 *
 * Only `sideEffects: 'write'` tools are ledgered. Observers (`'none'`,
 * `'cache'`) are exempt on purpose: re-reading, re-capturing or re-checking
 * after a write is how the model checks its own work, and that second look is
 * a different question with the same arguments. This used to key on the old
 * `mutates` flag, which was also the capability gate — so every write-GATED
 * observer (`studio_screenshot`, `studio_compare`, `studio_typecheck`, …) had
 * its second look after a fix answered with the stale first result (AI-5).
 */

import type {
  AiContentBlock,
  AiMessage,
  AiStreamEvent,
  AiTool,
  AiToolOutput,
} from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import { parseSseStream, type SseFrame } from './sse'
import { executeAiTool } from './execTool'
import { isAbortError, classifyHttpFailure } from './errors'
import {
  MAX_TOOL_ROUNDS,
  createTurnWriteLedger,
  duplicateCallOutput,
  priorWriteOutcome,
  recordWriteOutcome,
  toolRoundCapMessage,
  type TurnWriteLedger,
} from './toolLoopBounds'

// Re-exported because this module is the front door callers already use,
// and the bounds' own doc explains why they live one file over.
export { MAX_TOOL_ROUNDS }

export const PROVIDER_RETRY_IMAGE_OMITTED =
  '[Earlier attached images omitted after the provider rejected the full conversation context.]'


/** A resolved tool call the model issued this turn. */
export interface TurnToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** The result of executing one tool, paired back with its call. */
export interface TurnToolResult {
  readonly id: string
  readonly name: string
  readonly output: AiToolOutput
}

/** Per-turn token usage reported by the provider. */
export interface TurnUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheReadTokens?: number
  readonly cacheCreationTokens?: number
  /** Native USD cost, when the provider reports it (OpenRouter). */
  readonly costUsd?: number
}

/** What a finished turn yields to the loop. */
export interface TurnResult<TMessage> {
  /** True when the model is done (no tool calls / a non-tool stop reason). */
  readonly stop: boolean
  /** Tool calls to execute before the next turn. Empty when `stop`. */
  readonly toolCalls: TurnToolCall[]
  /**
   * The provider-native assistant turn to append before the tool results.
   * Null when there is nothing to append (e.g. a stop turn).
   */
  readonly assistantMessage: TMessage | null
  /** Token usage for this single API call, if reported. */
  readonly usage: TurnUsage | null
}

/**
 * Stateful translator for ONE API call. The loop feeds it every SSE frame via
 * `translate` (which yields wire events), then calls `finish` once the stream
 * ends to collect the assistant turn, tool calls, usage, and stop signal.
 */
export interface TurnTranslator<TMessage> {
  translate(frame: SseFrame): AiStreamEvent[]
  finish(): TurnResult<TMessage>
}

/** The per-provider plumbing the loop needs. `TMessage` is the provider's native message shape. */
export interface ProviderAdapter<TMessage> {
  readonly label: string
  readonly endpoint: string
  buildHeaders(req: AiStreamRequest): Record<string, string>
  /** Canonical `AiMessage[]` history → provider-native message array. */
  mapHistory(req: AiStreamRequest): TMessage[]
  /**
   * Provider-native messages → the full JSON request body (sets `stream: true`).
   *
   * `cacheBreakpoints` are ascending indices into `messages` where the loop
   * wants a prompt-cache breakpoint placed (see `messageCacheBreakpoints`).
   * Providers whose cache is implicit — the OpenAI-Responses family, Ollama —
   * ignore the argument entirely; Anthropic expresses each as a
   * `cache_control` marker.
   */
  buildRequestBody(
    messages: TMessage[],
    req: AiStreamRequest,
    cacheBreakpoints: readonly number[],
  ): unknown
  /** Build the tool-result turn appended after the assistant turn. */
  buildToolResultMessage(results: TurnToolResult[]): TMessage
  /** Fresh translator for each API call in the loop. */
  createTurnTranslator(): TurnTranslator<TMessage>
}

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
  let initialProviderRound = true
  let replayOverflowRetried = false

  // Track tool-result messages that carry heavy evidence (screenshots,
  // full-page HTML/CSS). Once superseded they describe stale page state and are
  // worthless, so only the LATEST per heavy tool name is sent at full fidelity
  // and the rest are stubbed at request-build time — this is what bounds
  // context growth across a long build loop (a single screenshot inlined as
  // text was blowing past 1M tokens).
  const heavyMessages: { index: number; results: TurnToolResult[] }[] = []

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
  let round = 0
  let lastToolName = ''

  for (;;) {
    if (req.signal.aborted) return

    round += 1
    if (round > maxRounds) {
      // The provider has already billed every round that got us here, so the
      // totals are persisted before the terminal error — same ordering as the
      // dead-bridge path below.
      yield aggregateUsageEvent()
      yield { type: 'error', message: toolRoundCapMessage(maxRounds, lastToolName) }
      return
    }

    const requestMessages = projectHeavyElision(history, heavyMessages, adapter)
    let res: Response
    try {
      res = await fetch(adapter.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          adapter.buildRequestBody(
            requestMessages,
            req,
            messageCacheBreakpoints(persistedLength, requestMessages.length),
          ),
        ),
        signal: req.signal,
      })
    } catch (err) {
      if (isAbortError(err) || req.signal.aborted) return
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[ai/${adapter.label.toLowerCase()}] request failed:`, err)
      yield { type: 'error', message: `${adapter.label} request failed: ${detail}` }
      return
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[ai/${adapter.label.toLowerCase()}] HTTP ${res.status}:`, bodyText.slice(0, 500))
      const failure = classifyHttpFailure(adapter.label, res.status, bodyText)
      if (initialProviderRound && !replayOverflowRetried && failure.kind === 'replayOverflow') {
        const projected = elideHistoricalUserImages(req.messages)
        if (projected) {
          replayOverflowRetried = true
          history = adapter.mapHistory({ ...req, messages: projected })
          persistedLength = history.length
          continue
        }
      }
      yield { type: 'error', message: failure.message }
      return
    }

    const translator = adapter.createTurnTranslator()
    try {
      for await (const frame of parseSseStream(res)) {
        for (const event of translator.translate(frame)) {
          yield event
          if (event.type === 'error') return
        }
      }
    } catch (err) {
      if (isAbortError(err) || req.signal.aborted) return
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[ai/${adapter.label.toLowerCase()}] stream error:`, err)
      yield { type: 'error', message: `${adapter.label} stream error: ${detail}` }
      return
    }

    if (req.signal.aborted) return

    const turn = translator.finish()
    initialProviderRound = false
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

    if (turn.stop || turn.toolCalls.length === 0) {
      break
    }

    if (turn.assistantMessage !== null) {
      history.push(turn.assistantMessage)
    }

    // Execute every tool the model requested this turn — observers
    // concurrently, writes one at a time (see `groupToolCalls`) — then append
    // the combined tool-result turn before re-POSTing.
    const results: TurnToolResult[] = []
    for (const group of groupToolCalls(turn.toolCalls, toolsByName)) {
      const settled = await Promise.all(
        group.map((call) => executeOneCall(call, toolsByName, req, writeLedger)),
      )
      if (req.signal.aborted) return
      lastToolName = group[group.length - 1]?.name ?? lastToolName

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
        }
        results.push({ id: entry.call.id, name: entry.call.name, output: entry.output })
      }
    }

    const msgIndex = history.push(adapter.buildToolResultMessage(results)) - 1
    if (results.some(isHeavyResult)) heavyMessages.push({ index: msgIndex, results })
  }

  yield aggregateUsageEvent()
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
// Tool dispatch — concurrent observers, serialised writes
// ---------------------------------------------------------------------------

/** One executed call. `output === null` means the transport itself failed. */
interface ExecutedCall {
  readonly call: TurnToolCall
  readonly output: AiToolOutput | null
  readonly error: string
}

/**
 * Split one turn's tool calls into ordered execution GROUPS: consecutive
 * observer calls (`sideEffects` `'none'` or `'cache'`) form a single group
 * that runs concurrently, and every `'write'` gets a group of its own.
 *
 * The system prompt asks the model to issue its looks as one batch, and
 * running that batch sequentially made the loop's wall time the SUM of every
 * observation rather than the slowest one — several seconds per round on a
 * five-screen verification, repeated every round of a fix loop. A screenshot,
 * a compare, a measurement and a typecheck are all observers: each captures or
 * checks what is on disk, and the one resource two captures could contend
 * for — the headless browser — is already serialised underneath them
 * (`capture/browserPool.ts`'s `withCapturePage`), as is the live-tab
 * fallback on the client.
 *
 * The write rule is deliberately conservative, and the conservatism is the
 * point: two writes to the same file, or an observation the model issued
 * *after* a write in order to see it, must not be reordered or interleaved.
 * A name we cannot resolve to a registered tool is treated as a write (it
 * becomes an `Unknown tool: …` result, but it never shares a group).
 */
function groupToolCalls(
  calls: readonly TurnToolCall[],
  toolsByName: ReadonlyMap<string, AiTool>,
): TurnToolCall[][] {
  const groups: TurnToolCall[][] = []
  let observerBatch: TurnToolCall[] | null = null
  for (const call of calls) {
    const tool = toolsByName.get(call.name)
    if (tool !== undefined && tool.sideEffects !== 'write') {
      if (observerBatch === null) {
        observerBatch = []
        groups.push(observerBatch)
      }
      observerBatch.push(call)
    } else {
      observerBatch = null
      groups.push([call])
    }
  }
  return groups
}

/**
 * Run one tool call to a settled outcome. Never throws: a rejected browser
 * bridge is returned as `{ output: null, error }` so the caller can emit every
 * result of the group in the model's own call order before terminating on it.
 *
 * `writeLedger` is the turn's duplicate-write record (`TurnWriteLedger`). A
 * write whose identical twin was already recorded at the current write epoch
 * is NOT executed — it is answered from that call's own result. Only
 * `sideEffects: 'write'` tools consult or advance it: `groupToolCalls` above
 * uses the same field as its concurrency boundary, and looking twice is a
 * legitimate thing for a model to do.
 */
async function executeOneCall(
  call: TurnToolCall,
  toolsByName: ReadonlyMap<string, AiTool>,
  req: AiStreamRequest,
  writeLedger: TurnWriteLedger,
): Promise<ExecutedCall> {
  const tool = toolsByName.get(call.name)
  const ledgered = tool?.sideEffects === 'write'
  if (ledgered) {
    const prior = priorWriteOutcome(writeLedger, call.name, call.input)
    if (prior !== undefined) return { call, output: duplicateCallOutput(call.name, prior), error: '' }
  }
  try {
    const output = tool
      ? await executeAiTool(tool, prepareToolInput(call, req), req.bridge, req.signal, req.toolContextBase)
      : { ok: false, error: `Unknown tool: ${call.name}` }
    // Recorded on EVERY outcome, including a refusal: a write that refused for
    // a reason in its own error text refuses identically the second time, and
    // re-running it is exactly the loop this bound exists to stop. The ledger
    // decides whether the outcome also advances the epoch.
    if (ledgered) recordWriteOutcome(writeLedger, call.name, call.input, output)
    return { call, output, error: '' }
  } catch (err) {
    return { call, output: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Per-tool input preparation
// ---------------------------------------------------------------------------

/**
 * Hook for server-controlled tool inputs the model shouldn't drive. Currently
 * just `site_render_snapshot`: the server injects `captureScreenshot` from the
 * active model's vision capability so a non-vision model never pays the
 * html-to-image cost for a screenshot it can't consume.
 */
function prepareToolInput(call: TurnToolCall, req: AiStreamRequest): unknown {
  if (call.name === 'site_render_snapshot') {
    const base = call.input && typeof call.input === 'object' ? call.input : {}
    return {
      ...base,
      captureScreenshot:
        req.modelCapabilities.visionInput && req.modelCapabilities.toolResultImages,
    }
  }
  return call.input
}

// ---------------------------------------------------------------------------
// Stale heavy-evidence elision
// ---------------------------------------------------------------------------

/**
 * Tools whose results carry heavy, snapshot-in-time payloads (a full page's
 * HTML/CSS, a node subtree, a screenshot). Older copies describe page state the
 * model has since mutated — useless to re-send. Any result with an image
 * attachment is heavy regardless of tool name.
 */
const HEAVY_TOOL_NAMES = new Set(['site_render_snapshot', 'site_read_document', 'site_get_node_html'])

function isHeavyResult(r: TurnToolResult): boolean {
  return (r.output.images?.length ?? 0) > 0 || HEAVY_TOOL_NAMES.has(r.name)
}

/** Replace a heavy payload with a one-line breadcrumb pointing back at the tool. */
function stubHeavyResult(r: TurnToolResult): TurnToolResult {
  return {
    ...r,
    output: {
      ok: r.output.ok,
      data: {
        elided: true,
        note: `Earlier ${r.name} output removed to conserve context. Call ${r.name} again if you need the current state.`,
      },
    },
  }
}

/**
 * The message array for ONE request: the canonical history with every
 * superseded heavy tool result swapped for its breadcrumb. Per heavy tool name
 * only the most recent message keeps full fidelity; non-heavy results in the
 * same message are left untouched (a turn can mix a heavy `site_read_document`
 * with a cheap `site_update_node_props`). Messages are rebuilt through the
 * adapter, so this stays provider-agnostic.
 *
 * This is a projection, NOT an edit. `history` is returned untouched — it is
 * the array the next round appends to, and rewriting an entry of it (which is
 * what this used to do) invalidated the prompt cache from that position onward
 * on every single capture.
 */
export function projectHeavyElision<TMessage>(
  history: readonly TMessage[],
  heavyMessages: readonly { index: number; results: TurnToolResult[] }[],
  adapter: ProviderAdapter<TMessage>,
): TMessage[] {
  const projected = history.slice()
  if (heavyMessages.length === 0) return projected

  const lastIndexByTool = new Map<string, number>()
  for (const m of heavyMessages) {
    for (const r of m.results) {
      if (isHeavyResult(r) && m.index > (lastIndexByTool.get(r.name) ?? -1)) {
        lastIndexByTool.set(r.name, m.index)
      }
    }
  }
  for (const m of heavyMessages) {
    const superseded = (r: TurnToolResult): boolean =>
      isHeavyResult(r) && lastIndexByTool.get(r.name) !== m.index
    if (!m.results.some(superseded)) continue
    projected[m.index] = adapter.buildToolResultMessage(
      m.results.map((r) => (superseded(r) ? stubHeavyResult(r) : r)),
    )
  }
  return projected
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
