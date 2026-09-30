/**
 * The HTTP tool loop survives what used to end a turn (P4-C):
 *
 *   - AI-8  — a transient provider failure (429 / 5xx / 529, a dropped
 *     connection, a stream `overloaded_error` before any output) is retried
 *     with backoff and a quiet `retrying` event, never a red error;
 *   - AI-11 — `max_tokens` comes from the model, a response the output limit
 *     cut off is continued rather than read as a normal stop (a cut-off tool
 *     call never runs on half its arguments), and `effort` reaches the
 *     provider as extended thinking / reasoning effort, with a model that
 *     refuses the parameters re-asked without them.
 *
 * Driven end to end through the real drivers against a scripted `fetch`, like
 * `toolLoop.test.ts`. `providerRetryTiming.sleep` is replaced so backoff costs
 * no wall-clock time; the delays it WOULD have waited are recorded instead.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { anthropicDriver } from '../../../server/ai/drivers/anthropic'
import { openaiDriver } from '../../../server/ai/drivers/openai'
import { providerRetryTiming, transientRetryDelayMs, retryAfterMs } from '../../../server/ai/drivers/http/providerRetry'
import { anthropicModelProfile } from '../../../server/ai/drivers/anthropicModelProfile'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiStreamEvent, AiTool } from '../../../server/ai/runtime/types'

const realFetch = globalThis.fetch
const realSleep = providerRetryTiming.sleep
let sleeps: number[] = []

beforeEach(() => {
  sleeps = []
  providerRetryTiming.sleep = async (ms: number) => { sleeps.push(ms) }
})
afterEach(() => {
  globalThis.fetch = realFetch
  providerRetryTiming.sleep = realSleep
})

function sse(...events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function sseResponse(body: string): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body))
      controller.close()
    },
  }), { status: 200 })
}

const TEXT_TURN = (text: string, stopReason = 'end_turn'): string => sse(
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
)

/** Serves each scripted reply in order and records every request body. */
function scripted(replies: Array<() => Response>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    const next = replies[bodies.length - 1]
    return next ? next() : sseResponse(TEXT_TURN('done'))
  }) as typeof fetch
  return bodies
}

function request(overrides: Partial<AiStreamRequest> = {}, calls: unknown[] = []): AiStreamRequest {
  const writeTool: AiTool = {
    name: 'write',
    description: 'writes',
    scope: 'shared',
    execution: 'server',
    sideEffects: 'write',
    requiresWrite: true,
    inputSchema: Type.Object({ content: Type.Optional(Type.String()) }),
    async handler(input) {
      calls.push(input)
      return { written: true }
    },
  }
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: [writeTool],
    modelId: 'claude-sonnet-4-6',
    modelCapabilities: { toolCalling: true, visionInput: true, toolResultImages: true, promptCache: true, streaming: true },
    credentials: { id: 'cr', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
    signal: new AbortController().signal,
    bridge: { async callBrowser() { return { ok: true } } },
    toolContextBase: { db: {} as never, userId: 'u1', conversationId: 'c1', snapshot: {}, capabilities: ['ai.chat', 'ai.tools.write'] },
    ...overrides,
  }
}

