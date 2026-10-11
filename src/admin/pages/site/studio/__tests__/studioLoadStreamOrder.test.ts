/**
 * P6-B — `/load?stream=1` emits page lines in VIEWPORT order (the frames a
 * person sees first, first), each carrying its `index` in the project's page
 * order. A client places pages by `index`, so the site's page order — the
 * Pages panel's order — never depends on the order the lines arrived in.
 */
import { describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { orderStreamedPages } from '../studioLoadStreamSchema'

function stubPage(id: string): Page {
  return { nodes: {}, rootNodeId: 'root', id, slug: id, title: id } as Page
}

describe('orderStreamedPages', () => {
  it('restores page order from lines that arrived in viewport order', () => {
    const lines = [
      { kind: 'page' as const, page: stubPage('d'), index: 3 },
      { kind: 'page' as const, page: stubPage('b'), index: 1 },
      { kind: 'page' as const, page: stubPage('c'), index: 2 },
      { kind: 'page' as const, page: stubPage('a'), index: 0 },
    ]
    expect(orderStreamedPages(lines).map((page) => page.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves lines that already arrived in page order as they are', () => {
    const lines = ['x', 'y'].map((id, index) => ({ kind: 'page' as const, page: stubPage(id), index }))
    expect(orderStreamedPages(lines).map((page) => page.id)).toEqual(['x', 'y'])
  })
})
