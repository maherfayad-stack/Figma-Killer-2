/**
 * AI-28 / AI-26 — how a turn reads: a failure the agent recovered from is not
 * an error; a long write says which file and how far; variants line up with
 * their screenshots.
 */
import { describe, expect, it } from 'bun:test'
import type { AgentMessage, AgentToolCall } from '@site/agent'
import {
  formatBytes,
  inputProgressHeadline,
  toolCallRecoveries,
  variantTiles,
} from '@site/panels/AgentPanel/turnPresentation'
import { summarizeAgentActivity } from '@site/panels/AgentPanel/activitySummary'

function call(id: string, actionType: string, status: AgentToolCall['status'], params: Record<string, unknown> = {}, previewImages?: string[]): AgentToolCall {
  return { id, actionType, status, params, result: status === 'error' ? { ok: false, error: 'refused' } : null, ...(previewImages ? { previewImages } : {}) }
}

function turn(calls: AgentToolCall[]): AgentMessage[] {
  return [{ id: 'a', role: 'assistant', timestamp: 0, blocks: calls.map((toolCall) => ({ kind: 'toolCall' as const, toolCall })) }]
}

describe('toolCallRecoveries', () => {
  it('a failure followed by a success of the same tool is recovered (muted), not an error', () => {
    const messages = turn([call('1', 'studio_write_file', 'error'), call('2', 'studio_write_file', 'success')])
    expect(toolCallRecoveries(messages, false).get('1')).toBe('recovered')
  })

  it('while the turn runs, an unrecovered failure is still "working" (muted); once it ends, it is an error', () => {
    const messages = turn([call('1', 'studio_edit_file', 'error'), call('2', 'studio_screenshot', 'success')])
    expect(toolCallRecoveries(messages, true).get('1')).toBe('working')
    expect(toolCallRecoveries(messages, false).has('1')).toBe(false)
  })
})

describe('argument progress (AI-26)', () => {
  it('names the file once it is known, the tool before that', () => {
    expect(inputProgressHeadline({ toolCallId: 't', toolName: 'Write', bytes: 3277, target: '/p/pages/Checkout.tsx' })).toBe('Writing Checkout.tsx · 3.2 KB')
    expect(inputProgressHeadline({ toolCallId: 't', toolName: 'studio_write_file', bytes: 512 })).toMatch(/^Preparing .+ · 512 B$/)
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('the activity headline shows it while arguments stream', () => {
    const message: AgentMessage = {
      id: 'a',
      role: 'assistant',
      timestamp: 0,
      blocks: [],
      inputProgress: { toolCallId: 't', toolName: 'Write', bytes: 1024, target: 'Home.tsx' },
    }
    expect(summarizeAgentActivity(message).headline).toBe('Writing Home.tsx · 1.0 KB')
  })
})

describe('variantTiles', () => {
  it('pairs each planned page with the newest screenshot of it, and says when none was taken', () => {
    const messages = turn([
      call('p', 'studio_plan_variants', 'success', { baseName: 'Home', count: 3 }),
      call('s1', 'studio_screenshot', 'success', { pages: ['HomeA'] }, ['data:image/png;base64,A1']),
      call('s2', 'studio_screenshot', 'success', { pages: ['HomeA', 'HomeB'] }, ['data:image/png;base64,A2', 'data:image/png;base64,B']),
      // Three pages, one image: not attributable, so it attributes nothing.
      call('s3', 'studio_screenshot', 'success', { pages: ['HomeA', 'HomeB', 'HomeC'] }, ['data:image/png;base64,X']),
    ])
    expect(variantTiles(messages)).toEqual([
      { pageName: 'HomeA', letter: 'A', image: 'data:image/png;base64,A2' },
      { pageName: 'HomeB', letter: 'B', image: 'data:image/png;base64,B' },
      { pageName: 'HomeC', letter: 'C', image: null },
    ])
  })

  it('is empty for a turn that planned no variants', () => {
    expect(variantTiles(turn([call('s', 'studio_screenshot', 'success', { pages: ['Home'] }, ['x'])]))).toEqual([])
  })
})
