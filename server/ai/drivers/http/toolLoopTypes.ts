/**
 * The contract between the provider-agnostic tool loop (`toolLoop.ts`) and
 * each provider's adapter — the shapes a driver implements and the loop's
 * helpers (`toolDispatch.ts`, `heavyElision.ts`) share. A leaf, so none of
 * those modules has to import the loop to name a type the loop also names.
 */
import type { AiStreamEvent, AiToolOutput } from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import type { SseFrame } from './sse'

/** A resolved tool call the model issued this turn. */
export interface TurnToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  /**
   * True when the output limit cut this call off before its arguments were
   * complete (they did not parse). The loop never runs it; see the module doc.
   */
  readonly incomplete?: boolean
}

/** The result of executing one tool, paired back with its call. */
export interface TurnToolResult {
  readonly id: string
  readonly name: string
  readonly output: AiToolOutput
  /**
   * What the result is ABOUT — the page(s) or file its call named
   * (`heavyResultScope`). Heavy-evidence elision supersedes a result only by a
   * later one about the same thing (AI-18): a screenshot of page A is not made
   * stale by a screenshot of page B.
   */
  readonly scope?: string
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
  /** Tool calls to execute before the next turn. Empty when the model is done. */
  readonly toolCalls: TurnToolCall[]
  /**
   * True when the provider stopped because the OUTPUT LIMIT was reached
   * (Anthropic `stop_reason: 'max_tokens'`, Responses `incomplete`
   * with `max_output_tokens`, chat/completions `finish_reason: 'length'`),
   * not because the model was done.
   */
  readonly truncated: boolean
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
  /**
   * After `translate` returned an `error` event: whether that error is the
   * provider being momentarily unable (an overload, a rate limit, an internal
   * error) rather than a verdict on the request. The loop retries a transient
   * stream error only when nothing of the response reached the user yet.
   */
  isTransientFailure(): boolean
}

/** Per-request knobs the loop sets and every adapter honours. */
export interface ProviderRequestOptions {
  /**
   * `'none'` on the summary round after the round cap: the tool definitions
   * stay (so the cached prefix and the history's tool calls stay valid) but
   * the model may not call one.
   */
  readonly toolChoice: 'auto' | 'none'
  /**
   * Whether to send the reasoning parameters `req.effort` maps to. False once
   * the provider refused them this turn (`unsupportedParameter`).
   */
  readonly reasoning: boolean
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
    options: ProviderRequestOptions,
  ): unknown
  /**
   * Build the tool-result turn appended after the assistant turn. `notes` are
   * the loop's own one-line messages to the model (the wind-down, the round
   * cap), carried in the same turn so no provider sees two user turns in a row.
   */
  buildToolResultMessage(results: TurnToolResult[], notes: readonly string[]): TMessage
  /** A plain user-side note — the "continue where you stopped" after a truncated reply. */
  buildUserNoteMessage(text: string): TMessage
  /** Fresh translator for each API call in the loop. */
  createTurnTranslator(): TurnTranslator<TMessage>
}
