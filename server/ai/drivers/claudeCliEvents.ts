/**
 * `claude` CLI stream-json event schemas + the translator that turns one
 * line of the CLI's NDJSON stdout into zero or more canonical `AiStreamEvent`s.
 *
 * Every shape here is validated against WS-11 §4.0 ("The verified CLI
 * contract" — observed against the installed binary, v2.1.114, not read from
 * docs). Schemas are deliberately tolerant (`additionalProperties: true`,
 * most fields `Optional`) — the CLI's JSON carries fields this driver doesn't
 * use, and an unrecognised field must never fail the parse.
 *
 * Four traps this file exists to not fall into (WS-11 §4.0):
 *   1. `apiKeySource` reports the API-key source, not auth state — never read
 *      here (auth state is `claudeCliProbe.ts`'s job, via `auth status`, not
 *      this stream).
 *   2. `result.subtype` is `"success"` even when the turn failed — key off
 *      `result.is_error`.
 *   3. Auth failures arrive as an `assistant` event with a top-level `error`
 *      and `message.model === "<synthetic>"`, not on stderr.
 *   4. Within one `result` event, `usage.*` is snake_case (mirrors the
 *      Anthropic Messages API this CLI wraps) while `modelUsage.<model>.*` is
 *      camelCase. Every field below is read by name, never by position.
 */

import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import type { AiStreamEvent } from '../runtime/types'
import type { ClaudeCliRawEvent } from './claudeCliSpawn'
import { ToolInputProgress } from './toolInputProgress'
import { wirePreviewImages } from '../runtime/toolPreviewImages'
import type { AiToolImage } from '@core/ai'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ClaudeCliTextBlockSchema = Type.Object(
  { type: Type.Literal('text'), text: Type.String() },
  { additionalProperties: true },
)

/**
 * A tool the model invoked. Verified against a real turn (v2.1.114): arrives
 * as a block on an `assistant` line, `{"type":"tool_use","id":"toolu_…",
 * "name":"Read","input":{…}}`.
 */
