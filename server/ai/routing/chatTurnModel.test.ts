/**
 * A chat turn's model, end to end through the classifier, the table, the
 * conversation's model source and the key's live model list (AI-25) — and the
 * turn line the telemetry records for it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AiProvider, AiProviderModel, AiResolvedCredential } from '../drivers/types'
import { routeChatTurnModel } from './chatTurnModel'
import { createTurnTelemetry } from '../turnTelemetry'
import { readAgentTurnLog, readAgentTurnSummaries, summarizeTurnsByModel, appendAgentTurnLogEntry } from '../../handlers/studio/agentTurnLog'

let credentialSeq = 0

function fakeAnthropic(ids: readonly string[], counter: { calls: number }): { driver: AiProvider; credentials: AiResolvedCredential } {
  const models: AiProviderModel[] = ids.map((id) => ({
    id,
    label: id,
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: true, toolResultImages: true, promptCache: true, streaming: true },
  }))
  const driver = {
    id: 'anthropic',
    label: 'Anthropic',
    supportedAuthModes: ['apiKey'],
    capabilities: () => models[0]!.capabilities,
    listModels: async () => {
      counter.calls += 1
      return models
    },
    stream: () => { throw new Error('not used') },
  } as unknown as AiProvider
  credentialSeq += 1
  const credentials: AiResolvedCredential = { id: `cred-${credentialSeq}`, providerId: 'anthropic', authMode: 'apiKey', apiKey: `k-${credentialSeq}`, baseUrl: null }
  return { driver, credentials }
}

const signal = new AbortController().signal

describe('routeChatTurnModel', () => {
  it('moves a small edit on a default Opus conversation to Sonnet, and keeps a build on Opus', async () => {
    const counter = { calls: 0 }
    const { driver, credentials } = fakeAnthropic(['claude-opus-5-5', 'claude-sonnet-5'], counter)
    const base = { driver, credentials, conversation: { modelId: 'claude-opus-5-5', modelSource: 'default' as const }, attachmentCount: 0, workspaceDir: null, userId: 'u', fidelityMode: undefined, signal }
    expect(await routeChatTurnModel({ ...base, userText: 'rename the button to Continue' })).toMatchObject({ modelId: 'claude-sonnet-5', mode: 'routed', role: 'smallEdit' })
    expect(await routeChatTurnModel({ ...base, userText: 'build a checkout screen' })).toMatchObject({ modelId: 'claude-opus-5-5', role: 'build' })
    // The catalogue is asked once per credential, not once per turn.
    expect(counter.calls).toBe(1)
  })

  it('never routes a conversation whose model the user picked, and does not even ask the catalogue', async () => {
    const counter = { calls: 0 }
    const { driver, credentials } = fakeAnthropic(['claude-opus-5-5', 'claude-sonnet-5'], counter)
    const route = await routeChatTurnModel({ driver, credentials, conversation: { modelId: 'claude-opus-5-5', modelSource: 'chosen' }, userText: 'rename the button', attachmentCount: 0, workspaceDir: null, userId: 'u', fidelityMode: undefined, signal })
    expect(route).toMatchObject({ modelId: 'claude-opus-5-5', mode: 'pinned' })
    expect(counter.calls).toBe(0)
  })

  it('a build with no design to match is the creative role', async () => {
    const { driver, credentials } = fakeAnthropic(['claude-opus-5-5'], { calls: 0 })
    const route = await routeChatTurnModel({ driver, credentials, conversation: { modelId: 'claude-opus-5-5', modelSource: 'default' }, userText: 'design a landing page', attachmentCount: 0, workspaceDir: null, userId: 'u', fidelityMode: 'creative', signal })
    expect(route.role).toBe('creative')
  })
})

describe('turn telemetry', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-turn-telemetry-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records one turn line with the model it ran on, and the tool-line reader skips it', () => {
    let clock = 1_000
    const telemetry = createTurnTelemetry({
      dir,
      conversationId: 'c1',
      providerId: 'anthropic',
      conversationModelId: 'claude-opus-5-5',
      route: { modelId: 'claude-sonnet-5', mode: 'routed', role: 'smallEdit', reason: 'r' },
      now: () => clock,
    })
    telemetry.observe({ type: 'context', promptTokens: 10 })
    telemetry.observe({ type: 'toolResult', toolCallId: 't', toolName: 'studio_read_file', ok: true })
    telemetry.observe({ type: 'context', promptTokens: 20 })
    clock = 4_000
    telemetry.finish({ promptTokens: 300, completionTokens: 40, aborted: false })
    appendAgentTurnLogEntry(dir, { at: 1, conversationId: 'c1', tool: 'studio_read_file', ms: 5, bytesIn: 1, bytesOut: 1, ok: true, cacheHit: false, execution: 'server' })

    const summaries = readAgentTurnSummaries(dir)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ kind: 'turn', model: 'claude-sonnet-5', conversationModel: 'claude-opus-5-5', modelMode: 'routed', role: 'smallEdit', durationMs: 3_000, rounds: 2, toolCalls: 1, promptTokens: 300, completionTokens: 40, outcome: 'ok' })
    expect(readAgentTurnLog(dir).map((entry) => entry.tool)).toEqual(['studio_read_file'])
  })

  it('an error or an abort is the turn\'s outcome, and nothing is written with no project open', () => {
    const route = { modelId: 'claude-opus-5-5', mode: 'default' as const, role: 'build' as const, reason: 'r' }
    const failing = createTurnTelemetry({ dir, conversationId: 'c', providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', route })
    failing.observe({ type: 'error', message: 'boom' })
    failing.finish({ promptTokens: 1, completionTokens: 1, aborted: false })
    createTurnTelemetry({ dir, conversationId: 'c', providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', route }).finish({ promptTokens: 1, completionTokens: 1, aborted: true })
    createTurnTelemetry({ dir: null, conversationId: 'c', providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', route }).finish({ promptTokens: 1, completionTokens: 1, aborted: false })
    expect(readAgentTurnSummaries(dir).map((s) => s.outcome)).toEqual(['error', 'aborted'])
  })

  it('summarizes per (role, model), leaving aborted turns out of the error rate', () => {
    const line = (model: string, outcome: 'ok' | 'error' | 'aborted', durationMs: number) => ({
      kind: 'turn' as const, at: 0, conversationId: 'c', provider: 'anthropic', model, conversationModel: 'claude-opus-5-5', modelMode: 'routed' as const,
      role: 'smallEdit', durationMs, rounds: 1, toolCalls: 2, promptTokens: 100, completionTokens: 10, outcome,
    })
    const rows = summarizeTurnsByModel([line('claude-sonnet-5', 'ok', 10), line('claude-sonnet-5', 'error', 30), line('claude-sonnet-5', 'aborted', 20), line('claude-opus-5-5', 'ok', 50)])
    expect(rows).toEqual([
      { role: 'smallEdit', model: 'claude-sonnet-5', turns: 3, p50Ms: 20, p95Ms: 30, p50PromptTokens: 100, p50CompletionTokens: 10, p50ToolCalls: 2, errorRate: 0.5 },
      { role: 'smallEdit', model: 'claude-opus-5-5', turns: 1, p50Ms: 50, p95Ms: 50, p50PromptTokens: 100, p50CompletionTokens: 10, p50ToolCalls: 2, errorRate: 0 },
    ])
  })
})
