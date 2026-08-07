import { describe, expect, it, afterEach } from 'bun:test'
import { canComponentizeNode } from './componentizeEligibility'
import type { PageNode } from '@core/page-tree'

function makeNode(moduleId: string): PageNode {
  return { id: 'n1', moduleId, props: {}, children: [] } as unknown as PageNode
}

describe('canComponentizeNode', () => {
  const originalSearch = window.location.search

  afterEach(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${originalSearch}`)
    window.localStorage.removeItem('studio:studio')
  })

  it('refuses componentize for an eligible node while Studio mode is active (URL param)', () => {
    window.history.replaceState(null, '', `${window.location.pathname}?studio=1`)
    const node = makeNode('base.container')
    expect(canComponentizeNode(null, node)).toBe(false)
  })

  it('refuses componentize for an eligible node while Studio mode is active (sticky localStorage)', () => {
    window.history.replaceState(null, '', window.location.pathname)
    window.localStorage.setItem('studio:studio', '1')
    const node = makeNode('base.container')
    expect(canComponentizeNode(null, node)).toBe(false)
  })

  it('allows componentize for an eligible node outside Studio mode', () => {
    window.history.replaceState(null, '', `${window.location.pathname}?studio=0`)
    const node = makeNode('base.container')
    expect(canComponentizeNode(null, node)).toBe(true)
  })

  it('still refuses on base.body / base.visual-component-ref regardless of mode', () => {
    window.history.replaceState(null, '', `${window.location.pathname}?studio=0`)
    expect(canComponentizeNode(null, makeNode('base.body'))).toBe(false)
    expect(canComponentizeNode(null, makeNode('base.visual-component-ref'))).toBe(false)
  })

  it('still refuses for a visualComponent active document outside Studio mode', () => {
    window.history.replaceState(null, '', `${window.location.pathname}?studio=0`)
    const node = makeNode('base.container')
    expect(
      canComponentizeNode({ kind: 'visualComponent' } as never, node),
    ).toBe(false)
  })
})
