/**
 * Connectors derived from the user's real navigation code.
 *
 * The bar these tests hold: a derived link is presented as a FACT about the
 * source, so a wrong one is worse than a missing one.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, NodeTree } from '@core/page-tree'
import { codeLinkId, deriveCodeLinks, mergeCodeLinks, pageForDestination, type PrototypeLink } from '..'

function node(
  id: string,
  moduleId: string,
  children: string[] = [],
  extra: Record<string, unknown> = {},
): BaseNode {
  return { id, moduleId, props: {}, breakpointOverrides: {}, children, ...extra } as BaseNode
}

function tree(targets?: Record<string, string>): NodeTree {
  return {
    rootNodeId: 'root',
    nodes: {
      root: node('root', 'base.body', ['cta']),
      cta: node('cta', 'base.button', [], targets ? { codeNavigationTargets: targets } : {}),
    },
  }
}

const pages = [
  { id: 'p-welcome', slug: 'welcome' },
  { id: 'p-signin', slug: 'sign-in' },
]

describe('pageForDestination', () => {
  it('matches a route string to a page by slug, with or without the slash', () => {
    expect(pageForDestination(pages, '/sign-in')?.id).toBe('p-signin')
    expect(pageForDestination(pages, 'sign-in')?.id).toBe('p-signin')
    expect(pageForDestination(pages, '/sign-in/')?.id).toBe('p-signin')
  })

  it('falls back to the page id, since Studio ids and routes are two vocabularies', () => {
    expect(pageForDestination(pages, 'p-signin')?.id).toBe('p-signin')
  })

  it('is null for a route the project has but Studio has not imported', () => {
    expect(pageForDestination(pages, '/checkout')).toBeNull()
    expect(pageForDestination(pages, '  ')).toBeNull()
  })
})

describe('deriveCodeLinks', () => {
  it('turns a literal navigation into a read-only connector', () => {
    const links = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)
    expect(links).toHaveLength(1)
    expect(links[0]!.origin).toBe('code')
    expect(links[0]!.targetPageId).toBe('p-signin')
    expect(links[0]!.source.node.nodeId).toBe('cta')
  })

  it('gives a derived link a stable id, so it survives a re-parse still selected', () => {
    const a = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)[0]!
    const b = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)[0]!
    expect(a.id).toBe(b.id)
    expect(a.id).toBe(codeLinkId('p-welcome', 'cta', 'onClick'))
  })

  it('uses the neutral transition — the code says where, never how', () => {
    // Picking a slide would be Studio inventing a design decision and
    // attributing it to the user's source.
    expect(deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)[0]!.transition).toBe('instant')
  })

  it('draws nothing for a route no imported page matches', () => {
    expect(deriveCodeLinks('p-welcome', tree({ onClick: '/checkout' }), pages)).toEqual([])
  })

  it('draws nothing for a handler that navigates to its own screen', () => {
    expect(deriveCodeLinks('p-welcome', tree({ onClick: '/welcome' }), pages)).toEqual([])
  })

  it('draws nothing when no handler navigates anywhere', () => {
    expect(deriveCodeLinks('p-welcome', tree(), pages)).toEqual([])
  })

  it('derives one connector per navigating handler on a node', () => {
    const links = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in', onDoubleClick: 'p-signin' }), pages)
    expect(links).toHaveLength(2)
    expect(new Set(links.map((l) => l.id)).size).toBe(2)
  })
})

describe('mergeCodeLinks', () => {
  const authored: PrototypeLink = {
    id: 'drawn',
    origin: 'design',
    source: {
      pageId: 'p-welcome',
      node: { nodeId: 'cta', indexPath: [0], moduleId: 'base.button', textSnippet: '' },
    },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'p-signin',
    transition: 'slide-left',
  }

  it('lets an authored link on the same element win', () => {
    // The designer overrode what the code does. Showing both would draw two
    // connectors out of one button.
    const derived = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)
    const merged = mergeCodeLinks([authored], derived)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('design')
  })

  it('keeps a derived link on an element nobody drew from', () => {
    const derived = deriveCodeLinks('p-welcome', tree({ onClick: '/sign-in' }), pages)
    const elsewhere = { ...authored, source: { ...authored.source, node: { ...authored.source.node, nodeId: 'other' } } }
    expect(mergeCodeLinks([elsewhere], derived)).toHaveLength(2)
  })
})
