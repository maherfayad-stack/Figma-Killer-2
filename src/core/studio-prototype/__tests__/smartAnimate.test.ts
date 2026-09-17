/**
 * Which element on one screen is which element on the next.
 *
 * Node ids are `relFile:line:col`, so two screens share none — matching is the
 * `NodeHint` re-resolution `.studio/prototype.json` anchors already depend on,
 * and this is where its three answers are pinned down for a transition.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, NodeTree } from '@core/page-tree'
import { MAX_SMART_ANIMATE_PAIRS, matchScreenNodes } from '..'

function node(
  id: string,
  moduleId: string,
  children: string[] = [],
  props: Record<string, unknown> = {},
): BaseNode {
  return { id, moduleId, props, breakpointOverrides: {}, children }
}

/** A screen: a body with a header and a body element under it. */
function screen(file: string, headerText: string, bodyModule = 'base.text'): NodeTree {
  return {
    rootNodeId: `${file}:1:1`,
    nodes: {
      [`${file}:1:1`]: node(`${file}:1:1`, 'base.body', [`${file}:2:1`, `${file}:5:1`]),
      [`${file}:2:1`]: node(`${file}:2:1`, 'base.container', [`${file}:3:1`]),
      [`${file}:3:1`]: node(`${file}:3:1`, 'base.text', [], { text: headerText }),
      [`${file}:5:1`]: node(`${file}:5:1`, bodyModule, [], { text: 'Body' }),
    },
  }
}

describe('matching two screens', () => {
  it('pairs the shared header even though the two screens share no node id', () => {
    const from = screen('Home.tsx', 'Almosafer')
    const to = screen('Details.tsx', 'Almosafer')
    const { matched } = matchScreenNodes(from, to)

    expect(matched).toEqual([
      { fromNodeId: 'Home.tsx:2:1', toNodeId: 'Details.tsx:2:1' },
      { fromNodeId: 'Home.tsx:5:1', toNodeId: 'Details.tsx:5:1' },
      { fromNodeId: 'Home.tsx:3:1', toNodeId: 'Details.tsx:3:1' },
    ])
  })

  it('pairs a title whose WORDS changed — that is the case worth animating', () => {
    // `drifted`: same address, same module, different text. A cross-fade there
    // is exactly the thing smart animate exists not to do.
    const { matched } = matchScreenNodes(screen('Home.tsx', 'Search'), screen('Details.tsx', 'Results'))
    expect(matched.some((pair) => pair.fromNodeId === 'Home.tsx:3:1')).toBe(true)
  })

  it('refuses a pair whose module changed — a different kind of node is a different node', () => {
    const from = screen('Home.tsx', 'Almosafer')
    const to = screen('Details.tsx', 'Almosafer', 'base.image')
    const { matched, leaving, entering } = matchScreenNodes(from, to)

    expect(matched.map((pair) => pair.fromNodeId)).not.toContain('Home.tsx:5:1')
    expect(leaving).toContain('Home.tsx:5:1')
    expect(entering).toContain('Details.tsx:5:1')
  })

  it('never pairs the root — it is the screen, not an element on it', () => {
    const { matched } = matchScreenNodes(screen('Home.tsx', 'A'), screen('Details.tsx', 'A'))
    expect(matched.some((pair) => pair.toNodeId === 'Details.tsx:1:1')).toBe(false)
  })

  it('is one-to-one: an incoming node claimed by a shallower pair is not offered twice', () => {
    // Two outgoing containers, one incoming one. The second cannot animate into
    // a box something else is already becoming.
    const from: NodeTree = {
      rootNodeId: 'r',
      nodes: {
        r: node('r', 'base.body', ['a', 'b']),
        a: node('a', 'base.container'),
        b: node('b', 'base.container'),
      },
    }
    const to: NodeTree = {
      rootNodeId: 'R',
      nodes: { R: node('R', 'base.body', ['A']), A: node('A', 'base.container') },
    }

    const { matched, leaving } = matchScreenNodes(from, to)
    expect(matched).toEqual([{ fromNodeId: 'a', toNodeId: 'A' }])
    expect(leaving).toEqual(['b'])
  })

  it('caps the pairs it animates, keeping the OUTERMOST ones', () => {
    // A screen is routinely hundreds of nodes and the FLIP measures both sides
    // of every pair. Breadth-first means the cap keeps the big visible boxes.
    const wide = (prefix: string): NodeTree => {
      const children = Array.from({ length: 40 }, (_, i) => `${prefix}${i}`)
      const nodes: Record<string, BaseNode> = {
        [`${prefix}root`]: node(`${prefix}root`, 'base.body', children),
      }
      for (const id of children) nodes[id] = node(id, 'base.container')
      return { rootNodeId: `${prefix}root`, nodes }
    }

    const { matched, leaving } = matchScreenNodes(wide('a'), wide('b'))
    expect(matched).toHaveLength(MAX_SMART_ANIMATE_PAIRS)
    expect(matched[0]).toEqual({ fromNodeId: 'a0', toNodeId: 'b0' })
    // Past the cap a pair is still a MATCH — it is simply not animated. Calling
    // it `leaving` would say an element vanished when it is standing right
    // there on the new screen.
    expect(leaving).toEqual([])
  })

  it('reports the remainder of both screens, which is what dissolves', () => {
    const from: NodeTree = {
      rootNodeId: 'r',
      nodes: { r: node('r', 'base.body', ['only']), only: node('only', 'base.button') },
    }
    const to: NodeTree = {
      rootNodeId: 'R',
      nodes: { R: node('R', 'base.body', ['fresh']), fresh: node('fresh', 'base.image') },
    }

    expect(matchScreenNodes(from, to)).toEqual({
      matched: [],
      leaving: ['only'],
      entering: ['fresh'],
    })
  })
})