async function drain(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const textOf = (events: AiStreamEvent[]): string =>
  events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')

// ---------------------------------------------------------------------------
// AI-8 — transient failures are retried
// ---------------------------------------------------------------------------

describe('a transient provider failure is retried, not shown as an error (AI-8)', () => {
  test('a 529 overload, then success: one quiet retry, no error, the answer arrives', async () => {
    const bodies = scripted([
      () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }),
      () => sseResponse(TEXT_TURN('hello')),
    ])
    const events = await drain(anthropicDriver.stream(request()))

    expect(bodies).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'retrying')).toHaveLength(1)
    expect(textOf(events)).toBe('hello')
    expect(sleeps).toEqual([1_000])
  })

  test('honours retry-after, and backs off exponentially without one', async () => {
    scripted([
      () => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
      () => new Response('{}', { status: 503 }),
      () => sseResponse(TEXT_TURN('ok')),
    ])
    const events = await drain(anthropicDriver.stream(request()))
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(sleeps).toEqual([3_000, 2_000])
  })

  test('gives up after three retries with the provider\'s own message', async () => {
    const bodies = scripted(Array.from({ length: 10 }, () => () => new Response('{"error":{"message":"busy"}}', { status: 503 })))
    const events = await drain(anthropicDriver.stream(request()))
    expect(bodies).toHaveLength(4)
    expect(events.filter((e) => e.type === 'retrying')).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect((events.at(-1) as { message: string }).message).toContain('busy')
  })

  test('a mid-stream overloaded_error before any output is retried', async () => {
    const bodies = scripted([
      () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      )),
      () => sseResponse(TEXT_TURN('recovered')),
    ])
    const events = await drain(anthropicDriver.stream(request()))
    expect(bodies).toHaveLength(2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(textOf(events)).toBe('recovered')
  })

  test('a dropped connection is retried', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed: ECONNRESET')
      return sseResponse(TEXT_TURN('back'))
    }) as unknown as typeof fetch
    const events = await drain(anthropicDriver.stream(request()))
    expect(calls).toBe(2)
    expect(textOf(events)).toBe('back')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  test('an auth failure and an exhausted balance are NOT retried', async () => {
    const auth = scripted([() => new Response('{}', { status: 401 })])
    expect((await drain(anthropicDriver.stream(request()))).at(-1)?.type).toBe('error')
    expect(auth).toHaveLength(1)

    const quota = scripted([() => new Response('{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', { status: 429 })])
    expect((await drain(anthropicDriver.stream(request()))).at(-1)?.type).toBe('error')
    expect(quota).toHaveLength(1)
  })

  test('a retry-after longer than a minute is a quota window, not a blip', () => {
    expect(transientRetryDelayMs(1, 120_000)).toBeNull()
    expect(transientRetryDelayMs(1, 5_000)).toBe(5_000)
    expect(transientRetryDelayMs(3, null)).toBe(4_000)
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2_000)
    expect(retryAfterMs(new Headers())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AI-11 — output budget, truncation, effort
// ---------------------------------------------------------------------------

describe('max_tokens is set per model (AI-11)', () => {
  test('a current Claude model gets its real output budget, not 8192', async () => {
    const bodies = scripted([() => sseResponse(TEXT_TURN('hi'))])
    await drain(anthropicDriver.stream(request({ modelId: 'claude-opus-5-5' })))
    expect(bodies[0]!.max_tokens).toBe(64_000)
  })

  test('each family and generation maps to its own ceiling', () => {
    expect(anthropicModelProfile('claude-3-haiku-20240307')).toEqual({ maxOutputTokens: 4_096, reasoning: 'none' })
    expect(anthropicModelProfile('claude-3-5-sonnet-20241022')).toEqual({ maxOutputTokens: 8_192, reasoning: 'none' })
    expect(anthropicModelProfile('claude-3-7-sonnet-20250219')).toEqual({ maxOutputTokens: 64_000, reasoning: 'budget' })
    expect(anthropicModelProfile('claude-opus-4-1-20250805')).toEqual({ maxOutputTokens: 32_000, reasoning: 'budget' })
    expect(anthropicModelProfile('claude-sonnet-4-20250514')).toEqual({ maxOutputTokens: 64_000, reasoning: 'budget' })
    expect(anthropicModelProfile('claude-haiku-4-5-20251001')).toEqual({ maxOutputTokens: 64_000, reasoning: 'budget' })
    expect(anthropicModelProfile('claude-sonnet-4-6')).toEqual({ maxOutputTokens: 64_000, reasoning: 'adaptive' })
    expect(anthropicModelProfile('claude-opus-5-5')).toEqual({ maxOutputTokens: 64_000, reasoning: 'adaptive' })
    // An id it cannot read keeps the conservative budget it always had.
    expect(anthropicModelProfile('some-proxy-model')).toEqual({ maxOutputTokens: 8_192, reasoning: 'none' })
  })
})

describe('a response the output limit cut off continues (AI-11)', () => {
  test('a tool call cut off mid-arguments never runs, is answered, and the loop goes on', async () => {
    const calls: unknown[] = []
    const bodies = scripted([
      () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't_cut', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content":"<div>half a scre' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 64_000 } },
        { type: 'message_stop' },
      )),
      () => sseResponse(TEXT_TURN('I will write it in parts.')),
    ])
    const events = await drain(anthropicDriver.stream(request({}, calls)))

    // Never run on half its input: that would write half a file.
    expect(calls).toHaveLength(0)
    // The turn did NOT stop: the model got a second round, carrying an answer
    // to the cut-off call that tells it how to fit.
    expect(bodies).toHaveLength(2)
    const secondRound = JSON.stringify(bodies[1])
    expect(secondRound).toContain('t_cut')
    expect(secondRound).toContain('cut off by the output limit')
    const result = events.find((e) => e.type === 'toolResult') as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('did NOT run')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  test('a plain reply cut off is continued, not taken as the end', async () => {
    const bodies = scripted([
      () => sseResponse(TEXT_TURN('The first half', 'max_tokens')),
      () => sseResponse(TEXT_TURN(' and the rest.')),
    ])
    const events = await drain(anthropicDriver.stream(request()))
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1])).toContain('Continue exactly where it stopped')
    expect(textOf(events)).toBe('The first half and the rest.')
  })

  test('continuations are bounded', async () => {
    const bodies = scripted(Array.from({ length: 10 }, () => () => sseResponse(TEXT_TURN('more', 'max_tokens'))))
    await drain(anthropicDriver.stream(request()))
    expect(bodies).toHaveLength(3)
  })

  test('malformed arguments WITHOUT an output-limit stop still run and get the schema refusal', async () => {
    const calls: unknown[] = []
    scripted([
      () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't_bad', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not json' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      )),
    ])
    await drain(anthropicDriver.stream(request({}, calls)))
    expect(calls).toEqual([{}])
  })
})

