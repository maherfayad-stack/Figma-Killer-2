import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENT_TURN_BUDGETS,
  AGENT_TURN_LOG_FILE,
  appendAgentTurnLogEntry,
  gradeTurnAgainstBudget,
  readAgentTurnLog,
  summarizeToolLatency,
  type AgentTurnLogEntry,
} from './agentTurnLog'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-turn-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<AgentTurnLogEntry> = {}): AgentTurnLogEntry {
  return {
    at: 1_000,
    conversationId: 'conv-1',
    tool: 'studio_compare',
    ms: 100,
    bytesIn: 40,
    bytesOut: 900,
    ok: true,
    cacheHit: false,
    execution: 'server',
    sideEffects: 'none',
    ...overrides,
  }
}

describe('appendAgentTurnLogEntry / readAgentTurnLog', () => {
  it('round-trips entries in order, creating .studio/ if needed', () => {
    appendAgentTurnLogEntry(dir, entry({ tool: 'studio_screenshot' }))
    appendAgentTurnLogEntry(dir, entry({ tool: 'studio_compare' }))
    expect(readAgentTurnLog(dir).map((e) => e.tool)).toEqual(['studio_screenshot', 'studio_compare'])
  })

  it('returns an empty log for a project that has never run a turn', () => {
    expect(readAgentTurnLog(dir)).toEqual([])
  })

  it('skips a malformed or half-written trailing line rather than failing the read', () => {
    appendAgentTurnLogEntry(dir, entry())
    const file = join(dir, '.studio', AGENT_TURN_LOG_FILE)
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"tool":"studio_`)
    expect(readAgentTurnLog(dir)).toHaveLength(1)
  })

  it('skips a line that parses but does not match the schema', () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', AGENT_TURN_LOG_FILE), '{"tool":"x"}\n')
    expect(readAgentTurnLog(dir)).toEqual([])
  })

  it('never throws on an unwritable directory — a telemetry failure is not a failed tool call', () => {
    expect(() => appendAgentTurnLogEntry(join(dir, 'a\0b'), entry())).not.toThrow()
  })

  it('carries the fidelity mode and design policy when the call came from a turn', () => {
    appendAgentTurnLogEntry(dir, entry({ fidelityMode: 'creative', designPolicy: 'free' }))
    const [read] = readAgentTurnLog(dir)
    expect(read!.fidelityMode).toBe('creative')
    expect(read!.designPolicy).toBe('free')
  })
})

describe('summarizeToolLatency', () => {
  it('reports p50/p95/max per tool, slowest total first', () => {
    for (const ms of [10, 20, 30, 40, 1000]) appendAgentTurnLogEntry(dir, entry({ tool: 'studio_compare', ms }))
    for (const ms of [5, 5]) appendAgentTurnLogEntry(dir, entry({ tool: 'studio_read_file', ms }))

    const [first, second] = summarizeToolLatency(readAgentTurnLog(dir))
    expect(first!.tool).toBe('studio_compare')
    expect(first!.count).toBe(5)
    expect(first!.p50Ms).toBe(30)
    expect(first!.p95Ms).toBe(1000)
    expect(first!.maxMs).toBe(1000)
    expect(second!.tool).toBe('studio_read_file')
  })

  it('reports the cache-hit rate per tool', () => {
    appendAgentTurnLogEntry(dir, entry({ cacheHit: true }))
    appendAgentTurnLogEntry(dir, entry({ cacheHit: true }))
    appendAgentTurnLogEntry(dir, entry({ cacheHit: false }))
    expect(summarizeToolLatency(readAgentTurnLog(dir))[0]!.cacheHitRate).toBeCloseTo(2 / 3, 5)
  })

  it('is empty for an empty log', () => {
    expect(summarizeToolLatency([])).toEqual([])
  })
})

describe('gradeTurnAgainstBudget', () => {
  it('sums the turn’s tool time and names the worst tool when it overruns', () => {
    const entries = [
      entry({ tool: 'studio_compare', ms: 80_000 }),
      entry({ tool: 'studio_screenshot', ms: 20_000 }),
    ]
    const verdict = gradeTurnAgainstBudget(entries, AGENT_TURN_BUDGETS.creativeNoReferenceMs)
    expect(verdict.observedMs).toBe(100_000)
    expect(verdict.withinBudget).toBe(false)
    expect(verdict.worstTool).toBe('studio_compare')
  })

  it('passes a turn inside its budget', () => {
    const verdict = gradeTurnAgainstBudget([entry({ ms: 1_000 })], AGENT_TURN_BUDGETS.balancedWithReferenceMs)
    expect(verdict.withinBudget).toBe(true)
  })

  it('states the two budgets A9 named', () => {
    expect(AGENT_TURN_BUDGETS.balancedWithReferenceMs).toBe(180_000)
    expect(AGENT_TURN_BUDGETS.creativeNoReferenceMs).toBe(90_000)
  })
})
