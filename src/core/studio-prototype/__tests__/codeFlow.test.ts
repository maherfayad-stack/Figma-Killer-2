import { describe, expect, it } from 'bun:test'
import {
  codeFlowEdgeId,
  createCodeFlow,
  groupCodeFlowByPagePair,
  parseCodeFlow,
  type CodeFlowEdge,
} from '../codeFlow'

function edge(overrides: Partial<CodeFlowEdge> = {}): CodeFlowEdge {
  const base = {
    sourcePageId: 'home',
    sourceNodeId: 'pages/Home.tsx:12:6',
    targetPageId: 'details',
    via: 'href' as const,
    evidence: 'href="/details"',
    ...overrides,
  }
  return { id: overrides.id ?? codeFlowEdgeId(base), ...base }
}

describe('edge identity', () => {
  it('is content-addressed, so an unchanged file re-derives the same ids', () => {
    expect(edge().id).toBe(edge().id)
  })

  it('separates two facts about the same element that were read differently', () => {
    expect(edge({ via: 'call', evidence: "navigate('/details')" }).id).not.toBe(edge().id)
  })

  it('separates two destinations from the same element', () => {
    expect(edge({ targetPageId: 'settings' }).id).not.toBe(edge().id)
  })
})

describe('grouping by page pair', () => {
  it('collapses every edge between one pair into a single connector', () => {
    const pairs = groupCodeFlowByPagePair([
      edge(),
      edge({ sourceNodeId: 'pages/Home.tsx:40:8' }),
      edge({ targetPageId: 'settings' }),
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs[0]!.edges).toHaveLength(2)
    expect(pairs[1]!.targetPageId).toBe('settings')
  })

  it('keeps a self-edge, which is a real fact with no two-frame geometry', () => {
    const pairs = groupCodeFlowByPagePair([edge({ targetPageId: 'home' })])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.sourcePageId).toBe(pairs[0]!.targetPageId)
  })

  it('preserves first-seen order, so connectors do not reshuffle between loads', () => {
    const pairs = groupCodeFlowByPagePair([edge({ targetPageId: 'settings' }), edge()])
    expect(pairs.map((p) => p.targetPageId)).toEqual(['settings', 'details'])
  })
})

describe('tolerant read of the wire payload', () => {
  it('opens a missing or malformed payload as an empty flow', () => {
    expect(parseCodeFlow(null)).toEqual(createCodeFlow())
    expect(parseCodeFlow({})).toEqual(createCodeFlow())
    expect(parseCodeFlow({ edges: 'nope' })).toEqual(createCodeFlow())
  })

  it('drops an edge missing either end, and keeps its healthy siblings', () => {
    const flow = parseCodeFlow({
      edges: [edge(), { ...edge(), targetPageId: '' }, { ...edge(), sourceNodeId: '' }, { ...edge(), via: 'psychic' }],
    })
    expect(flow.edges).toHaveLength(1)
  })

  it('recomputes an id the payload did not carry', () => {
    const { id: _dropped, ...withoutId } = edge()
    expect(parseCodeFlow({ edges: [withoutId] }).edges[0]!.id).toBe(edge().id)
  })
})
