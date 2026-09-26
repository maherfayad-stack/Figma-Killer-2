import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { anthropicDriver } from '../../../server/ai/drivers/anthropic'
import {
  MAX_TOOL_ROUNDS,
  PROVIDER_RETRY_IMAGE_OMITTED,
  messageCacheBreakpoints,
} from '../../../server/ai/drivers/http/toolLoop'
import type { ProviderAdapter, TurnToolResult } from '../../../server/ai/drivers/http/toolLoopTypes'
import { projectHeavyElision } from '../../../server/ai/drivers/http/heavyElision'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiBrowserBridge, AiStreamEvent, AiTool, AiToolOutput, ToolSideEffects } from '../../../server/ai/runtime/types'

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
    sideEffects: 'none',
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
    execution: 'bridge',
    sideEffects: 'none',
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
      // `executeAiTool` re-checks every call against these; a `requiresWrite` tool
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
// Z3 — the loop's two ceilings
// ---------------------------------------------------------------------------

/** A mutating server tool that records every input its handler actually ran with. */
function mutatingTool(calls: unknown[]): AiTool {
  return {
    name: 'site_duplicate_node',
    description: 'duplicates a node',
    scope: 'site',
    execution: 'server',
    sideEffects: 'write',
    requiresWrite: true,
    inputSchema: Type.Object({ nodeId: Type.Optional(Type.String()) }),
    async handler(input) {
      calls.push(input)
      return { nodeId: 'node-2' }
    },
  }
}

describe('a repeated mutating call is answered, not re-executed', () => {
  test('runs the write once however many times the model asks for it', async () => {
    const handlerCalls: unknown[] = []
    // Fifty identical calls, one per round — the shape the plan names: "a
    // fixture model that emits the same call 50 times produces one write".
    const requestBodies = scriptedFetch(
      Array.from({ length: 50 }, (_, i) => toolUseTurn([{ id: `t${i}`, name: 'site_duplicate_node' }])),
    )
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [], {
      tools: [mutatingTool(handlerCalls)],
    })

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    // ONE write. Every later call was answered without reaching the handler.
    expect(handlerCalls).toHaveLength(1)

    // And the SECOND ceiling stops the turn before all fifty rounds are paid
    // for: a model repeating itself is not going to stop on its own. The cap
    // spends exactly one more request, with tools off, on a summary (AI-10).
    expect(requestBodies).toHaveLength(MAX_TOOL_ROUNDS + 1)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('usage')

    const toolResults = events.filter((e) => e.type === 'toolResult') as Array<{ ok: boolean; error?: string }>
    expect(toolResults).toHaveLength(MAX_TOOL_ROUNDS)
    expect(toolResults[0]!.ok).toBe(true)
    expect(toolResults.slice(1).every((r) => r.ok === false)).toBe(true)
    // The refusal SAYS why — a silent no-op would leave the model calling it
    // another forty-nine times for the same lack of a reason.
    expect(toolResults[1]!.error).toContain('already called this turn with identical arguments')

    // And the model is told so structurally, carrying the first call's own
    // outcome so it can carry on from a real result.
    expect(JSON.stringify(requestBodies[1])).not.toContain('duplicate-call')
    const thirdRoundBody = JSON.stringify(requestBodies[2])
    expect(thirdRoundBody).toContain('duplicate-call')
    expect(thirdRoundBody).toContain('priorResult')
    expect(thirdRoundBody).toContain('node-2')
  })

  test('treats a different argument as a different call', async () => {
    const handlerCalls: unknown[] = []
    const withArg = (id: string, nodeId: string): string =>
      sse(
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'site_duplicate_node', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nodeId }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      )
    scriptedFetch([withArg('a', 'n1'), withArg('b', 'n1'), withArg('c', 'n2'), TURN2])
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [], {
      tools: [mutatingTool(handlerCalls)],
    })

    for await (const _event of anthropicDriver.stream(req)) { /* drain */ }

    // n1 ran once (its immediate repeat was answered); n2 is a different call.
    // A repeat of n1 AFTER n2 landed would run again — see the write-epoch
    // tests below.
    expect(handlerCalls).toEqual([{ nodeId: 'n1' }, { nodeId: 'n2' }])
  })

  test('exempts read-only tools — re-reading is how a model checks its own work', async () => {
    const serverCalls: unknown[] = []
    scriptedFetch([
      toolUseTurn([{ id: 'r1', name: 'echo' }]),
      toolUseTurn([{ id: 'r2', name: 'echo' }]),
      toolUseTurn([{ id: 'r3', name: 'echo' }]),
      TURN2,
    ])
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, serverCalls)

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(serverCalls).toHaveLength(3)
    expect((events.filter((e) => e.type === 'toolResult') as Array<{ ok: boolean }>).every((r) => r.ok)).toBe(true)
  })
})

