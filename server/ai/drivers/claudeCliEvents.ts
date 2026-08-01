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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ClaudeCliTextBlockSchema = Type.Object(
  { type: Type.Literal('text'), text: Type.String() },
  { additionalProperties: true },
)

/** Non-text content blocks (tool_use, thinking, …) exist but are unused while
 *  step 1 ships with no tools — matched loosely so they don't fail the parse. */
const ClaudeCliContentBlockSchema = Type.Union([
  ClaudeCliTextBlockSchema,
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
    delta: Type.Optional(
      Type.Object(
        { type: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()) },
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
export function translateClaudeCliLine(line: ClaudeCliLine): ClaudeCliTranslateResult {
  switch (line.type) {
    case 'assistant': {
      // Synthetic auth-failure message — no text to show; the terminal
      // `result` event is the honest error surface.
      if (line.message?.model === SYNTHETIC_MODEL) return { events: [], turnComplete: false }
      const text = (line.message?.content ?? [])
        .filter((block): block is Static<typeof ClaudeCliTextBlockSchema> => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        events: text ? [{ type: 'text', text }] : [],
        turnComplete: false,
      }
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
      const thinking = line.event?.delta
      if (line.event?.type === 'content_block_delta' && thinking?.type === 'thinking_delta' && thinking.thinking) {
        return { events: [{ type: 'reasoning', text: thinking.thinking }], turnComplete: false }
      }
      return { events: [], turnComplete: false }
    }

    // `system/init`, `user` (echoed back), and anything unrecognised carry
    // nothing this driver surfaces on the wire.
    default:
      return { events: [], turnComplete: false }
  }
}

function claudeCliResultErrorMessage(line: ClaudeCliLine): string {
  if (line.result) return `Claude CLI error: ${line.result}`
  if (line.subtype) return `Claude CLI turn failed (${line.subtype}). Check you're logged in with "claude auth status".`
  return 'Claude CLI turn failed. Check you\'re logged in with "claude auth status".'
}
