/**
 * AI-18 — HTTP history compaction: summarise the older turns once the replay
 * passes 60% of the window, pin the summary so the prefix stays stable, and
 * never fail a turn over it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { AiMessage } from '../runtime/types'
import {
  COMPACTION_MODEL_ID,
  KEEP_RECENT_TURNS,
  clearCompactionPins,
  compactHistory,
  estimateHistoryTokens,
} from './compaction'
import { compactHistoryForTurn } from '../historyCompaction'

afterEach(() => clearCompactionPins())

/** `turns` user/assistant pairs, each ~`chars` long. */
function history(turns: number, chars = 4_000): AiMessage[] {
  const out: AiMessage[] = []
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: [{ kind: 'text', text: `ask ${i} ${'x'.repeat(chars)}` }] })
    out.push({ role: 'assistant', content: [{ kind: 'text', text: `did ${i} ${'y'.repeat(chars)}` }] })
  }
  return out
}

function textOf(message: AiMessage | undefined): string {
  return message && message.role !== 'tool' && message.role !== 'system'
    ? message.content.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    : ''
}

describe('compactHistory', () => {
  it('leaves a history under the threshold alone and never calls the summariser', async () => {
    const messages = history(3)
    let calls = 0
    const out = await compactHistory({ conversationId: 'c', messages, contextWindow: 200_000, summarize: async () => { calls++; return 'S' } })
    expect(out).toEqual(messages)
    expect(calls).toBe(0)
  })

  it('over the threshold: one summary replaces everything before the last few turns', async () => {
    const messages = history(20)
    const window = Math.ceil(estimateHistoryTokens(messages) / 0.7) // ~70% full
    let seen = ''
    const out = await compactHistory({ conversationId: 'c', messages, contextWindow: window, summarize: async (t) => { seen = t; return 'THE SUMMARY' } })
    expect(out).toHaveLength(KEEP_RECENT_TURNS * 2)
    expect(textOf(out[0])).toContain('THE SUMMARY')
    expect(textOf(out[0])).toContain(`ask ${20 - KEEP_RECENT_TURNS}`)
    expect(seen).toContain('User: ask 0')
    expect(seen).not.toContain(`ask ${20 - KEEP_RECENT_TURNS} `)
    expect(estimateHistoryTokens(out)).toBeLessThan(estimateHistoryTokens(messages))
  })

  it('pins the summary: the next turn reuses it byte-for-byte without a second call', async () => {
    const messages = history(20)
    const window = Math.ceil(estimateHistoryTokens(messages) / 0.7)
    let calls = 0
    const summarize = async () => { calls++; return 'PINNED' }
    const first = await compactHistory({ conversationId: 'c', messages, contextWindow: window, summarize })
    const next = [...messages, ...history(1, 100)]
    const second = await compactHistory({ conversationId: 'c', messages: next, contextWindow: window, summarize })
    expect(calls).toBe(1)
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first))
  })

  it('a summariser that fails or returns nothing replays the history unchanged', async () => {
    const messages = history(20)
    const window = Math.ceil(estimateHistoryTokens(messages) / 0.7)
    expect(await compactHistory({ conversationId: 'c', messages, contextWindow: window, summarize: async () => null })).toEqual(messages)
    expect(await compactHistory({ conversationId: 'd', messages, contextWindow: window, summarize: async () => { throw new Error('boom') } })).toEqual(messages)
  })
})

describe('compactHistoryForTurn', () => {
  it('is a no-op without an Anthropic key: another provider\'s history comes back untouched', async () => {
    const messages = history(40)
    const out = await compactHistoryForTurn({
      db: {} as never,
      conversationId: 'c',
      modelId: 'gpt-5',
      credentials: { id: 'k', providerId: 'openai', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
      messages,
      toolContextBase: { db: {} as never, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null },
      signal: new AbortController().signal,
    })
    expect(out).toBe(messages)
  })

  it('names the utility model the audit assigns to compaction', () => {
    expect(COMPACTION_MODEL_ID).toBe('claude-haiku-4-5-20251001')
  })
})
