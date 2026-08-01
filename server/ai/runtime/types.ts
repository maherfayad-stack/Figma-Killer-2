/**
 * Canonical AI runtime types — the vocabulary shared by drivers, the runner,
 * handlers, and (via NDJSON) the browser.
 *
 * These types are provider-agnostic. Drivers translate from their SDK's
 * native shapes (Anthropic MessageStreamEvent, OpenAI ResponseStream,
 * Ollama JSON) into these types so the rest of the system doesn't need to
 * care which provider answered.
 *
 * Wire shape: `AiStreamEvent` is JSON-serialised one-per-line as NDJSON.
 * Mirrors the discriminated union convention used elsewhere in the repo
 * (e.g. `ServerStreamEvent` from `src/admin/pages/site/agent/types.ts`,
 * which this replaces).
 *
 * @see docs/plans/2026-05-26-ai-runtime-rewrite.md
 */

import type { TSchema } from '@sinclair/typebox'
import type { AiContentBlock, AiToolOutput } from '@core/ai'
import type { CoreCapability } from '@core/capabilities'
export type { AiContentBlock, AiToolImage, AiToolOutput } from '@core/ai'

// ---------------------------------------------------------------------------
// Provider identity + auth modes
// ---------------------------------------------------------------------------

export type AiProviderId = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible' | 'claudeCli'
/**
 * Credential auth modes.
 *
 *   - `apiKey`   — encrypted user-supplied key (Anthropic, OpenAI, OpenRouter).
 *                  Also carries `claudeCli`'s L2 `claude setup-token` value
 *                  (WS-11 §3, P1) — the column records the SHAPE of what's
 *                  stored (an opaque encrypted secret), not which grant minted
 *                  it. `claudeCli`'s L1 path (terminal login) stores no
 *                  credential row at all.
 *   - `baseUrl`  — OpenAI-compatible endpoint (Ollama, or any openai-compatible
 *                  provider such as Groq, DeepSeek, Mistral, vLLM…). Optional
 *                  bearer token may be stored alongside the URL.
 */
export type AiAuthMode = 'apiKey' | 'baseUrl'

/**
 * Tool bridge-routing scope. NOT the chat "scope" concept removed by WS-12
 * §8.1 D3 (Studio has exactly one agent, one toolset, one system prompt) —
 * this says where a *browser*-executed tool's live bridge lives: `'site'`
 * routes through the connector owner's open Site editor; `'shared'` is
 * server-resolved or has no live-bridge dependency.
 */
export type AiToolBridgeScope = 'site' | 'shared'

/**
 * Separator marking the split between the cacheable static system-prompt prefix
 * and the dynamic suffix. The prompt builders emit `systemPrompt` as
 * `[prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, suffix]`; cache-capable drivers
 * (Anthropic) apply `cache_control` to the prefix, others strip the marker and
 * concatenate. Producer (the prompt builders) and consumers (every driver) MUST
 * agree on this exact literal — if one drifts, prompt caching silently breaks.
 * This is the single source of truth.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// `AiContentBlock` is defined once, as a TypeBox schema, in `@core/ai`
// (re-exported above). It covers text / image / toolCall / toolResult kinds.

export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: AiContentBlock[] }
  | { role: 'assistant'; content: AiContentBlock[] }
  | { role: 'tool'; toolCallId: string; output: AiToolOutput }

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Tool execution mode.
 *
 *  - `server`: runner calls `handler(input, ctx)` directly server-side; the
 *    result feeds back into the model in the same loop.
 *  - `browser`: runner emits `toolRequest` and awaits a `tool-result` POST
 *    from the browser. Use for any tool that mutates an in-browser store
 *    (the live editor) or requires DOM access (render_snapshot).
 */
type ToolExecution = 'server' | 'browser'

/**
 * One tool, defined once. Drivers translate `inputSchema` (TypeBox) into
 * their SDK's native tool format (Anthropic input_schema, OpenAI parameters
 * JSON Schema, Ollama JSON Schema).
 *
 * Tools are defined as plain values (not classes) so the registry stays a
 * simple discoverable list — see `server/ai/tools/index.ts`.
 *
 * Note: the handler input is typed `unknown`. Each tool internally narrows
 * via `parseValue(InputSchema, input)` (or a cast to `Static<typeof
 * InputSchema>` once the schema has validated the value). Generic
 * narrowing on AiTool itself doesn't survive into an `AiTool[]` array
 * because of TypeScript variance rules — kept simple here.
 */