describe('the tool-round cap ends the turn well (AI-10)', () => {
  const SUMMARY = sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Built two screens; the third is not verified.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  )

  test('warns three rounds ahead, then ends on a tools-off summary round instead of an error', async () => {
    const serverCalls: unknown[] = []
    const requestBodies = scriptedFetch([
      ...Array.from({ length: 5 }, (_, i) => toolUseTurn([{ id: `e${i}`, name: 'echo' }])),
      SUMMARY,
    ])
    const req: AiStreamRequest = {
      ...makeRequest({ async callBrowser() { return { ok: true } } }, serverCalls),
      maxToolRounds: 5,
    }

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    // Five tool rounds, then ONE more request: the summary.
    expect(serverCalls).toHaveLength(5)
    expect(requestBodies).toHaveLength(6)

    // The wind-down note rides the tool results of round 2 — 3 rounds left —
    // so it is first seen by request 3, and by no request before it.
    expect(JSON.stringify(requestBodies[1])).not.toContain('tool rounds are left')
    expect(JSON.stringify(requestBodies[2])).toContain('3 tool rounds are left')

    // The summary request keeps the tool definitions (cache, history) but may
    // not call one, and tells the model why.
    for (const body of requestBodies.slice(0, 5)) expect(body.tool_choice).toBeUndefined()
    expect(requestBodies[5]!.tool_choice).toEqual({ type: 'none' })
    expect(requestBodies[5]!.tools).toBeDefined()
    expect(JSON.stringify(requestBodies[5])).toContain('your tools are now switched off')

    // No error event: the turn ends on the model's own account of itself.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toContain('the third is not verified')
    expect(events.at(-1)?.type).toBe('usage')
  })

  test('a failed summary request ends the turn quietly, with its usage', async () => {
    const requestBodies: unknown[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      if (requestBodies.length <= 2) return sseResponse(toolUseTurn([{ id: `e${requestBodies.length}`, name: 'echo' }]))
      return new Response('{"error":{"message":"nope"}}', { status: 400 })
    }) as typeof fetch
    const req: AiStreamRequest = { ...makeRequest({ async callBrowser() { return { ok: true } } }, []), maxToolRounds: 2 }

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(3)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('usage')
  })

  test('leaves a turn that finishes inside the cap alone', async () => {
    const serverCalls: unknown[] = []
    const requestBodies = scriptedFetch([toolUseTurn([{ id: 'e0', name: 'echo' }]), TURN2])
    const req: AiStreamRequest = {
      ...makeRequest({ async callBrowser() { return { ok: true } } }, serverCalls),
      maxToolRounds: 3,
    }

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(JSON.stringify(requestBodies)).not.toContain('[Studio]')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('all done')
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
      sideEffects: 'none',
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
  function tracingTool(name: string, log: string[], sideEffects: ToolSideEffects): AiTool {
    return {
      name,
      description: `${name} tool`,
      scope: 'site',
      execution: 'server',
      sideEffects,
      ...(sideEffects === 'none' ? {} : { requiresWrite: true }),
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
        tracingTool('readA', log, 'none'),
        tracingTool('readB', log, 'none'),
        tracingTool('readC', log, 'none'),
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
        tracingTool('readA', log, 'none'),
        tracingTool('readB', log, 'none'),
        tracingTool('writeIt', log, 'write'),
        tracingTool('readC', log, 'none'),
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

// ---------------------------------------------------------------------------
// AI-5 — the loop reads `sideEffects`, not the capability gate
// ---------------------------------------------------------------------------

/** An SSE turn issuing each call with its own JSON arguments, stopping on `tool_use`. */
function argTurn(calls: Array<{ id: string; name: string; input?: Record<string, unknown> }>): string {
  const events: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }]
  calls.forEach((call, index) => {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) } })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
  events.push({ type: 'message_stop' })
  return sse(...events)
}