const ClaudeCliToolUseBlockSchema = Type.Object(
  {
    type: Type.Literal('tool_use'),
    id: Type.String(),
    name: Type.String(),
    input: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
)

/**
 * That tool's outcome. Verified against the same turn: arrives on a `user`
 * line (the CLI echoes the tool-result turn it feeds back to the model),
 * carrying only `tool_use_id` — never the tool's NAME, which is why pairing
 * needs the per-turn `ClaudeCliTurnState` below.
 */
const ClaudeCliToolResultBlockSchema = Type.Object(
  {
    type: Type.Literal('tool_result'),
    tool_use_id: Type.String(),
    is_error: Type.Optional(Type.Boolean()),
    content: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
)

/**
 * Loose tail of the union — `thinking`, `redacted_thinking`, and anything a
 * future CLI adds. Deliberately last: TypeBox accepts the first matching
 * member, so the typed shapes above must precede it to narrow correctly.
 */
const ClaudeCliContentBlockSchema = Type.Union([
  ClaudeCliTextBlockSchema,
  ClaudeCliToolUseBlockSchema,
  ClaudeCliToolResultBlockSchema,
  Type.Object({ type: Type.String() }, { additionalProperties: true }),
])

/** `usage.*` — snake_case, mirrors the Anthropic Messages API this CLI wraps. */
const ClaudeCliUsageSchema = Type.Object(
  {
    input_tokens: Type.Optional(Type.Number()),
    output_tokens: Type.Optional(Type.Number()),
    cache_read_input_tokens: Type.Optional(Type.Number()),
    cache_creation_input_tokens: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

/** `modelUsage.<model>.*` — camelCase. A different casing convention from
 *  `usage` in the SAME event (WS-11 §4.0 trap #4) — never merge the two. */
const ClaudeCliModelUsageEntrySchema = Type.Object(
  {
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    cacheReadInputTokens: Type.Optional(Type.Number()),
    cacheCreationInputTokens: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const ClaudeCliAssistantMessageSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    content: Type.Optional(Type.Array(ClaudeCliContentBlockSchema)),
    usage: Type.Optional(ClaudeCliUsageSchema),
  },
  { additionalProperties: true },
)

/**
 * WS-12 §5.4 — the inner Anthropic SSE event a `type: "stream_event"` CLI
 * line wraps when the turn is run with `--include-partial-messages`. This
 * shape is written against the DOCUMENTED Anthropic Messages streaming
 * vocabulary (`content_block_delta` with `delta.type: "thinking_delta"` and
 * `delta.thinking: string`, on a block whose own `content_block.type` is
 * `"thinking"`) — it has NOT been confirmed against a real CLI turn. Every
 * field is `Optional` and the object is loosely typed on purpose: if the
 * real event differs, `translateClaudeCliLine` below simply never matches
 * and emits nothing, rather than throwing.
 */
const ClaudeCliInnerStreamEventSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    index: Type.Optional(Type.Number()),
    /** `content_block_start` — for a `tool_use` block, its id and name (AI-26). */
    content_block: Type.Optional(
      Type.Object(
        { type: Type.Optional(Type.String()), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
    ),
    delta: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          thinking: Type.Optional(Type.String()),
          /** `input_json_delta` — a fragment of a tool call's arguments (AI-26). */
          partial_json: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const ClaudeCliLineSchema = Type.Object(
  {
    type: Type.String(),
    subtype: Type.Optional(Type.String()),
    // Present on the auth-failure `assistant` event — top-level, NOT nested
    // under `message` (WS-11 §4.0 trap #3).
    error: Type.Optional(Type.String()),
    message: Type.Optional(ClaudeCliAssistantMessageSchema),
    // `result` event fields.
    is_error: Type.Optional(Type.Boolean()),
    result: Type.Optional(Type.String()),
    /**
     * HTTP status of the upstream API failure, when the turn failed against
     * Anthropic rather than locally. `null` on every healthy turn (the CLI
     * emits the key either way). `401` is the one value worth branching on —
     * it means the credential itself was rejected, which
     * `verifyClaudeCliCredential` turns into a specific, actionable message
     * instead of echoing a raw API error at the user.
     */
    api_error_status: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    usage: Type.Optional(ClaudeCliUsageSchema),
    modelUsage: Type.Optional(Type.Record(Type.String(), ClaudeCliModelUsageEntrySchema)),
    total_cost_usd: Type.Optional(Type.Number()),
    session_id: Type.Optional(Type.String()),
    // `type: "stream_event"` line only (requires `--include-partial-messages`,
    // WS-12 §5.4) — the raw inner Anthropic SSE event, unverified shape.
    event: Type.Optional(ClaudeCliInnerStreamEventSchema),
  },
  { additionalProperties: true },
)

export type ClaudeCliLine = Static<typeof ClaudeCliLineSchema>

/** `claude auth status --json` — the ONLY auth probe this driver uses (WS-11 §4.0). */
export const ClaudeCliAuthStatusSchema = Type.Object(
  {
    loggedIn: Type.Boolean(),
    authMethod: Type.Optional(Type.String()),
    subscriptionType: Type.Optional(Type.String()),
    // `apiKeySource` deliberately has NO field here — trap #1. Reading it
    // would invite a future edit to probe with it "since it's right there".
  },
  { additionalProperties: true },
)
export type ClaudeCliAuthStatus = Static<typeof ClaudeCliAuthStatusSchema>

/** The synthetic model id the CLI reports on its auth-failure assistant event. */
const SYNTHETIC_MODEL = '<synthetic>'

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/**
 * Validate one already-JSON-parsed CLI stdout line against the envelope.
 * Returns `null` rather than throwing — a single line whose shape doesn't
 * match (a stray log line some other tool injected, a future CLI version
 * adding a genuinely incompatible event) must not kill the whole stream.
 * `claudeCliSpawn.ts`'s reader does the JSON.parse (it works with raw
 * bytes off the wire); this is the TypeBox boundary on top of that.
 */
export function parseClaudeCliLineValue(json: unknown): ClaudeCliLine | null {
  try {
    return parseValue(ClaudeCliLineSchema, json)
  } catch {
    return null
  }
}

/** String-input convenience wrapper (JSON.parse + validate) for callers/tests
 *  that have a raw line rather than an already-parsed value. */
export function parseClaudeCliLine(line: string): ClaudeCliLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return null
  }
  return parseClaudeCliLineValue(json)
}

// ---------------------------------------------------------------------------
// Translator — one CLI line → zero or more AiStreamEvents
// ---------------------------------------------------------------------------

export interface ClaudeCliTranslateResult {
  events: AiStreamEvent[]
  /** Set once a `result` event has been seen — the caller stops waiting for more. */
  turnComplete: boolean
}

/**
 * Per-turn memory the translator needs but must not own.
 *
 * The CLI splits a tool call across two lines: the `assistant` line names it
 * (`tool_use.name`), and the later `user` line reports its outcome carrying
 * only `tool_use_id`. Emitting a `toolResult` therefore requires remembering
 * what that id was called. That memory is turn-scoped, so it lives with the
 * caller's stream loop — a module-level map here would leak names between
 * concurrent chats in the same server process.
 */
export interface ClaudeCliTurnState {
  readonly toolNames: Map<string, string>
  /**
   * The most recent tool the CLI announced this turn, or `null` before it has
   * called one. Read only by the turn-cap error message (Z3): "we stopped this
   * turn" is half an answer, and the other half is what it was doing when we
   * did. A `Map` has no cheap "last inserted" read, so this records it as it
   * goes rather than reconstructing it.
   */
  lastToolName: string | null
  /**
   * AI-26 — the `tool_use` blocks currently streaming their arguments, by
   * block index (`content_block_start` names them; the `input_json_delta`
   * fragments after it carry only the index), and the byte counter that turns
   * those fragments into `toolInputProgress` events.
   */
  readonly streamingTools: Map<number, { id: string; name: string }>
  readonly inputProgress: ToolInputProgress
}

export function createClaudeCliTurnState(): ClaudeCliTurnState {
  return { toolNames: new Map(), lastToolName: null, streamingTools: new Map(), inputProgress: new ToolInputProgress() }
}

/**
 * Translate one parsed CLI line into wire `AiStreamEvent`s.
 *
 *   - `system/init`         → nothing (informational only).
 *   - `assistant` (real)    → one `text` event per non-empty text block.
 *   - `assistant` (synthetic, auth failure) → nothing here; the terminal
 *     `result` event (`is_error: true`) carries the actual error to the user,
 *     matching WS-11 §4.0: "Unauthenticated runs still emit system/init
 *     before failing... Failure then arrives as an assistant event carrying
 *     top-level error, then a result with is_error: true."
 *   - `result`               → `usage` + `context` (from `usage.*`, snake_case)
 *     then `done` or `error` (keyed off `is_error`, never `subtype` — trap #2).
 *     `costUsd` is the CLI's own `total_cost_usd` when present — it already
 *     accounts for every model in `modelUsage` (including the internal Haiku
 *     classifier call WS-11 §4.0 warns about), which per-model summation from
 *     this driver would not.
 *   - `stream_event`         → `reasoning` (WS-12 §5.4), ONLY when the wrapped
 *     inner event is a `content_block_delta` carrying `delta.type ===
 *     "thinking_delta"` with a non-empty `delta.thinking`. Written against
 *     the documented Anthropic streaming shape, UNVERIFIED against a real
 *     CLI turn (`claudeCliInnerStreamEventSchema`'s own doc comment). Every
 *     other `stream_event` shape (any other delta type, a missing `event`,
 *     a missing `delta`) intentionally falls through to "nothing" — the
 *     defensive posture the feature was built with: if the real event never
 *     arrives or looks different, this driver silently emits nothing rather
 *     than guessing or throwing.
 */
export function translateClaudeCliLine(
  line: ClaudeCliLine,
  state: ClaudeCliTurnState,
): ClaudeCliTranslateResult {
  switch (line.type) {
    case 'assistant': {
      // Synthetic auth-failure message — no text to show; the terminal
      // `result` event is the honest error surface.
      if (line.message?.model === SYNTHETIC_MODEL) return { events: [], turnComplete: false }
      const events: AiStreamEvent[] = []
      const text = (line.message?.content ?? [])
        .filter((block): block is Static<typeof ClaudeCliTextBlockSchema> => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text) events.push({ type: 'text', text })

      // `thinking` blocks are deliberately NOT translated here. The same
      // reasoning already arrived token-by-token as `thinking_delta` on the
      // `stream_event` lines below (confirmed on a real turn: 8 deltas, then
      // the complete block). Emitting both would print the model's reasoning
      // twice, because the browser appends reasoning text to the open block.
      for (const block of line.message?.content ?? []) {
        if (block.type !== 'tool_use') continue
        const toolUse = block as Static<typeof ClaudeCliToolUseBlockSchema>
        state.toolNames.set(toolUse.id, toolUse.name)
        state.lastToolName = toolUse.name
        events.push({
          type: 'toolCall',
          toolCallId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input ?? {},
          status: 'pending',
        })
      }
      return { events, turnComplete: false }
    }

    // The CLI echoes back the tool-result turn it feeds to the model. This is
    // the ONLY signal that a tool finished, so it is what closes out the
    // pending row in the panel.
    //
    // Note what these two cases are and are not: the subprocess already ran
    // the tool itself (this driver's loop-ownership fork — see `claudeCli.ts`).
    // `toolCall`/`toolResult` are the display half of Studio's tool wire and
    // are honest here; `toolRequest` — which asks the BROWSER to execute — is
    // never emitted from this driver, and must not be.
    case 'user': {
      const events: AiStreamEvent[] = []
      for (const block of line.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const result = block as Static<typeof ClaudeCliToolResultBlockSchema>
        events.push({
          type: 'toolResult',
          toolCallId: result.tool_use_id,
          // Falls back to the id when the pairing `tool_use` was never seen
          // (a resumed session replaying only the tail). The browser matches
          // on `toolCallId` and ignores this field, so a miss costs nothing.
          toolName: state.toolNames.get(result.tool_use_id) ?? result.tool_use_id,
          ok: !result.is_error,
          error: result.is_error ? toolResultErrorText(result.content) : undefined,
          ...wirePreviewImages(toolResultImages(result.content)),
        })
      }
      return { events, turnComplete: false }
    }

    case 'result': {
      const events: AiStreamEvent[] = []
      const usage = line.usage
      if (usage) {
        events.push({
          type: 'context',
          promptTokens: usage.input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
        })
        events.push({
          type: 'usage',
          promptTokens: usage.input_tokens ?? 0,
          completionTokens: usage.output_tokens ?? 0,
          costUsd: line.total_cost_usd,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
        })
      }
      // `is_error`, never `subtype` — trap #2. `subtype` reads `"success"`
      // even on a failed turn.
      if (line.is_error) {
        events.push({
          type: 'error',
          message: claudeCliResultErrorMessage(line),
        })
      } else {
        events.push({ type: 'done' })
      }
      return { events, turnComplete: true }
    }

    case 'stream_event': {
      const inner = line.event
      const delta = inner?.delta
      if (inner?.type === 'content_block_delta' && delta?.type === 'thinking_delta' && delta.thinking) {
        return { events: [{ type: 'reasoning', text: delta.thinking }], turnComplete: false }
      }
      // AI-26 — a native Write's arguments ARE the file, streamed for tens of
      // seconds before the tool_use arrives whole on the `assistant` line.
      const block = inner?.content_block
      if (inner?.type === 'content_block_start' && block?.type === 'tool_use' && block.id && typeof inner.index === 'number') {
        state.streamingTools.set(inner.index, { id: block.id, name: block.name ?? 'tool' })
        return { events: [], turnComplete: false }
      }
      if (inner?.type === 'content_block_delta' && delta?.type === 'input_json_delta' && delta.partial_json && typeof inner.index === 'number') {
        const tool = state.streamingTools.get(inner.index)
        const progress = tool ? state.inputProgress.append(tool.id, tool.name, delta.partial_json) : null
        return { events: progress ? [progress] : [], turnComplete: false }
      }
      return { events: [], turnComplete: false }
    }

    // `system/init`, `rate_limit_event`, and anything unrecognised carry
    // nothing this driver surfaces on the wire.
    default:
      return { events: [], turnComplete: false }
  }
}

/**
 * A failed `tool_result`'s content is either a plain string or the Anthropic
 * block array. Anything else (or nothing) gets a generic line rather than
 * `[object Object]`.
 */
/**
 * The image blocks of a `tool_result` — what a Studio MCP tool such as
 * `studio_screenshot` returned — in the wire's `{ mimeType, data }` shape.
 */
function toolResultImages(content: unknown): AiToolImage[] {
  if (!Array.isArray(content)) return []
  const images: AiToolImage[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'image') continue
    const source = (block as { source?: { type?: unknown; media_type?: unknown; data?: unknown } }).source
    if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      images.push({ mimeType: source.media_type, data: source.data })
    }
  }
  return images
}

function toolResultErrorText(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }
  return 'Tool call failed.'
}

function claudeCliResultErrorMessage(line: ClaudeCliLine): string {
  if (line.result) return `Claude CLI error: ${line.result}`
  if (line.subtype) return `Claude CLI turn failed (${line.subtype}). Check you're logged in with "claude auth status".`
  return 'Claude CLI turn failed. Check you\'re logged in with "claude auth status".'
}

// ---------------------------------------------------------------------------
// Whole-stream translation
// ---------------------------------------------------------------------------

/**
 * One CLI line stream → Studio's wire events. Shared verbatim by the warm and
 * the cold path, which is what makes "a warm turn behaves exactly like a cold
 * one" checkable rather than merely asserted: both produce the same
 * `ClaudeCliRawEvent`s, and both are translated by this.
 *
 * Lives here, beside `translateClaudeCliLine`, rather than in the driver: it is
 * the same responsibility one altitude up, and leaving it there would have left
 * two callers of a per-line translator each carrying their own copy of the
 * "have we seen a terminal event yet?" bookkeeping.
 */
export async function* translateClaudeCliStream(
  raw: AsyncIterable<ClaudeCliRawEvent>,
): AsyncGenerator<AiStreamEvent> {
  let sawTerminalEvent = false
  // Turn-scoped, never module-scoped — see `ClaudeCliTurnState`.
  const turnState = createClaudeCliTurnState()
  for await (const event of raw) {
    if (event.kind === 'turnCapped') {
      // Always an error, even if a `result` line somehow already landed: the
      // cap is a fact about this turn the user has to be told, and the cap
      // path only reaches here when the turn did NOT end on its own.
      yield { type: 'error', message: claudeCliTurnCapErrorMessage(event.capMs, turnState.lastToolName) }
      return
    }
    if (event.kind === 'exit') {
      if (!sawTerminalEvent) {
        yield { type: 'error', message: claudeCliExitErrorMessage(event.exitCode, event.stderr, event.timedOut) }
      }
      return
    }
    const line = parseClaudeCliLineValue(event.value)
    if (!line) continue
    const { events, turnComplete } = translateClaudeCliLine(line, turnState)
    if (turnComplete) sawTerminalEvent = true
    for (const translated of events) yield translated
  }
}

/** The user-facing sentence for a process that ended without ever emitting a `result` line. */
export function claudeCliExitErrorMessage(exitCode: number | null, stderr: string, timedOut: boolean): string {
  // Reached only after the CLI has gone completely silent for the whole idle
  // window (see `idleTimeoutMs` in claudeCliSpawn.ts) — NOT because the turn
  // took a long time. Say which, so the next person reading it in a toast
  // doesn't go looking for a length limit that doesn't exist.
  if (timedOut) return 'Claude CLI stopped responding — no output for 10 minutes. The turn was ended.'
  const trimmedStderr = stderr.trim()
  // WS-11 §4.0: stderr is empty on every non-crash path, so anything present
  // here is a genuine crash — surface it verbatim (bounded by
  // `pumpCapped`'s cap already).
  if (trimmedStderr) return `Claude CLI crashed (exit ${exitCode ?? 'unknown'}): ${trimmedStderr}`
  return `Claude CLI exited (${exitCode ?? 'unknown'}) without a result. Run "claude auth status" to check you're logged in.`
}

/**
 * The user-facing sentence for a turn this driver stopped at its total cap
 * (Z3) — a different fact from the idle timeout above, and worded so it cannot
 * be read as one. It names the last tool the turn was on, because "it ran too
 * long" on its own tells the user nothing they can act on, and because a turn
 * that ends here is usually stuck repeating that one tool.
 *
 * Kept in sync with `TOTAL_TURN_CAP_MS` in `claudeCliSpawn.ts`.
 */
export function claudeCliTurnCapErrorMessage(capMs: number, lastToolName: string | null): string {
  const minutes = Math.round(capMs / 60_000)
  const onTool = lastToolName ? ` It was last running ${lastToolName}.` : ''
  return (
    `This turn reached its ${minutes}-minute limit and was stopped.${onTool} ` +
    'Anything already written to your project is saved — send another message to carry on.'
  )
}
