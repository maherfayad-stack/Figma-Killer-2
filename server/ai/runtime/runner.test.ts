/**
 * runChat — the `abandonedSignal` write-gate is the focus here (`RunChatArgs`
 * doc comment; wired from `chat.ts`'s `abandonTurn`/`armAbortedReleaseGuard`).
 *
 * Once a turn's conversation lock has been force-released to a NEW turn (the
 * defence-in-depth backstop for a driver that never settles), this turn must
 * never persist another byte — otherwise the abandoned turn and the new turn
 * could interleave writes to the same conversation, exactly what
 * `acquireConversationStream` exists to prevent. Every exit path (mid-stream,
 * clean end, thrown error) is covered, plus one baseline test proving the
 * normal (never-abandoned) path is unaffected — `runner.ts` had no tests
 * before this change.
 */
import { describe, expect, it } from 'bun:test'
import { runChat } from './runner'
import type { ConversationsPersister } from './persister'
import type { AiProvider, AiStreamRequest } from '../drivers/types'
import type { AiStreamEvent } from './types'

function baseRequest(): AiStreamRequest {
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    tools: [],
    modelId: 'sonnet',
    modelCapabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
    credentials: { id: 'cred-1', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'token', baseUrl: null },
    signal: new AbortController().signal,
    bridge: { async callBrowser() { return { ok: false, error: 'unused' } } },
    toolContextBase: {
      db: {} as never,
      userId: 'user-1',
      capabilities: ['ai.chat'],
      conversationId: 'conv-1',
      snapshot: null,
    },
  }
}

function fakeProvider(stream: AiProvider['stream']): AiProvider {
  return {
    id: 'anthropic',
    label: 'Fake',
    supportedAuthModes: ['apiKey'],
    capabilities: () => ({ toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true }),
    async listModels() { return [] },
    stream,
  }
}

function fakePersister(): ConversationsPersister & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async appendAssistantText(text) { calls.push(`appendAssistantText:${text}`) },
    async appendToolCall({ toolCallId }) { calls.push(`appendToolCall:${toolCallId}`) },
    async appendToolResult({ toolCallId }) { calls.push(`appendToolResult:${toolCallId}`) },
    async recordUsage() { calls.push('recordUsage'); return 0 },
    recordContext() { calls.push('recordContext') },
  }
}

describe('runChat — abandonedSignal write gate', () => {
  it('baseline: persists and emits normally when abandonedSignal is never provided', async () => {
    const persister = fakePersister()
    const emitted: AiStreamEvent[] = []
    const driver = fakeProvider(async function* () {
      yield { type: 'text', text: 'hello' }
      yield { type: 'toolCall', toolCallId: 't1', toolName: 'x', input: {}, status: 'pending' }
      yield { type: 'toolResult', toolCallId: 't1', toolName: 'x', ok: true }
    })

    await runChat({ driver, request: baseRequest(), persister, emit: (e) => emitted.push(e) })

    expect(persister.calls).toEqual([
      'appendAssistantText:hello', // flushed ahead of the tool-call row, preserving chronological order
      'appendToolCall:t1',
      'appendToolResult:t1',
    ])
    expect(emitted.at(-1)).toEqual({ type: 'done' })
  })

  it('refuses to persist or emit once abandonedSignal aborts mid-stream — even the event that raced the abort', async () => {
    const turnDeath = new AbortController()
    const persister = fakePersister()
    const emitted: AiStreamEvent[] = []
    const driver = fakeProvider(async function* () {
      yield { type: 'text', text: 'hello' }
      // The guard fires here — a new turn may now hold the conversation lock.
      turnDeath.abort()
      yield { type: 'toolCall', toolCallId: 't1', toolName: 'x', input: {}, status: 'pending' }
      yield { type: 'usage', promptTokens: 1, completionTokens: 1 }
    })

    await runChat({
      driver,
      request: baseRequest(),
      persister,
      emit: (e) => emitted.push(e),
      abandonedSignal: turnDeath.signal,
    })

    // Only the pre-abort text event was ever forwarded — the toolCall event
    // that arrived alongside the abort was refused before it could be
    // emitted OR persisted, and the pending "hello" text was never flushed.
    expect(emitted).toEqual([{ type: 'text', text: 'hello' }])
    expect(persister.calls).toEqual([])
  })

  it('skips the trailing flush when abandonment happens after the last event but before stream end', async () => {
    const turnDeath = new AbortController()
    const persister = fakePersister()
    const emitted: AiStreamEvent[] = []
    const driver = fakeProvider(async function* () {
      yield { type: 'text', text: 'partial reply' }
      // Fires after the last event is consumed, before the generator returns —
      // the "stream ended without explicit error or done" path in runChat.
      turnDeath.abort()
    })

    await runChat({
      driver,
      request: baseRequest(),
      persister,
      emit: (e) => emitted.push(e),
      abandonedSignal: turnDeath.signal,
    })

    // The text event itself was forwarded (abandonment hadn't happened yet),
    // but the pending-text flush and the terminal `done` never ran.
    expect(emitted).toEqual([{ type: 'text', text: 'partial reply' }])
    expect(persister.calls).toEqual([])
  })

  it('skips the crash-recovery flush when abandonment races a thrown driver error', async () => {
    const turnDeath = new AbortController()
    const persister = fakePersister()
    const emitted: AiStreamEvent[] = []
    const driver = fakeProvider(async function* () {
      yield { type: 'text', text: 'before the crash' }
      turnDeath.abort()
      throw new Error('driver exploded')
    })

    await runChat({
      driver,
      request: baseRequest(),
      persister,
      emit: (e) => emitted.push(e),
      abandonedSignal: turnDeath.signal,
    })

    expect(emitted).toEqual([{ type: 'text', text: 'before the crash' }])
    expect(persister.calls).toEqual([])
  })
})
