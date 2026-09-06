import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { anthropicDriver } from '../../../server/ai/drivers/anthropic'
import {
  PROVIDER_RETRY_IMAGE_OMITTED,
  messageCacheBreakpoints,
  projectHeavyElision,
  type ProviderAdapter,
  type TurnToolResult,
} from '../../../server/ai/drivers/http/toolLoop'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiBrowserBridge, AiStreamEvent, AiTool, AiToolOutput } from '../../../server/ai/runtime/types'

/**
 * Exercises the provider-agnostic tool loop end-to-end through the Anthropic
 * driver against a mocked `fetch`: turn 1 issues a server-handler tool call and
 * a browser-bridge tool call (stop_reason: tool_use); turn 2 ends with text.
 * Asserts both tools execute and the SECOND request body carries the
 * tool_result turn.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function sse(...events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function sseResponse(body: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

// Turn 1: model calls a server tool (echo) and a browser tool (paint).
const TURN1 = sse(
  { type: 'message_start', message: { usage: { input_tokens: 20 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't_echo', name: 'echo', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"v":42}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't_paint', name: 'paint', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
  { type: 'message_stop' },
)

// Turn 2: model finishes with text.
const TURN2 = sse(
  { type: 'message_start', message: { usage: { input_tokens: 30 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'all done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
)

/** An SSE turn that issues `calls` as tool_use blocks and stops on `tool_use`. */
function toolUseTurn(calls: Array<{ id: string; name: string }>): string {
  const events: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }]
  calls.forEach((call, index) => {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
  events.push({ type: 'message_stop' })
  return sse(...events)
}

/** Serves each SSE body in order, recording every request body it was sent. */
function scriptedFetch(bodies: string[]): Array<Record<string, unknown>> {
  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestBodies.push(JSON.parse(init.body as string))
    return sseResponse(bodies[requestBodies.length - 1] ?? TURN2)
  }) as typeof fetch
  return requestBodies
}

