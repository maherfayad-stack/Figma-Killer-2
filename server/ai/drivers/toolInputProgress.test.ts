/**
 * AI-26 — a tool call's arguments are surfaced as progress while they stream,
 * on every driver that streams them: the Anthropic HTTP translator, the
 * OpenAI-compatible one, and the `claude` CLI's partial-message lines.
 */
import { describe, expect, it } from 'bun:test'
import { TOOL_INPUT_PROGRESS_STEP_BYTES, ToolInputProgress } from './toolInputProgress'
import { AnthropicTurnTranslator } from './anthropic'
import { ChatCompletionsTurnTranslator } from './http/chatCompletions'
import { createClaudeCliTurnState, parseClaudeCliLineValue, translateClaudeCliLine } from './claudeCliEvents'
import type { AiStreamEvent } from '../runtime/types'

const progressOf = (events: AiStreamEvent[]) => events.filter((e) => e.type === 'toolInputProgress')

describe('ToolInputProgress', () => {
  it('reports the first fragment, then once per step, and names the target file once its path has streamed', () => {
    const tracker = new ToolInputProgress()
    const first = tracker.append('t1', 'studio_write_file', '{"pa')
    expect(first).toEqual({ type: 'toolInputProgress', toolCallId: 't1', toolName: 'studio_write_file', bytes: 4 })
    const named = tracker.append('t1', '', 'th":"pages/Checkout.tsx","content":"')
    expect(named).toMatchObject({ target: 'pages/Checkout.tsx' })
    expect(tracker.append('t1', '', 'x'.repeat(10))).toBeNull()
    const stepped = tracker.append('t1', '', 'x'.repeat(TOOL_INPUT_PROGRESS_STEP_BYTES))
    expect(stepped).toMatchObject({ target: 'pages/Checkout.tsx' })
    expect(stepped!.bytes).toBeGreaterThan(TOOL_INPUT_PROGRESS_STEP_BYTES)
  })

  it('reads the CLI\'s own argument name (file_path) and unescapes it', () => {
    const tracker = new ToolInputProgress()
    expect(tracker.append('t', 'Write', '{"file_path":"C:\\\\p\\\\Home.tsx","content":""}')).toMatchObject({ target: 'C:\\p\\Home.tsx' })
  })
})

describe('drivers surface it', () => {
  it('Anthropic: input_json_delta after a tool_use block start', () => {
    const translator = new AnthropicTurnTranslator()
    const frame = (data: unknown) => ({ event: null, data: JSON.stringify(data) })
    translator.translate(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'studio_write_file' } }))
    const events = translator.translate(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.tsx",' } }))
    expect(progressOf(events)).toEqual([{ type: 'toolInputProgress', toolCallId: 'toolu_1', toolName: 'studio_write_file', bytes: 16, target: 'a.tsx' }])
  })

  it('OpenAI-compatible: streamed function arguments', () => {
    const translator = new ChatCompletionsTurnTranslator()
    const events = translator.translate({
      event: null,
      data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'studio_write_file', arguments: '{"path":"b.css"' } }] } }] }),
    })
    expect(progressOf(events)).toEqual([{ type: 'toolInputProgress', toolCallId: 'call_1', toolName: 'studio_write_file', bytes: 15, target: 'b.css' }])
  })

  it('claude CLI: stream_event content_block_start + input_json_delta', () => {
    const state = createClaudeCliTurnState()
    const line = (event: unknown) => parseClaudeCliLineValue({ type: 'stream_event', event })!
    translateClaudeCliLine(line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Write' } }), state)
    const { events } = translateClaudeCliLine(line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/p/Home.tsx"' } }), state)
    expect(progressOf(events)).toEqual([{ type: 'toolInputProgress', toolCallId: 'toolu_9', toolName: 'Write', bytes: 26, target: '/p/Home.tsx' }])
  })
})
