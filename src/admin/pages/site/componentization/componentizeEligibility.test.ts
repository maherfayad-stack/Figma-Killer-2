import { describe, expect, it } from 'bun:test'
import { canComponentizeNode } from './componentizeEligibility'
import type { PageNode } from '@core/page-tree'

function makeNode(moduleId: string): PageNode {
  return { id: 'n1', moduleId, props: {}, children: [] } as unknown as PageNode
}

describe('canComponentizeNode', () => {
  it('always refuses — Studio has no persistence path for Componentize', () => {
    const node = makeNode('base.container')
    expect(canComponentizeNode(null, node)).toBe(false)
  })

  it('refuses on base.body / base.visual-component-ref too', () => {
    expect(canComponentizeNode(null, makeNode('base.body'))).toBe(false)
    expect(canComponentizeNode(null, makeNode('base.visual-component-ref'))).toBe(false)
  })

  it('refuses for a visualComponent active document', () => {
    const node = makeNode('base.container')
    expect(
      canComponentizeNode({ kind: 'visualComponent' } as never, node),
    ).toBe(false)
  })
})
