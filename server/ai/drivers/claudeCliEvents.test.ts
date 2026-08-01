/**
 * claudeCliEvents.ts — CLI stream-json line parsing + translation to
 * canonical AiStreamEvents. Fixtures use the exact shapes WS-11 §4.0 verified
 * against the installed binary (v2.1.114) — the four traps in the module
 * doc comment each get a dedicated regression test here.
 */
import { describe, expect, it } from 'bun:test'
import {
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
    )!)
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
    }))!)
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
    }))!)
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
    }))!)
    expect(result.events).toEqual([])
    expect(result.turnComplete).toBe(false)
  })

  it('emits nothing for an assistant message with no text content (e.g. tool-only, unused in step 1)', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6', content: [] },
    }))!)
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
    }))!)

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
    }))!)

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
    }))!)

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
    }))!)

    expect(result.events[0]).toMatchObject({ type: 'context', promptTokens: 10 })
    expect(result.events[1]).toMatchObject({ type: 'usage', promptTokens: 10, completionTokens: 4 })
  })
})

describe('translateClaudeCliLine — unrecognised event types', () => {
  it('produces no events for an unknown type rather than throwing', () => {
    const result = translateClaudeCliLine(parseClaudeCliLine('{"type":"user"}')!)
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
