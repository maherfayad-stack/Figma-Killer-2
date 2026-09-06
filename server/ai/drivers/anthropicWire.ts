/**
 * Anthropic's request-side wire shapes, and where the prompt-cache breakpoints
 * go on them.
 *
 * These are the blocks we CONSTRUCT — never parse — so they are plain
 * interfaces rather than TypeBox schemas (the response side is validated in
 * `anthropic.ts`, which owns the SSE schema). They live here, apart from the
 * driver, because the cache-breakpoint builders below need them and a driver
 * that imported back from a helper module would close an import cycle.
 *
 * ## The four-breakpoint budget
 *
 * Anthropic allows at most FOUR `cache_control` markers per request, and a
 * lookup hits the LONGEST cached prefix that still matches. Studio spends the
 * budget in prefix order, most-stable first:
 *
 *   1. the static system prefix — `buildSystemBlocks` in `anthropic.ts`
 *   2. the last tool definition — {@link buildToolDefinitions}
 *   3. the end of the persisted conversation history
 *   4. the last message of THIS request
 *
 * 3 and 4 are chosen by the provider-agnostic loop (`messageCacheBreakpoints`
 * in `http/toolLoop.ts`) and expressed here by
 * {@link withMessageCacheBreakpoints}; this module only knows how to write a
 * marker, not where one is worth writing.
 *
 * Before this, only 1 was ever marked: every round of a long build loop re-read
 * the ~8–15K-token tool block and the entire conversation so far at full input
 * price, on a conversation that is append-only and therefore almost entirely
 * cacheable.
 */

import type { AiStreamRequest } from './types'

/** The only cache marker Anthropic's Messages API takes. */
interface AnthropicCacheControl {
  type: 'ephemeral'
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
  cache_control?: AnthropicCacheControl
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  // Anthropic tool_result content accepts either a plain string or an array of
  // text/image blocks — the latter lets a tool return a screenshot as a NATIVE
  // image (≈1.5K tokens) instead of base64-as-JSON-text (hundreds of KB → 1M+).
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[]
  is_error?: boolean
  cache_control?: AnthropicCacheControl
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

/**
 * Tool declarations, with a cache breakpoint on the LAST one. A marker caches
 * everything from the start of the request up to the block it sits on, so one
 * marker on the final tool covers the whole tool array — which for the Studio
 * agent is 8–15K tokens of JSON Schema that is identical on every round.
 *
 * The TypeBox `inputSchema` IS JSON Schema, so it passes straight through.
 */
export function buildToolDefinitions(tools: AiStreamRequest['tools']): unknown[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))
}

/**
 * A copy of `messages` with a cache breakpoint on the last content block of
 * each requested index.
 *
 * Copies rather than mutates, and this is load-bearing: the loop's history
 * array is append-only and shared across every round of the turn, so a marker
 * written into it would still be there next round, spending breakpoints nobody
 * asked for and eventually exceeding the four the API allows.
 */
export function withMessageCacheBreakpoints(
  messages: AnthropicMessage[],
  indices: readonly number[],
): AnthropicMessage[] {
  if (indices.length === 0) return messages
  const out = messages.slice()
  for (const index of indices) {
    const message = out[index]
    const last = message?.content[message.content.length - 1]
    // An empty-content message carries nothing to mark; skip rather than
    // synthesise a block, which would change what the model reads.
    if (!message || !last) continue
    out[index] = {
      role: message.role,
      content: [...message.content.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }],
    }
  }
  return out
}