export interface AiTool {
  readonly name: string
  readonly description: string
  readonly scope: AiToolBridgeScope
  readonly execution: ToolExecution
  readonly inputSchema: TSchema
  /**
   * Does this tool mutate state? Read tools (snapshot, search, list) are
   * pure reads against the db / store; write tools (insertHtml,
   * replaceNodeHtml, deleteNode, …) cause user-visible state change.
   *
   * The chat handler uses this to filter the registered toolset: a caller
   * with `ai.chat` but no `ai.tools.write` only sees `mutates !== true`
   * tools registered with the driver, so the model has no way to issue
   * a write call. Default is `false` (read-only) to keep existing tool
   * definitions valid without per-tool edits — `selectStudioTools`
   * stamps `mutates: true` onto the write subset at assembly time.
   */
  readonly mutates?: boolean
  /**
   * Capabilities that gate this tool, mirroring its HTTP-route equivalent.
   * ANY-OF semantics: the caller needs at least one. Undefined / empty means
   * the tool is reachable by any `ai.chat` caller (e.g. tools that only read
   * the browser-supplied snapshot). Enforced by `toolAllowedForCapabilities`
   * at selection time and re-checked in `executeAiTool`.
   */
  readonly requiredCapabilities?: readonly CoreCapability[]
  /**
   * Server-side handler. Required when `execution === 'server'`; ignored when
   * `execution === 'browser'` (the browser bridge runs the tool instead).
   */
  handler?: (input: unknown, ctx: ToolContext) => Promise<unknown>
}

/**
 * Context passed to server-side tool handlers. Carries the per-request
 * snapshot (page tree, posts list, table schemas, …) the tool reads from,
 * plus the active credential for tools that may want to call the model
 * recursively. Every tool reads the same live Site editor snapshot shape —
 * there is exactly one Studio agent, so this carries no scope discriminator.
 */
export interface ToolContext {
  /** Database client — server-side tool handlers query through this. */
  readonly db: import('../../db/client').DbClient
  readonly userId: string
  /** The caller's capability set — handlers and the re-check gate read this. */
  readonly capabilities: readonly CoreCapability[]
  readonly conversationId: string
  readonly snapshot: unknown
  readonly signal: AbortSignal
}

// ---------------------------------------------------------------------------
// Stream events — wire shape (NDJSON, one event per line)
// ---------------------------------------------------------------------------

export type AiStreamEvent =
  /** First event of every stream — carries the bridge id for tool-result POSTs. */
  | { type: 'bridgeReady'; bridgeId: string }
  /** Streaming text delta from the assistant. */
  | { type: 'text'; text: string }
  /** A tool call has been issued by the model. `status: 'pending'` until completion. */
  | { type: 'toolCall'; toolCallId: string; toolName: string; input: unknown; status: 'pending' }
  /** A tool call has completed (server-resolved or browser-bridged). */
  | { type: 'toolResult'; toolCallId: string; toolName: string; ok: boolean; error?: string }
  /** Server asks the browser to apply a write tool against its store. */
  | { type: 'toolRequest'; requestId: string; toolName: string; input: unknown }
  /**
   * Aggregated token usage for the entire stream — emitted just before `done`.
   *
   * Cache-aware fields are provider-specific:
   *   - `cacheReadTokens`     — tokens served from the prompt cache this call
   *                              (reported by Anthropic and OpenAI Responses).
   *   - `cacheCreationTokens` — tokens written to the prompt cache this call
   *                              (Anthropic reports this separately; OpenAI
   *                              does not expose a write bucket).
   * `promptTokens` follows the provider's native usage convention: Anthropic
   * excludes cache buckets, while OpenAI includes cached tokens as a subset.
   * Token counts are SUMMED across every round of the turn — correct for
   * billing (you pay input per round).
   * Billing only; the "context used" meter is driven by `context` (below).
   */
  | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  /**
   * Per-round context size — emitted ONCE PER provider round-trip (a turn with
   * tool calls has several), carrying THAT round's input buckets. The "context
   * used" meter is the CURRENT context size = the latest round's input (history
   * + accumulated tool results), NOT the sum across rounds. The chat handler
   * injects the provider-normalised `contextTokens` on the wire copy. Drives
   * the live meter during a turn; `usage` stays billing.
   */
  | { type: 'context'; promptTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; contextTokens?: number }
  /**
   * A chunk of extended-thinking / reasoning content, distinct from the
   * assistant's visible reply (`text`). Ephemeral display only — never
   * persisted to conversation history, same posture as `context`.
   *
   * WS-12 §5.4: currently emitted ONLY by `claudeCliEvents.ts`'s translator,
   * and that emission is written against the DOCUMENTED Anthropic streaming
   * shape (`thinking`/`thinking_delta` on a `stream_event`), not verified
   * against a real CLI turn — see that file's doc comment before assuming
   * this has been seen on the wire. No other driver emits it. A driver or
   * turn that never produces one costs nothing: the browser simply never
   * renders a reasoning block.
   */
  | { type: 'reasoning'; text: string }
  /** Terminal error — stream is about to end abnormally. */
  | { type: 'error'; message: string }
  /** Stream ended cleanly. */
  | { type: 'done' }

// ---------------------------------------------------------------------------
// Browser bridge — the runtime hands one of these to each driver so write
// tools can yield a `toolRequest` and await the browser POST.
// ---------------------------------------------------------------------------

export interface AiBrowserBridge {
  /**
   * Forward a `toolRequest` to the browser and resolve with whatever the
   * browser POSTs back to /admin/api/ai/tool-result. Rejects if the stream
   * closes before a result arrives (browser disconnected, stream aborted).
   */
  callBrowser(toolName: string, input: unknown): Promise<AiToolOutput>
}

// ---------------------------------------------------------------------------
// Aggregated usage — drivers report token counts so the handler can persist
// per-message + per-conversation totals and compute cost from pricing.ts.
// ---------------------------------------------------------------------------

