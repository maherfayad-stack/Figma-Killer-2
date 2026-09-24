/**
 * AI-18 — heavy evidence is superseded per (tool, what it is about), not per
 * tool: a screenshot of page A is still the latest picture of A after the
 * agent takes one of page B.
 */
import { describe, expect, it } from 'bun:test'
import { heavyResultScope, projectHeavyElision } from './heavyElision'
import type { TurnToolResult } from './toolLoopTypes'

const image = { mimeType: 'image/png', data: 'AAAA' }

function shot(id: string, pages: string[]): TurnToolResult {
  return { id, name: 'studio_screenshot', output: { ok: true, data: { pages }, images: [image] }, scope: heavyResultScope({ pages }) }
}

/** A stand-in adapter: a tool-result "message" is just its results. */
const adapter = { buildToolResultMessage: (results: TurnToolResult[]) => results }

describe('projectHeavyElision', () => {
  it('keeps the latest capture of EACH page, and elides only a capture of the same page taken again', () => {
    const history: TurnToolResult[][] = [[shot('a1', ['Home'])], [shot('b1', ['Checkout'])], [shot('a2', ['Home'])]]
    const projected = projectHeavyElision(history, history.map((results, index) => ({ index, results })), adapter)
    const elided = (index: number) => (projected[index]![0]!.output.data as { elided?: boolean }).elided === true
    expect(elided(0)).toBe(true) // Home, superseded by a2
    expect(elided(1)).toBe(false) // Checkout: still the only picture of Checkout
    expect(elided(2)).toBe(false)
  })

  it('reads the scope off the pages list (order-free), else pageId / page / path / nodeId', () => {
    expect(heavyResultScope({ pages: ['B', 'A'] })).toBe(heavyResultScope({ pages: ['A', 'B'] }))
    expect(heavyResultScope({ path: 'pages/Home.tsx' })).toBe('pages/Home.tsx')
    expect(heavyResultScope({})).toBe('')
  })
})
