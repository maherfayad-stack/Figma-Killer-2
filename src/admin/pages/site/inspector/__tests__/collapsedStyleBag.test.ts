import { describe, expect, it } from 'bun:test'
import { buildCollapsedCurrentStyles, buildCollapsedStoredStyles, buildContextOnlyClassChain } from '../collapsedStyleBag'
import type { StyleRule } from '@core/page-tree'

function classRule(id: string, selector: string, styles: Record<string, unknown>): StyleRule {
  return {
    id,
    kind: 'class',
    name: selector.replace('.', ''),
    selector,
    styles,
    contextStyles: {},
  } as unknown as StyleRule
}

describe('buildContextOnlyClassChain', () => {
  it('uses the base bag when no context is active', () => {
    const chain = buildContextOnlyClassChain([classRule('c1', '.card', { color: 'red' })], null)
    expect(chain).toEqual([{ classId: 'c1', selector: '.card', styles: { color: 'red' } }])
  })
})

describe('buildCollapsedStoredStyles', () => {
  it('attributes a single class source as the winner', () => {
    const chain = buildContextOnlyClassChain([classRule('c1', '.card', { width: '10px' })], null)
    const { storedStyles } = buildCollapsedStoredStyles(['width'], chain, {})
    expect(storedStyles.width).toBe('10px')
  })

  it('inline always wins over a class for stored purposes', () => {
    const chain = buildContextOnlyClassChain([classRule('c1', '.card', { width: '10px' })], null)
    const { storedStyles } = buildCollapsedStoredStyles(['width'], chain, { width: '20px' })
    expect(storedStyles.width).toBe('20px')
  })

  it('an ambiguous multi-class property is unset, not guessed', () => {
    const chain = buildContextOnlyClassChain(
      [classRule('c1', '.card', { width: '10px' }), classRule('c2', '.primary', { width: '20px' })],
      null,
    )
    const { storedStyles } = buildCollapsedStoredStyles(['width'], chain, {})
    expect(storedStyles.width).toBeUndefined()
  })

  it('custom (non-curated) properties fall back to a naive merge', () => {
    const chain = buildContextOnlyClassChain([classRule('c1', '.card', { '--x': '1' })], null)
    const { storedStyles } = buildCollapsedStoredStyles([], chain, {})
    expect(storedStyles['--x']).toBe('1')
  })
})

describe('buildCollapsedCurrentStyles', () => {
  it('falls back through computed -> effective class chain -> stored', () => {
    const effective = buildContextOnlyClassChain([classRule('c1', '.card', { width: '10px' })], null)
    const current = buildCollapsedCurrentStyles({ width: '5px', height: '1px' }, effective, {}, { width: '10px' })
    expect(current.width).toBe('10px')
    expect(current.height).toBe('1px')
  })
})
