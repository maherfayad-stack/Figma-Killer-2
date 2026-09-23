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
 * Tool execution mode — WHERE the work happens, and therefore whether the
 * connector owner's board has to be open. Read it through
 * `./toolExecution.ts`'s predicates, never by re-matching the literal; that
 * module's doc comment carries the full table and the reasoning.
 *
 *  - `server`: runs in-process. Never needs a board.
 *  - `server-with-bridge-fallback`: runs in-process, headless, and relays to
 *    an open board only when the headless path cannot run (no Chromium) or
 *    when the caller explicitly asks for the live tab's own state. Never
 *    NEEDS a board — it gets slower without one, not unavailable.
 *  - `bridge`: the work happens in the connector owner's open workspace, and
 *    no board means a refusal. The runner relays the whole call when the tool
 *    declares no `handler` (the sentinel shape whose implementation lives
 *    client-side); a `bridge` tool that DOES declare one relays from inside
 *    it and owns its own "no board" message.
 */
export type ToolExecution = 'server' | 'server-with-bridge-fallback' | 'bridge'

/**
 * What a tool call CHANGES — read by the tool loop (`drivers/http/toolLoop.ts`)
 * to decide concurrency and duplicate suppression, and by nothing else. It is
 * deliberately NOT the capability gate: that is {@link AiTool.requiresWrite},
 * and the two used to be one `mutates` flag, which is how the agent's own
 * eyes got treated as writes (AI-5, `docs/audits/2026-09-23-studio-audit/
 * 06-assistant.md`).
 *
 *  - `none`: changes nothing that outlives the call. A pure read, or an
 *    observation whose only side is transient and restored in a `finally`
 *    (a live-tab capture that borrows the viewport and hands it back).
 *  - `cache`: changes only Studio's OWN derived state, and converges — the
 *    same call with the same inputs lands the same state again. A board frame
 *    placed for a page file that has none (`syncBoardFramesFromDisk`), a
 *    compare verdict cache entry, a verification record, a warm dev server.
 *    Nothing a user authored, nothing a re-run could get wrong.
 *  - `write`: changes something the user owns or will see as content — a
 *    source file, a `.studio/` document the user edits too (board layout,
 *    comments, references, variable tables), git, the database, an external
 *    system.
 *
 * The loop runs consecutive `none`/`cache` calls concurrently and never
 * suppresses a repeat of one — the second screenshot after a fix is a
 * different question with the same arguments. A `write` runs alone, and an
 * identical `write` is suppressed only while no OTHER write has landed in
 * between (the per-turn write epoch — see `toolLoopBounds.ts`).
 */
export type ToolSideEffects = 'none' | 'cache' | 'write'

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
   * The CAPABILITY gate: does calling this tool require `ai.tools.write`?
   *
   * A caller with `ai.chat` but no `ai.tools.write` is never offered a
   * `requiresWrite` tool (`toolAllowedForCapabilities`, the single gate the
   * chat handler, the MCP registry, and `executeAiTool`'s re-check all use),
   * so the model has no way to issue the call. Absent means `false`.
   *
   * Set by the STRONGEST thing the tool can do, not by its common case — which
   * is why it is a separate field from {@link sideEffects}. `studio_screenshot`
   * changes no user content (`sideEffects: 'cache'`) but its live fallback
   * borrows the user's open tab, so it stays write-gated; `studio_typecheck`
   * changes nothing at all (`'none'`) but runs a binary the project's own
   * `node_modules` supplied, so it takes the same gate as installing one.
   */
  readonly requiresWrite?: boolean
  /**
   * The LOOP's field: what a call changes, and therefore whether the HTTP
   * tool loop may run it beside others and whether an identical repeat is
   * suppressed. Required, so a new tool cannot inherit a default it never
   * thought about. See {@link ToolSideEffects}.
   */
  readonly sideEffects: ToolSideEffects
  /**
   * Why this `sideEffects: 'write'` tool has NO canvas-parity path — one
   * sentence, stated on the tool rather than in a test's allowlist.
   *
   * `STUDIO_CANVAS_PARITY_MATRIX` requires every `write` tool to map
   * to a real editor action. A tool whose only artefact is Studio's own agent
   * bookkeeping has no such action, and the honest answer is to say so HERE,
   * where the next person to read the tool sees it, instead of adding its
   * name to a list inside `parityMatrix.test.ts` that nothing makes them
   * justify. The gate reads this field and `docs/features/agent.md` renders
   * it, so "headless-only" is a documented property of the tool, not a
   * silently-suppressed gate failure.
   *
   * Declaring it and appearing in a parity row are mutually exclusive — the
   * gate fails on a tool that claims both, because one of the two statements
   * is then untrue.
   */
  readonly headlessOnly?: string
  /**
   * Capabilities that gate this tool, mirroring its HTTP-route equivalent.
   * ANY-OF semantics: the caller needs at least one. Undefined / empty means
   * the tool is reachable by any `ai.chat` caller (e.g. tools that only read
   * the browser-supplied snapshot). Enforced by `toolAllowedForCapabilities`
   * at selection time and re-checked in `executeAiTool`.
   */
  readonly requiredCapabilities?: readonly CoreCapability[]
  /**
   * Server-side handler. Required for `server` and
   * `server-with-bridge-fallback`. Optional for `bridge`: omitting it is the
   * sentinel that tells the runner to relay the whole call to the open
   * workspace, declaring it means the handler does its own relay and owns the
   * "no board is connected" message. `toolDispatchesInProcess`
   * (`./toolExecution.ts`) is the single reader of that distinction.
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
  /**
   * The Studio project this turn is about — the default a Studio tool's
   * optional `dir` falls back to, via `resolveToolProjectDir`. Mirrors
   * `ToolContextBase.workspaceDir`, which is where it is set.
   */
  readonly workspaceDir?: string
  /**
   * This turn's resolved fidelity mode (W9-2), mirroring
   * `ToolContextBase.fidelityMode` — where it is set, and where the reasoning
   * for the precedence lives. `studio_compare` reads it; `undefined` for a
   * call that did not come from a chat turn (an external MCP client), which
   * simply starts the chain one tier lower.
   */
  readonly fidelityMode?: import('../../handlers/studio/fidelityMode').FidelityMode
  /**
   * This turn's resolved design policy (A12), mirroring
   * `ToolContextBase.designPolicy` — where it is set, and where the reasoning
   * for the precedence lives. `studio_quality_check` reads it; `undefined`
   * for a call that did not come from a chat turn, which starts the chain one
   * tier lower.
   */
  readonly designPolicy?: import('../../handlers/studio/designPolicy').DesignPolicy
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
  /**
   * How this turn's reasoning effort was chosen — emitted once, before the
   * provider is called, by any driver that routes (today: `claudeCli`).
   *
   * Display only, like `context` and `reasoning`: never persisted to history
   * and never fed back to a model. It exists so the routed choice is VISIBLE —
   * a router that silently spends less is indistinguishable from a model having
   * a bad day, and the user has no way to pin the value back if they cannot see
   * that it moved.
   */
  | { type: 'routing'; mode: 'pinned' | 'auto'; effort: string; shape?: string; reason: string }
  /**
   * The provider was momentarily unable (a rate limit, an overload, a 5xx, a
   * dropped connection) and the HTTP tool loop is about to re-send the same
   * request after `delayMs` (AI-8, `drivers/http/providerRetry.ts`). Display
   * only, like `routing`: never persisted, never fed back to a model. It is a
   * quiet status, NOT an error — the turn is still alive, and an `error` only
   * follows if every retry is spent.
   */
  | { type: 'retrying'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
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