/**
 * A write-GATED observer, shaped like `studio_screenshot`: `requiresWrite`
 * (the capability gate) but `sideEffects: 'cache'` (what the loop reads). The
 * handler returns a per-tool counter, so a stale answer is distinguishable
 * from a fresh one.
 */
function gatedObserver(name: string, calls: string[], sideEffects: 'none' | 'cache' = 'cache'): AiTool {
  return {
    name,
    description: `${name} observer`,
    scope: 'shared',
    execution: 'server',
    sideEffects,
    requiresWrite: true,
    inputSchema: Type.Object({ pages: Type.Optional(Type.Array(Type.String())) }),
    async handler() {
      calls.push(name)
      return { capture: calls.filter((c) => c === name).length }
    },
  }
}

/** A write that refuses when asked for `value: 'bad'`, and records every value it actually ran with. */
function settingWrite(ran: string[]): AiTool {
  return {
    name: 'studio_set_frames',
    description: 'sets a value',
    scope: 'shared',
    execution: 'server',
    sideEffects: 'write',
    requiresWrite: true,
    inputSchema: Type.Object({ value: Type.String() }),
    async handler(input) {
      const { value } = input as { value: string }
      ran.push(value)
      return value === 'bad' ? { ok: false, error: 'refused: bad value' } : { ok: true, data: { value } }
    },
  }
}

async function drain(req: AiStreamRequest): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = []
  for await (const event of anthropicDriver.stream(req)) events.push(event)
  return events
}

const noBridge: AiBrowserBridge = { async callBrowser() { return { ok: true } } }

