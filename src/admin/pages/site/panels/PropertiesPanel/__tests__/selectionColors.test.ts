/**
 * Selection colours — the aggregate, and the one-undo-step recolour
 * (W8-3 phase 3 / G6.4).
 *
 * Two things are pinned here. First, that the same colour arriving on
 * DIFFERENT properties of different layers is ONE swatch — that is the whole
 * feature; a per-property list already exists. Second, that recolouring
 * produces one patch per node (not one per occurrence), because
 * `setNodesInlineStylesPerNode` writes each node once and a second patch for
 * the same node would silently lose the first.
 */
import { describe, expect, it } from 'bun:test'
import {
  collectSelectionColors,
  describeColorUsage,
  recolorPatches,
} from '../selectionColors'

describe('collectSelectionColors', () => {
  it('buckets one colour across different properties and layers', () => {
    const colors = collectSelectionColors([
      { id: 'a', inlineStyles: { color: '#111111', backgroundColor: '#ffffff' } },
      { id: 'b', inlineStyles: { borderTopColor: '#111111' } },
    ])

    expect(colors.map((c) => c.value)).toEqual(['#111111', '#ffffff'])
    expect(colors[0].occurrences).toEqual([
      { nodeId: 'a', property: 'color' },
      { nodeId: 'b', property: 'borderTopColor' },
    ])
    expect(describeColorUsage(colors[0])).toBe('2 uses')
    expect(describeColorUsage(colors[1])).toBe('1 use')
  })

  it('matches on authored text, case-insensitively, keeping the first spelling', () => {
    const colors = collectSelectionColors([
      { id: 'a', inlineStyles: { color: '#FFF' } },
      { id: 'b', inlineStyles: { color: '#fff' } },
    ])
    expect(colors).toHaveLength(1)
    expect(colors[0].value).toBe('#FFF')
  })

  it('keeps distinct spellings of the same rendered colour apart', () => {
    // Bucketing these together would mean rewriting text the user never asked
    // us to touch — see the module doc.
    const colors = collectSelectionColors([
      { id: 'a', inlineStyles: { color: '#ffffff' } },
      { id: 'b', inlineStyles: { color: 'rgb(255, 255, 255)' } },
    ])
    expect(colors).toHaveLength(2)
  })

  it('skips keywords that name no colour of their own', () => {
    const colors = collectSelectionColors([
      { id: 'a', inlineStyles: { color: 'inherit', backgroundColor: 'currentColor', fill: 'none' } },
    ])
    expect(colors).toEqual([])
  })

  it('ignores nodes with no inline styles', () => {
    expect(collectSelectionColors([{ id: 'a' }, { id: 'b', inlineStyles: {} }])).toEqual([])
  })
})

describe('recolorPatches', () => {
  it('emits ONE patch per node, carrying every property that held the colour', () => {
    const [color] = collectSelectionColors([
      { id: 'a', inlineStyles: { color: '#111', borderTopColor: '#111' } },
      { id: 'b', inlineStyles: { color: '#111' } },
    ])

    expect(recolorPatches(color, '#222')).toEqual([
      { nodeId: 'a', patch: { color: '#222', borderTopColor: '#222' } },
      { nodeId: 'b', patch: { color: '#222' } },
    ])
  })
})