function makeRequest(
  bridge: AiBrowserBridge,
  serverCalls: unknown[],
  overrides: Partial<Pick<AiStreamRequest, 'tools' | 'systemPrompt'>> = {},
): AiStreamRequest {
  const echoTool: AiTool = {
    name: 'echo',
    description: 'echoes its input',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object({ v: Type.Optional(Type.Number()) }),
    async handler(input) {
      serverCalls.push(input)
      return { echoed: input }
    },
  }
  const paintTool: AiTool = {
    name: 'paint',
    description: 'a browser tool',
    scope: 'site',
    execution: 'browser',
    inputSchema: Type.Object({}),
  }
  return {
    systemPrompt: overrides.systemPrompt ?? ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: overrides.tools ?? [echoTool, paintTool],
    modelId: 'claude-sonnet-4-6',
    modelCapabilities: { toolCalling: true, visionInput: true, toolResultImages: true, promptCache: true, streaming: true },
    credentials: { id: 'cr', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
    signal: new AbortController().signal,
    bridge,
    toolContextBase: {
      db: {} as never,
      userId: 'u1',
      conversationId: 'c1',
      snapshot: {},
      // `executeAiTool` re-checks every call against these; a `mutates` tool
      // needs `ai.tools.write` or it is refused before its handler runs.
      capabilities: ['ai.chat', 'ai.tools.write'],
    },
  }
}

describe('runToolLoop via anthropicDriver', () => {
  test('executes server + browser tools and replays the tool result on the second request', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(requestBodies.length === 1 ? TURN1 : TURN2)
    }) as typeof fetch

    const browserCalls: Array<{ name: string; input: unknown }> = []
    const bridge: AiBrowserBridge = {
      async callBrowser(toolName, input): Promise<AiToolOutput> {
        browserCalls.push({ name: toolName, input })
        return { ok: true, data: { painted: true } }
      },
    }
    const serverCalls: unknown[] = []
    const req = makeRequest(bridge, serverCalls)

    const events: AiStreamEvent[] = []
    for await (const ev of anthropicDriver.stream(req)) events.push(ev)

    // Two POSTs were made — initial turn + the re-POST after tool execution.
    expect(requestBodies).toHaveLength(2)

    // Server handler ran with the re-validated input.
    expect(serverCalls).toEqual([{ v: 42 }])
    // Browser bridge ran for the browser tool.
    expect(browserCalls).toEqual([{ name: 'paint', input: {} }])

    // The 2nd request body must carry the assistant tool_use turn + the
    // tool_result user turn.
    const secondMessages = requestBodies[1]!.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>
    const toolResultTurn = secondMessages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
    expect(toolResultTurn).toBeDefined()
    const toolUseIds = toolResultTurn!.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
    expect(toolUseIds).toEqual(['t_echo', 't_paint'])

    // Canonical events: two toolCalls, two toolResults, the final text, usage.
    const toolCalls = events.filter((e) => e.type === 'toolCall')
    expect(toolCalls.map((e) => (e as { toolName: string }).toolName)).toEqual(['echo', 'paint'])
    const toolResults = events.filter((e) => e.type === 'toolResult')
    expect(toolResults.map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('all done')

    // Usage aggregates across both turns for BILLING: input 20+30=50, output 15+5=20.
    const usage = events.find((e) => e.type === 'usage') as { promptTokens: number; completionTokens: number } | undefined
    expect(usage).toBeDefined()
    expect(usage!.promptTokens).toBe(50)
    expect(usage!.completionTokens).toBe(20)

    // The live meter is driven by per-round `context` events: ONE per provider
    // round, each carrying THAT round's input (20, then 30) — NOT the running
    // sum. The meter reads the latest (30 = current context size), so it climbs
    // mid-turn and never over-counts by summing rounds.
    const contextEvents = events.filter((e) => e.type === 'context') as Array<{ promptTokens: number }>
    expect(contextEvents.map((e) => e.promptTokens)).toEqual([20, 30])
  })

  test('keeps a resolved browser-tool domain failure recoverable', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(requestBodies.length === 1 ? TURN1 : TURN2)
    }) as typeof fetch
    const req = makeRequest({
      async callBrowser() {
        return { ok: false, error: 'Canvas node no longer exists.' }
      },
    }, [])

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(events.filter((event) => event.type === 'toolResult')).toEqual([
      {
        type: 'toolResult',
        toolCallId: 't_echo',
        toolName: 'echo',
        ok: true,
        error: undefined,
      },
      {
        type: 'toolResult',
        toolCallId: 't_paint',
        toolName: 'paint',
        ok: false,
        error: 'Canvas node no longer exists.',
      },
    ])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(JSON.stringify(requestBodies[1])).toContain('Canvas node no longer exists.')
  })

  test('terminates after one failed result when an active browser bridge rejects with AbortError', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(TURN1)
    }) as typeof fetch
    const req = makeRequest({
      async callBrowser() {
        const error = new Error('Browser tool "paint" result timed out.')
        error.name = 'AbortError'
        throw error
      },
    }, [])

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    // The provider is never called for a second round against the same dead
    // bridge. The successful server tool still records its own result first.
    expect(requestBodies).toHaveLength(1)
    expect(events.filter((event) => event.type === 'toolResult')).toEqual([
      {
        type: 'toolResult',
        toolCallId: 't_echo',
        toolName: 'echo',
        ok: true,
        error: undefined,
      },
      {
        type: 'toolResult',
        toolCallId: 't_paint',
        toolName: 'paint',
        ok: false,
        error: 'Browser tool "paint" result timed out.',
      },
    ])
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Browser tool transport failed: Browser tool "paint" result timed out.',
    })
    expect(events.filter((event) => event.type === 'usage')).toEqual([{
      type: 'usage',
      promptTokens: 20,
      completionTokens: 15,
      costUsd: undefined,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    }])
  })

  test('returns an error event (not a throw) on a non-OK HTTP status', async () => {
    globalThis.fetch = (async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as typeof fetch
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])

    const events: AiStreamEvent[] = []
    for await (const ev of anthropicDriver.stream(req)) events.push(ev)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('authentication failed')
  })

  test('retries a provider overflow once with only historical images elided', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          error: { type: 'request_too_large', message: 'Request exceeds the context limit' },
        }), { status: 413 })
      }
      return sseResponse(TURN2)
    }) as typeof fetch

    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])
    const image = { kind: 'image' as const, mimeType: 'image/jpeg', data: '/9j/' }
    req.messages.splice(0, req.messages.length,
      { role: 'user', content: [{ kind: 'text', text: 'Earlier turn' }, image] },
      { role: 'assistant', content: [{ kind: 'text', text: 'Earlier reply' }] },
      { role: 'user', content: [{ kind: 'text', text: 'Current turn' }, image] },
    )

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(JSON.stringify(requestBodies[0]).match(/"type":"image"/g)).toHaveLength(2)
    expect(JSON.stringify(requestBodies[1]).match(/"type":"image"/g)).toHaveLength(1)
    expect(JSON.stringify(requestBodies[1])).toContain(PROVIDER_RETRY_IMAGE_OMITTED)
    expect(req.messages[0]?.content.some((block) => block.kind === 'image')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  test('does not retry when only the current user turn contains images', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('', { status: 413 })
    }) as typeof fetch
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])
    req.messages[0] = {
      role: 'user',
      content: [{ kind: 'image', mimeType: 'image/jpeg', data: '/9j/' }],
    }

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requests).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('Your history is still saved')
  })
})

