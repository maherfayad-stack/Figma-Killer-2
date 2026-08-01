/**
 * claudeCliEvents.ts — CLI stream-json line parsing + translation to
 * canonical AiStreamEvents. Fixtures use the exact shapes WS-11 §4.0 verified
 * against the installed binary (v2.1.114) — the four traps in the module
 * doc comment each get a dedicated regression test here.
 */
import { describe, expect, it } from 'bun:test'
import {
  createClaudeCliTurnState,
  parseClaudeCliLine,
  parseClaudeCliLineValue,
  translateClaudeCliLine,
} from './claudeCliEvents'

describe('parseClaudeCliLine', () => {
  it('parses a well-formed line', () => {
    const line = parseClaudeCliLine('{"type":"system","subtype":"init"}')
    expect(line).toEqual({ type: 'system', subtype: 'init' })
  })

  it('returns null for a blank line, never throws', () => {
    expect(parseClaudeCliLine('')).toBeNull()
    expect(parseClaudeCliLine('   ')).toBeNull()
  })

  it('returns null for malformed JSON, never throws', () => {
    expect(parseClaudeCliLine('{not json')).toBeNull()
  })

  it('returns null for JSON that does not match the envelope (e.g. a bare array)', () => {
    expect(parseClaudeCliLine('[1,2,3]')).toBeNull()
  })
})

describe('translateClaudeCliLine — system/init', () => {
  it('produces no wire events (informational only)', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(
      '{"type":"system","subtype":"init","cwd":"/data/claude-cli/u1","session_id":"s1","model":"claude-sonnet-4-6"}',
    )!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
    expect(result.turnComplete).toBe(false)
  })
})

describe('translateClaudeCliLine — assistant', () => {
  it('emits one text event from a real assistant message', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Hello from the CLI.' }],
      },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([{ type: 'text', text: 'Hello from the CLI.' }])
    expect(result.turnComplete).toBe(false)
  })

  it('joins multiple text blocks into one text event', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }],
      },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([{ type: 'text', text: 'Part one. Part two.' }])
  })

  // WS-11 §4.0 trap #3: auth failures arrive as an assistant event carrying
  // a top-level `error`, with `message.model === "<synthetic>"` — never on
  // stderr. This synthetic message must produce NO text event; the honest
  // error surfaces from the terminal `result` event instead (see below).
  it('produces no text event for the synthetic auth-failure assistant message', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'assistant',
      error: 'authentication_failed',
      message: { model: '<synthetic>', content: [] },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
    expect(result.turnComplete).toBe(false)
  })

  it('emits nothing for an assistant message with no text content (e.g. tool-only, unused in step 1)', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6', content: [] },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
  })
})

describe('translateClaudeCliLine — result (success)', () => {
  it('emits context + usage (costUsd from total_cost_usd) + done, keyed off is_error not subtype', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello from the CLI.',
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 },
        'claude-haiku-4-6': { inputTokens: 40, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
      total_cost_usd: 0.168,
      session_id: 's1',
    }))!, createClaudeCliTurnState())

    expect(result.turnComplete).toBe(true)
    expect(result.events).toEqual([
      { type: 'context', promptTokens: 120, cacheReadTokens: 5, cacheCreationTokens: 0 },
      { type: 'usage', promptTokens: 120, completionTokens: 30, costUsd: 0.168, cacheReadTokens: 5, cacheCreationTokens: 0 },
      { type: 'done' },
    ])
  })

  // WS-11 §4.0 trap #2: `subtype` reads "success" even on a FAILED turn —
  // this fixture pairs a success-looking subtype with is_error:true to prove
  // the translator never keys off subtype.
  it('treats a "success"-subtype result as a failure when is_error is true', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'authentication_failed: not logged in',
      usage: { input_tokens: 0, output_tokens: 0 },
    }))!, createClaudeCliTurnState())

    expect(result.turnComplete).toBe(true)
    const errorEvent = result.events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { message: string }).message).toContain('authentication_failed')
  })
})

describe('translateClaudeCliLine — result (error)', () => {
  it('emits an error event, not done, when is_error is true', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      usage: { input_tokens: 10, output_tokens: 0 },
    }))!, createClaudeCliTurnState())

    expect(result.turnComplete).toBe(true)
    expect(result.events.some((e) => e.type === 'done')).toBe(false)
    expect(result.events.some((e) => e.type === 'error')).toBe(true)
  })

  it('still reports context/usage before the error, so partial billing is never lost', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      usage: { input_tokens: 10, output_tokens: 4 },
    }))!, createClaudeCliTurnState())

    expect(result.events[0]).toMatchObject({ type: 'context', promptTokens: 10 })
    expect(result.events[1]).toMatchObject({ type: 'usage', promptTokens: 10, completionTokens: 4 })
  })
})

