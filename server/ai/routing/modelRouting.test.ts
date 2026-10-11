import { describe, expect, it } from 'bun:test'
import { MODEL_BENCH_CANDIDATES, MODEL_ROUTING_TABLE, modelTier, roleForTurn, routeModel, type RouteModelInput } from './modelRouting'
import { COMPACTION_MODEL_ID } from '../conversations/compaction'

const ALL = new Set(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'])

function input(overrides: Partial<RouteModelInput>): RouteModelInput {
  return {
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    modelSource: 'default',
    role: 'smallEdit',
    availableModelIds: ALL,
    ...overrides,
  }
}

describe('the routing table (AI-25)', () => {
  it('assigns exactly the owner\'s ids', () => {
    expect(MODEL_ROUTING_TABLE).toEqual({
      build: 'claude-opus-5-5',
      creative: 'claude-opus-5-5',
      smallEdit: 'claude-sonnet-5',
      question: 'claude-sonnet-5',
      subagent: 'claude-sonnet-5',
      utility: 'claude-haiku-4-5-20251001',
    })
  })

  it('compaction reads its model from the table — one table, not two', () => {
    expect(COMPACTION_MODEL_ID).toBe(MODEL_ROUTING_TABLE.utility)
  })

  it('claude-fable-5-1 is a bench candidate and holds no role until it is measured', () => {
    expect(MODEL_BENCH_CANDIDATES).toContain('claude-fable-5-1')
    expect(Object.values(MODEL_ROUTING_TABLE)).not.toContain('claude-fable-5-1')
    for (const id of Object.values(MODEL_ROUTING_TABLE)) expect(MODEL_BENCH_CANDIDATES).toContain(id)
  })
})

describe('routeModel', () => {
  it('routes a small edit on the default Opus to Sonnet', () => {
    expect(routeModel(input({}))).toMatchObject({ modelId: 'claude-sonnet-5', mode: 'routed', role: 'smallEdit' })
  })

  it('keeps a build turn on Opus', () => {
    expect(routeModel(input({ role: 'build' }))).toMatchObject({ modelId: 'claude-opus-5-5', mode: 'default' })
  })

  it('never overrides a model the user picked', () => {
    expect(routeModel(input({ modelSource: 'chosen' }))).toMatchObject({ modelId: 'claude-opus-5-5', mode: 'pinned' })
  })

  it('never routes UP: a Sonnet default keeps build turns on Sonnet', () => {
    expect(routeModel(input({ modelId: 'claude-sonnet-5', role: 'build' }))).toMatchObject({ modelId: 'claude-sonnet-5', mode: 'default' })
  })

  it('does not route away from a model whose tier it does not know', () => {
    expect(routeModel(input({ modelId: 'claude-fable-5-1' }))).toMatchObject({ modelId: 'claude-fable-5-1', mode: 'default' })
  })

  it('keeps the conversation model when the target is not in the key\'s list, or the list is unknown', () => {
    expect(routeModel(input({ availableModelIds: new Set(['claude-opus-5-5']) }))).toMatchObject({ modelId: 'claude-opus-5-5', mode: 'default' })
    expect(routeModel(input({ availableModelIds: null }))).toMatchObject({ modelId: 'claude-opus-5-5', mode: 'default' })
  })

  it('does not route the claude CLI or a non-Anthropic provider', () => {
    for (const providerId of ['claudeCli', 'openai', 'openrouter'] as const) {
      expect(routeModel(input({ providerId })).mode).toBe('default')
    }
  })

  it('every answer carries a reason', () => {
    for (const role of ['build', 'creative', 'smallEdit', 'question', 'subagent', 'utility'] as const) {
      expect(routeModel(input({ role })).reason.length).toBeGreaterThan(0)
    }
  })
})

describe('roleForTurn and modelTier', () => {
  it('a build with no design to match is creative', () => {
    expect(roleForTurn('build', 'creative')).toBe('creative')
    expect(roleForTurn('build', 'balanced')).toBe('build')
    expect(roleForTurn('question', undefined)).toBe('question')
  })

  it('reads the family off the id', () => {
    expect(modelTier('claude-opus-5-5')).toBe(3)
    expect(modelTier('claude-sonnet-5')).toBe(2)
    expect(modelTier('claude-haiku-4-5-20251001')).toBe(1)
    expect(modelTier('gpt-5')).toBeNull()
  })
})