// ---------------------------------------------------------------------------
// Heavy-evidence elision — a per-request projection, never an edit
// ---------------------------------------------------------------------------

describe('projectHeavyElision', () => {
  /** A minimal adapter: a "message" is just the array of results it carries. */
  const adapter = {
    buildToolResultMessage: (results: TurnToolResult[]) => results.map((r) => `${r.name}:${JSON.stringify(r.output.data)}`).join('|'),
  } as unknown as ProviderAdapter<string>

  const heavy = (name: string, data: unknown): TurnToolResult => ({
    id: `id_${name}_${JSON.stringify(data)}`,
    name,
    output: { ok: true, data },
  })

  test('stubs every superseded heavy result and leaves the newest at full fidelity', () => {
    const history = ['user', 'A', 'B', 'C']
    const heavyMessages = [
      { index: 1, results: [heavy('site_read_document', { html: 'first' })] },
      { index: 2, results: [heavy('site_get_node_html', { html: 'other-tool' })] },
      { index: 3, results: [heavy('site_read_document', { html: 'newest' })] },
    ]

    const projected = projectHeavyElision(history, heavyMessages, adapter)

    expect(projected[1]).toContain('Earlier site_read_document output removed')
    // A DIFFERENT heavy tool is not superseded by this one — elision is per name.
    expect(projected[2]).toBe('B')
    expect(projected[3]).toBe('C')
    // The canonical history is untouched: this is what keeps the cached prefix
    // the next round appends to byte-identical.
    expect(history).toEqual(['user', 'A', 'B', 'C'])
  })

  test('leaves an un-superseded history alone, including its object identities', () => {
    const history = ['user', 'A']
    const heavyMessages = [{ index: 1, results: [heavy('site_read_document', { html: 'only' })] }]
    expect(projectHeavyElision(history, heavyMessages, adapter)).toEqual(['user', 'A'])
  })

  test('elides the replayed heavy result on a later round but not on the round it arrived', async () => {
    const readTool: AiTool = {
      name: 'site_read_document',
      description: 'a heavy read',
      scope: 'site',
      execution: 'server',
      inputSchema: Type.Object({}),
      async handler() {
        return { html: 'FULL-DOCUMENT-PAYLOAD' }
      },
    }
    const requestBodies = scriptedFetch([
      toolUseTurn([{ id: 'r1', name: 'site_read_document' }]),
      toolUseTurn([{ id: 'r2', name: 'site_read_document' }]),
      TURN2,
    ])
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [], { tools: [readTool] })

    for await (const _event of anthropicDriver.stream(req)) { /* drain */ }

    expect(requestBodies).toHaveLength(3)
    // Round 2 replays r1 in full — nothing has superseded it yet.
    expect(JSON.stringify(requestBodies[1])).toContain('FULL-DOCUMENT-PAYLOAD')
    // Round 3 carries r2 at full fidelity and r1 as a breadcrumb.
    const third = JSON.stringify(requestBodies[2])
    expect(third.match(/FULL-DOCUMENT-PAYLOAD/g)).toHaveLength(1)
    expect(third).toContain('Earlier site_read_document output removed')
  })
})

// ---------------------------------------------------------------------------
// Prompt-cache breakpoints
// ---------------------------------------------------------------------------

describe('messageCacheBreakpoints', () => {
  test('collapses to one anchor on the first round and spreads to two once the loop appends', () => {
    expect(messageCacheBreakpoints(3, 3)).toEqual([2])
    expect(messageCacheBreakpoints(3, 6)).toEqual([2, 5])
    expect(messageCacheBreakpoints(0, 2)).toEqual([1])
    expect(messageCacheBreakpoints(3, 0)).toEqual([])
  })
})