// WS-12 §5.4 — written against the DOCUMENTED Anthropic streaming shape
// (`content_block_delta` / `thinking_delta`), UNVERIFIED against a real CLI
// turn. These tests fix the CONTRACT this driver was built against, not a
// confirmed observation — see claudeCliEvents.ts's own doc comment.
describe('translateClaudeCliLine — stream_event (reasoning, unverified shape)', () => {
  it('emits a reasoning event for a thinking_delta content_block_delta', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me check the node tree first...' },
      },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([{ type: 'reasoning', text: 'Let me check the node tree first...' }])
    expect(result.turnComplete).toBe(false)
  })

  it('emits nothing for a stream_event whose delta is a plain text_delta, not thinking_delta', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
  })

  it('emits nothing for a stream_event with an empty thinking string', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
  })

  it('emits nothing for a stream_event with no inner event at all — never throws', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine('{"type":"stream_event"}')!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
    expect(result.turnComplete).toBe(false)
  })

  it('emits nothing for a content_block_start carrying a thinking block (only the delta form is handled)', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    }))!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
  })
})

describe('translateClaudeCliLine — unrecognised event types', () => {
  it('produces no events for an unknown type rather than throwing', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine('{"type":"user"}')!, createClaudeCliTurnState())
    expect(result.events).toEqual([])
    expect(result.turnComplete).toBe(false)
  })
})

describe('parseClaudeCliLineValue', () => {
  it('validates an already-JSON.parsed value (the shape claudeCliSpawn.ts hands it)', () => {
    const value = parseClaudeCliLineValue({ type: 'system', subtype: 'init' })
    expect(value).toEqual({ type: 'system', subtype: 'init' })
  })

  it('returns null for a shape that does not match the envelope', () => {
    expect(parseClaudeCliLineValue('not an object')).toBeNull()
    expect(parseClaudeCliLineValue(null)).toBeNull()
    expect(parseClaudeCliLineValue(42)).toBeNull()
  })
})

// Fixtures below are copied verbatim from a real v2.1.114 turn ("Read note.txt
// and tell me the first word") captured with --include-partial-messages.
// Before this translation existed the panel showed nothing at all while the
// CLI worked: thinking streamed but tool activity was dropped, so a long
// tool-using task looked like a hang.
describe('translateClaudeCliLine — tool calls', () => {
  const toolUseLine = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'thinking', thinking: 'Let me read the file.', signature: 'EsUCCpMB' },
        {
          type: 'tool_use',
          id: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
          name: 'Read',
          input: { file_path: 'C:\note.txt' },
          caller: { type: 'direct' },
        },
      ],
    },
  })

  const toolResultLine = JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          tool_use_id: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
          type: 'tool_result',
          content: '1\tbanana split\n',
        },
      ],
    },
  })

  it('emits a pending toolCall from an assistant tool_use block', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(toolUseLine)!, createClaudeCliTurnState())
    expect(result.events).toEqual([
      {
        type: 'toolCall',
        toolCallId: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
        toolName: 'Read',
        input: { file_path: 'C:\note.txt' },
        status: 'pending',
      },
    ])
    expect(result.turnComplete).toBe(false)
  })

  // The reasoning already streamed as `thinking_delta`; emitting it again from
  // the complete block would print the model's thinking twice, because the
  // browser appends reasoning text to the open block.
  it('does not re-emit a thinking block that already streamed as deltas', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(toolUseLine)!, createClaudeCliTurnState())
    expect(result.events.some((e) => e.type === 'reasoning')).toBe(false)
  })

  it('closes the call out with a toolResult, naming the tool the id belongs to', () => {
    const state = createClaudeCliTurnState()
    translateClaudeCliLine(parseClaudeCliLine(toolUseLine)!, state)
    const result = translateClaudeCliLine(parseClaudeCliLine(toolResultLine)!, state)
    expect(result.events).toEqual([
      {
        type: 'toolResult',
        toolCallId: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
        toolName: 'Read',
        ok: true,
        error: undefined,
      },
    ])
  })

  it('surfaces a failed tool result with its message', () => {
    const state = createClaudeCliTurnState()
    translateClaudeCliLine(parseClaudeCliLine(toolUseLine)!, state)
    const failed = JSON.stringify({
      type: 'user',
      message: {
        content: [{
          tool_use_id: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
          type: 'tool_result',
          is_error: true,
          content: 'File does not exist.',
        }],
      },
    })
    const result = translateClaudeCliLine(parseClaudeCliLine(failed)!, state)
    expect(result.events[0]).toMatchObject({ ok: false, error: 'File does not exist.' })
  })

  // Turn state is per-turn on purpose: a module-level map would leak tool
  // names between concurrent chats in the same server process.
  it('falls back to the id when the pairing tool_use was never seen', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(toolResultLine)!, createClaudeCliTurnState())
    expect(result.events[0]).toMatchObject({
      toolCallId: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
      toolName: 'toolu_01Fd8yb4wZNR9RuUTS4muQQp',
    })
  })

  it('emits text and tool calls together, in block order, from one assistant line', () => {
    const mixed = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5-20251001',
        content: [
          { type: 'text', text: 'Reading the file now.' },
          { type: 'tool_use', id: 'toolu_2', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
    })
    const result = translateClaudeCliLine(parseClaudeCliLine(mixed)!, createClaudeCliTurnState())
    expect(result.events.map((e) => e.type)).toEqual(['text', 'toolCall'])
  })
})