describe('effort maps to thinking / reasoning effort (AI-11)', () => {
  test('no effort chosen sends no reasoning parameters', async () => {
    const bodies = scripted([() => sseResponse(TEXT_TURN('hi'))])
    await drain(anthropicDriver.stream(request()))
    expect(bodies[0]!.thinking).toBeUndefined()
    expect(bodies[0]!.output_config).toBeUndefined()
  })

  test('a current Claude gets adaptive thinking bounded by the chosen effort', async () => {
    const bodies = scripted([() => sseResponse(TEXT_TURN('hi'))])
    await drain(anthropicDriver.stream(request({ effort: 'high' })))
    expect(bodies[0]!.thinking).toEqual({ type: 'adaptive' })
    expect(bodies[0]!.output_config).toEqual({ effort: 'high' })
  })

  test('an older Claude gets a thinking budget that stays under max_tokens', async () => {
    const bodies = scripted([() => sseResponse(TEXT_TURN('hi'))])
    await drain(anthropicDriver.stream(request({ effort: 'max', modelId: 'claude-opus-4-1-20250805' })))
    const thinking = bodies[0]!.thinking as { type: string; budget_tokens: number }
    expect(thinking.type).toBe('enabled')
    expect(thinking.budget_tokens).toBeLessThan(bodies[0]!.max_tokens as number)
  })

  test('thinking blocks stream as reasoning and are sent back whole in the tool loop', async () => {
    const bodies = scripted([
      () => sseResponse(sse(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan the layout.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      )),
      () => sseResponse(TEXT_TURN('done')),
    ])
    const events = await drain(anthropicDriver.stream(request({ effort: 'medium' })))
    expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('')).toBe('Plan the layout.')
    const assistant = (bodies[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)
      .find((m) => m.role === 'assistant')!
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'Plan the layout.', signature: 'sig-abc' })
  })

  test('a model that refuses the reasoning parameters is re-asked without them', async () => {
    const bodies = scripted([
      () => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"thinking is not supported for this model"}}', { status: 400 }),
      () => sseResponse(TEXT_TURN('fine')),
    ])
    const events = await drain(anthropicDriver.stream(request({ effort: 'high' })))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.thinking).toBeDefined()
    expect(bodies[1]!.thinking).toBeUndefined()
    expect(textOf(events)).toBe('fine')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  test('OpenAI gets reasoning.effort, capped at the top of its scale', async () => {
    const bodies = scripted([() => sseResponse(sse(
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ))])
    await drain(openaiDriver.stream(request({
      effort: 'max',
      modelId: 'gpt-5',
      credentials: { id: 'cr', providerId: 'openai', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
    })))
    expect(bodies[0]!.reasoning).toEqual({ effort: 'high' })
  })
})
