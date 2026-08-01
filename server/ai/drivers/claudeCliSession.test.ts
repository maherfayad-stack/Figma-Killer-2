/**
 * claudeCliSession.ts — deterministic session-id derivation and the
 * first-turn/continuing-turn heuristic (WS-11 step 2).
 */
import { describe, expect, it } from 'bun:test'
import { claudeCliSessionId, isFirstClaudeCliTurn } from './claudeCliSession'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('claudeCliSessionId', () => {
  it('produces a well-formed UUID string (the shape --session-id validates)', async () => {
    const id = await claudeCliSessionId('conv-1')
    expect(id).toMatch(UUID_RE)
  })

  it('is deterministic — the same conversationId always yields the same UUID', async () => {
    const a = await claudeCliSessionId('conv-abc123')
    const b = await claudeCliSessionId('conv-abc123')
    expect(a).toBe(b)
  })

  it('yields different UUIDs for different conversation ids', async () => {
    const a = await claudeCliSessionId('conv-a')
    const b = await claudeCliSessionId('conv-b')
    expect(a).not.toBe(b)
  })
})

describe('isFirstClaudeCliTurn', () => {
  it('is true for exactly one message (a brand-new conversation\'s first send)', () => {
    expect(isFirstClaudeCliTurn(1)).toBe(true)
  })

  it('is true for zero messages (defensive)', () => {
    expect(isFirstClaudeCliTurn(0)).toBe(true)
  })

  it('is false once history has accumulated', () => {
    expect(isFirstClaudeCliTurn(2)).toBe(false)
    expect(isFirstClaudeCliTurn(10)).toBe(false)
  })
})