describe('observers are never answered from a stale result (AI-5)', () => {
  test('write, screenshot, fix, screenshot: the second look runs and sees the fix', async () => {
    const observed: string[] = []
    const ran: string[] = []
    const requestBodies = scriptedFetch([
      argTurn([{ id: 'w1', name: 'studio_set_frames', input: { value: 'first' } }]),
      argTurn([{ id: 's1', name: 'studio_screenshot', input: { pages: ['Checkout'] } }]),
      argTurn([{ id: 'w2', name: 'studio_set_frames', input: { value: 'fixed' } }]),
      argTurn([{ id: 's2', name: 'studio_screenshot', input: { pages: ['Checkout'] } }]),
      TURN2,
    ])
    const req = makeRequest(noBridge, [], { tools: [gatedObserver('studio_screenshot', observed), settingWrite(ran)] })

    const events = await drain(req)

    // Before AI-5 the screenshot was `mutates: true`, so the second identical
    // call was fingerprinted and answered with capture #1, the pre-fix image.
    expect(observed).toEqual(['studio_screenshot', 'studio_screenshot'])
    expect(ran).toEqual(['first', 'fixed'])
    const results = events.filter((e) => e.type === 'toolResult') as Array<{ ok: boolean }>
    expect(results.every((r) => r.ok)).toBe(true)
    expect(requestBodies.map((b) => JSON.stringify(b)).join('')).not.toContain('duplicate-call')
    const lastToolResult = JSON.stringify((requestBodies[4]!.messages as unknown[]).at(-1))
    expect(lastToolResult).toContain('capture')
    expect(lastToolResult).toContain('2')
  })

  test('the same observation asked twice in one turn runs twice', async () => {
    const observed: string[] = []
    scriptedFetch([
      argTurn([{ id: 'c1', name: 'studio_compare', input: { pages: ['A'] } }]),
      argTurn([{ id: 'c2', name: 'studio_compare', input: { pages: ['A'] } }]),
      argTurn([{ id: 't1', name: 'studio_typecheck' }]),
      argTurn([{ id: 't2', name: 'studio_typecheck' }]),
      TURN2,
    ])
    const req = makeRequest(noBridge, [], {
      tools: [gatedObserver('studio_compare', observed), gatedObserver('studio_typecheck', observed, 'none')],
    })

    await drain(req)

    expect(observed).toEqual(['studio_compare', 'studio_compare', 'studio_typecheck', 'studio_typecheck'])
  })

  test('write-gated observers in one batch run concurrently', async () => {
    const log: string[] = []
    const slow = (name: string, sideEffects: 'none' | 'cache'): AiTool => ({
      ...gatedObserver(name, [], sideEffects),
      async handler() {
        log.push(`enter:${name}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        log.push(`exit:${name}`)
        return { name }
      },
    })
    scriptedFetch([
      argTurn([
        { id: 'a', name: 'studio_screenshot' },
        { id: 'b', name: 'studio_compare' },
        { id: 'c', name: 'studio_measure_element' },
        { id: 'd', name: 'studio_typecheck' },
        { id: 'e', name: 'studio_export_frames' },
      ]),
      TURN2,
    ])
    const req = makeRequest(noBridge, [], {
      tools: [
        slow('studio_screenshot', 'cache'),
        slow('studio_compare', 'cache'),
        slow('studio_measure_element', 'cache'),
        slow('studio_typecheck', 'none'),
        slow('studio_export_frames', 'none'),
      ],
    })

    const events = await drain(req)

    // All five entered before any exited: one concurrent group, not five.
    expect(log.slice(0, 5).every((entry) => entry.startsWith('enter:'))).toBe(true)
    expect(events.filter((e) => e.type === 'toolResult').map((e) => (e as { toolName: string }).toolName)).toEqual([
      'studio_screenshot', 'studio_compare', 'studio_measure_element', 'studio_typecheck', 'studio_export_frames',
    ])
  })
})

describe('the duplicate-write bound keys on the per-turn write epoch (AI-5)', () => {
  async function runWrites(values: string[]): Promise<{ ran: string[]; results: Array<{ ok: boolean; error?: string }> }> {
    const ran: string[] = []
    const turns = values.map((value, i) =>
      value === '<look>'
        ? argTurn([{ id: `l${i}`, name: 'studio_screenshot' }])
        : argTurn([{ id: `w${i}`, name: 'studio_set_frames', input: { value } }]),
    )
    scriptedFetch([...turns, TURN2])
    const tools = [settingWrite(ran), gatedObserver('studio_screenshot', [])]
    const events = await drain(makeRequest(noBridge, [], { tools }))
    return { ran, results: events.filter((e) => e.type === 'toolResult') as Array<{ ok: boolean; error?: string }> }
  }

  test('A, A: the repeat is answered from the first (nothing was written in between)', async () => {
    const { ran, results } = await runWrites(['390', '390'])
    expect(ran).toEqual(['390'])
    expect(results[1]!.error).toContain('duplicate-call')
  })

  test('A, B, A: the third call RUNS, because B landed in between', async () => {
    const { ran, results } = await runWrites(['390', '402', '390'])
    expect(ran).toEqual(['390', '402', '390'])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  test('A, look, A: an observation does not advance the epoch, so the repeat is still answered', async () => {
    const { ran } = await runWrites(['390', '<look>', '390'])
    expect(ran).toEqual(['390'])
  })

  test('refused A, A is answered; refused A, landed B, A runs again', async () => {
    const repeated = await runWrites(['bad', 'bad'])
    expect(repeated.ran).toEqual(['bad'])

    const afterWrite = await runWrites(['bad', '402', 'bad'])
    expect(afterWrite.ran).toEqual(['bad', '402', 'bad'])
  })
})