describe('Anthropic prompt caching on the wire', () => {
  test('spends all four breakpoints and never exceeds the API limit', async () => {
    const requestBodies = scriptedFetch([TURN1, TURN2])
    const req = makeRequest({ async callBrowser() { return { ok: true, data: { painted: true } } } }, [], {
      systemPrompt: ['STATIC', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'DYNAMIC'],
    })

    for await (const _event of anthropicDriver.stream(req)) { /* drain */ }

    for (const body of requestBodies) {
      const system = body.system as Array<{ cache_control?: unknown }>
      const tools = body.tools as Array<{ cache_control?: unknown }>
      const messages = body.messages as Array<{ content: Array<{ cache_control?: unknown }> }>

      // 1. the static system prefix, 2. the LAST tool definition.
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
      expect(system[1]!.cache_control).toBeUndefined()
      expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
      expect(tools.slice(0, -1).every((t) => t.cache_control === undefined)).toBe(true)

      // 3 + 4. The message anchors — always on a LAST content block, and the
      // final message of the request is always one of them.
      const markedMessages = messages.filter((m) => m.content.some((b) => b.cache_control !== undefined))
      expect(markedMessages.length).toBeGreaterThanOrEqual(1)
      expect(messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })

      const total = JSON.stringify(body).match(/"cache_control"/g)?.length ?? 0
      expect(total).toBeLessThanOrEqual(4)
    }

    // Round 2 keeps the round-1 anchor (the persisted user turn) AND adds one
    // at its own tail, so the growing conversation caches across rounds.
    const secondMessages = requestBodies[1]!.messages as Array<{ content: Array<{ cache_control?: unknown }> }>
    expect(secondMessages.filter((m) => m.content.some((b) => b.cache_control !== undefined))).toHaveLength(2)
    expect(secondMessages[0]!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
  })
})

// ---------------------------------------------------------------------------
// Concurrent tool dispatch
// ---------------------------------------------------------------------------

describe('tool dispatch concurrency', () => {
  /** Records enter/exit so a sequential run and a concurrent one look different. */
  function tracingTool(name: string, log: string[], mutates: boolean): AiTool {
    return {
      name,
      description: `${name} tool`,
      scope: 'site',
      execution: 'server',
      mutates,
      inputSchema: Type.Object({}),
      async handler() {
        log.push(`enter:${name}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        log.push(`exit:${name}`)
        return { name }
      },
    }
  }

  test('runs a batch of read tools concurrently and still emits results in call order', async () => {
    const log: string[] = []
    const requestBodies = scriptedFetch([
      toolUseTurn([{ id: 'a', name: 'readA' }, { id: 'b', name: 'readB' }, { id: 'c', name: 'readC' }]),
      TURN2,
    ])
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [], {
      tools: [
        tracingTool('readA', log, false),
        tracingTool('readB', log, false),
        tracingTool('readC', log, false),
      ],
    })

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(2)
    // All three entered before any exited — the batch overlapped.
    expect(log.slice(0, 3).sort()).toEqual(['enter:readA', 'enter:readB', 'enter:readC'])
    // Emission order is the model's call order, not completion order.
    expect(events.filter((e) => e.type === 'toolResult').map((e) => (e as { toolName: string }).toolName))
      .toEqual(['readA', 'readB', 'readC'])
    const toolResultTurn = (requestBodies[1]!.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>)
      .find((m) => m.content.some((b) => b.type === 'tool_result'))!
    expect(toolResultTurn.content.map((b) => b.tool_use_id)).toEqual(['a', 'b', 'c'])
  })

  test('never overlaps a mutating tool with anything — it splits the batch', async () => {
    const log: string[] = []
    scriptedFetch([
      toolUseTurn([
        { id: 'a', name: 'readA' },
        { id: 'b', name: 'readB' },
        { id: 'w', name: 'writeIt' },
        { id: 'c', name: 'readC' },
      ]),
      TURN2,
    ])
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [], {
      tools: [
        tracingTool('readA', log, false),
        tracingTool('readB', log, false),
        tracingTool('writeIt', log, true),
        tracingTool('readC', log, false),
      ],
    })

    for await (const _event of anthropicDriver.stream(req)) { /* drain */ }

    // The two leading reads overlap; the write waits for both and runs alone;
    // the read AFTER the write waits for the write.
    expect(log.slice(0, 2).sort()).toEqual(['enter:readA', 'enter:readB'])
    expect(log.indexOf('enter:writeIt')).toBeGreaterThan(log.indexOf('exit:readA'))
    expect(log.indexOf('enter:writeIt')).toBeGreaterThan(log.indexOf('exit:readB'))
    expect(log.indexOf('enter:readC')).toBeGreaterThan(log.indexOf('exit:writeIt'))
  })
})
