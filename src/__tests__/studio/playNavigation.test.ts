/**
 * The editor-side half of playback: turning a clicked node into the link the
 * player should follow.
 *
 * The stack machine itself is tested in `@core/studio-prototype`'s
 * `playback.test.ts`; what is asserted here is the two things this layer
 * supplies — the ancestor chain's direction, and which links are resolvable
 * at all.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, Page } from '@core/page-tree'
import { captureNodeHint } from '@core/studio-anchor'
import type { PrototypeLink } from '@core/studio-prototype'
import { ancestorChain, resolveSourceIds } from '@site/studio/playNavigation'

function node(id: string, moduleId: string, children: string[] = [], props: Record<string, unknown> = {}): BaseNode {
  return { id, moduleId, props, breakpointOverrides: {}, children }
}

/** root > card > button > label */
function page(id = 'welcome'): Page {
  return {
    id,
    title: 'Welcome',
    slug: id,
    rootNodeId: 'root',
    nodes: {
      root: node('root', 'base.body', ['card']),
      card: node('card', 'base.container', ['button']),
      button: node('button', 'base.button', ['label']),
      label: node('label', 'base.text', [], { text: 'Continue' }),
    },
  } as unknown as Page
}

function link(overrides: Partial<PrototypeLink> = {}): PrototypeLink {
  return {
    id: 'link-1',
    origin: 'design',
    source: { pageId: 'welcome', node: captureNodeHint(page(), 'button')! },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'sign-in',
    transition: 'slide-left',
    ...overrides,
  }
}

describe('ancestorChain', () => {
  it('runs innermost first, starting with the clicked node itself', () => {
    // The direction is load-bearing: innermost has to win so a linked button
    // inside a linked card follows the button.
    expect(ancestorChain(page(), 'label')).toEqual(['label', 'button', 'card', 'root'])
  })

  it('is just the node for the root', () => {
    expect(ancestorChain(page(), 'root')).toEqual(['root'])
  })
})

describe('resolveSourceIds', () => {
  it('maps a link to the element its hint still points at', () => {
    expect(resolveSourceIds([link()], [page()]).get('link-1')).toBe('button')
  })

  it('OMITS a link whose element is gone, rather than mapping a stale id', () => {
    // Absence is what makes the player refuse a broken link — and why the board
    // draws it broken instead of dropping it, so the refusal is visible.
    const gutted = page()
    delete gutted.nodes.button
    gutted.nodes.card = node('card', 'base.container', [])
    expect(resolveSourceIds([link()], [gutted]).has('link-1')).toBe(false)
  })

  it('omits a link whose page is not loaded at all', () => {
    expect(resolveSourceIds([link()], []).has('link-1')).toBe(false)
  })
})
