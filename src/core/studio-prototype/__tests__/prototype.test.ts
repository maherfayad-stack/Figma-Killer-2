/**
 * The prototype link model: what survives a round trip, what a hand-edited
 * file is repaired into, and what a page deletion takes with it.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, NodeTree } from '@core/page-tree'
import { captureNodeHint } from '@core/studio-anchor'
import {
  createPrototypeFile,
  defaultLinkPresentation,
  linksFromPage,
  linksToPage,
  parsePrototypeFile,
  prunePrototypeLinks,
  removePrototypeLink,
  resolveLinkSource,
  serializePrototypeFile,
  transitionsForAction,
  upsertPrototypeLink,
  type PrototypeLink,
} from '..'

function node(id: string, moduleId: string, children: string[] = [], props: Record<string, unknown> = {}): BaseNode {
  return { id, moduleId, props, breakpointOverrides: {}, children }
}

function tree(overrides: Record<string, BaseNode> = {}): NodeTree {
  const nodes: Record<string, BaseNode> = {
    root: node('root', 'base.body', ['cta']),
    cta: node('cta', 'base.button', [], { text: 'Continue' }),
    ...overrides,
  }
  return { nodes, rootNodeId: 'root' }
}

/**
 * The same page after a re-parse: the button sits at the same index path but
 * carries a fresh, position-derived id — the ordinary outcome of editing a line
 * above it.
 */
function reparsedTree(ctaId: string, text: string): NodeTree {
  return {
    nodes: {
      root: node('root', 'base.body', [ctaId]),
      [ctaId]: node(ctaId, 'base.button', [], { text }),
    },
    rootNodeId: 'root',
  }
}

function link(overrides: Partial<PrototypeLink> = {}): PrototypeLink {
  return {
    id: 'link-1',
    origin: 'design',
    source: { pageId: 'welcome', node: captureNodeHint(tree(), 'cta')! },
    trigger: 'click',
    action: 'navigate',
    targetPageId: 'sign-in',
    transition: 'slide-left',
    ...overrides,
  }
}

describe('round trip', () => {
  it('survives serialize → parse unchanged', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    expect(parsePrototypeFile(serializePrototypeFile(file))).toEqual(file)
  })

  it('parses the serialized string as well as the object', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    const text = serializePrototypeFile(file)
    expect(parsePrototypeFile(JSON.parse(text))).toEqual(parsePrototypeFile(text))
  })

  it('opens an empty, missing or unparseable file as an empty flow', () => {
    expect(parsePrototypeFile('{ not json')).toEqual(createPrototypeFile())
    expect(parsePrototypeFile(null)).toEqual(createPrototypeFile())
    expect(parsePrototypeFile({ version: 1 })).toEqual(createPrototypeFile())
  })
})

describe('repair vs drop', () => {
  it('repairs a transition that is unknown, to the action default', () => {
    const file = parsePrototypeFile({ version: 1, links: [{ ...link(), transition: 'barrel-roll' }] })
    expect(file.links[0]!.transition).toBe('instant')
  })

  it('repairs a transition that is legal for a DIFFERENT action', () => {
    // `sheet` describes something presented over a screen that stays put, which
    // is meaningless for a navigation that replaces the screen.
    const file = parsePrototypeFile({ version: 1, links: [{ ...link(), transition: 'sheet' }] })
    expect(file.links[0]!.transition).toBe('instant')

    const overlay = parsePrototypeFile({
      version: 1,
      links: [{ ...link(), action: 'overlay', transition: 'push-left' }],
    })
    expect(overlay.links[0]!.transition).toBe('popup')
  })

  it('strips the target and transition from back/close, which have neither', () => {
    const file = parsePrototypeFile({
      version: 1,
      links: [{ ...link(), action: 'back', targetPageId: 'left-over', transition: 'dissolve' }],
    })
    expect(file.links[0]!.targetPageId).toBeNull()
    expect(file.links[0]!.transition).toBeUndefined()
  })

  it('reads an unknown trigger as the click it almost certainly is', () => {
    const file = parsePrototypeFile({ version: 1, links: [{ ...link(), trigger: 'hover' }] })
    expect(file.links[0]!.trigger).toBe('click')
  })

  it('drops a navigate/overlay with no target rather than inventing a destination', () => {
    expect(parsePrototypeFile({ version: 1, links: [{ ...link(), targetPageId: '' }] }).links).toHaveLength(0)
    const overlay = { ...link(), action: 'overlay', transition: 'sheet', targetPageId: null }
    expect(parsePrototypeFile({ version: 1, links: [overlay] }).links).toHaveLength(0)
  })

  it('drops a link with no source page, no source node, or an unknown action', () => {
    const noPage = { ...link(), source: { ...link().source, pageId: '' } }
    const noNode = { ...link(), source: { pageId: 'welcome', node: { nodeId: '' } } }
    expect(parsePrototypeFile({ version: 1, links: [noPage] }).links).toHaveLength(0)
    expect(parsePrototypeFile({ version: 1, links: [noNode] }).links).toHaveLength(0)
    expect(parsePrototypeFile({ version: 1, links: [{ ...link(), action: 'teleport' }] }).links).toHaveLength(0)
  })

  it('keeps the good links in a file that also contains a bad one', () => {
    const file = parsePrototypeFile({
      version: 1,
      links: [link({ id: 'good' }), { ...link({ id: 'bad' }), action: 'teleport' }],
    })
    expect(file.links.map((l) => l.id)).toEqual(['good'])
  })

  it('defaults an unrecognised origin to design, never to code', () => {
    // `code` means "Studio read this out of the user's real source", which makes
    // it read-only on the board. Never claim that on a guess.
    const file = parsePrototypeFile({ version: 1, links: [{ ...link(), origin: 'nonsense' }] })
    expect(file.links[0]!.origin).toBe('design')
  })
})

describe('link operations', () => {
  it('upsert replaces by id instead of appending a duplicate', () => {
    const once = upsertPrototypeLink(createPrototypeFile(), link())
    const twice = upsertPrototypeLink(once, link({ targetPageId: 'otp' }))
    expect(twice.links).toHaveLength(1)
    expect(twice.links[0]!.targetPageId).toBe('otp')
  })

  it('remove is identity when the id is not there', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    expect(removePrototypeLink(file, 'nope')).toBe(file)
    expect(removePrototypeLink(file, 'link-1').links).toHaveLength(0)
  })

  it('separates outgoing from incoming flows', () => {
    const file = {
      version: 1 as const,
      links: [link({ id: 'a' }), link({ id: 'b', source: { pageId: 'sign-in', node: link().source.node }, targetPageId: 'welcome' })],
    }
    expect(linksFromPage(file, 'welcome').map((l) => l.id)).toEqual(['a'])
    expect(linksToPage(file, 'welcome').map((l) => l.id)).toEqual(['b'])
  })
})

describe('pruning on page delete', () => {
  it('drops links whose target page is gone', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    expect(prunePrototypeLinks(file, ['welcome']).links).toHaveLength(0)
    expect(prunePrototypeLinks(file, ['welcome', 'sign-in']).links).toHaveLength(1)
  })

  it('drops links whose SOURCE page is gone', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    expect(prunePrototypeLinks(file, ['sign-in']).links).toHaveLength(0)
  })

  it('keeps a back link, which names no target at all', () => {
    const back = link({ id: 'back-1', action: 'back', targetPageId: null, transition: undefined })
    const file = upsertPrototypeLink(createPrototypeFile(), back)
    expect(prunePrototypeLinks(file, ['welcome']).links).toHaveLength(1)
  })

  it('is identity when nothing needs pruning', () => {
    const file = upsertPrototypeLink(createPrototypeFile(), link())
    expect(prunePrototypeLinks(file, ['welcome', 'sign-in'])).toBe(file)
  })
})

describe('presentation defaults', () => {
  it('takes the presentation from the target page kind, so nobody is asked twice', () => {
    expect(defaultLinkPresentation('popup')).toEqual({ action: 'overlay', transition: 'popup' })
    expect(defaultLinkPresentation('sheet-small')).toEqual({ action: 'overlay', transition: 'sheet' })
    expect(defaultLinkPresentation('sheet-large')).toEqual({ action: 'overlay', transition: 'sheet' })
    expect(defaultLinkPresentation('screen')).toEqual({ action: 'navigate', transition: 'slide-left' })
  })

  it('offers no transition for the two actions that reverse another one', () => {
    expect(transitionsForAction('back')).toEqual([])
    expect(transitionsForAction('close')).toEqual([])
    expect(transitionsForAction('overlay')).toEqual(['popup', 'sheet'])
  })

  it('every default it hands out is legal for the action it pairs with', () => {
    for (const kind of ['screen', 'popup', 'sheet-small', 'sheet-large'] as const) {
      const { action, transition } = defaultLinkPresentation(kind)
      expect(transitionsForAction(action)).toContain(transition)
    }
  })
})

describe('source resolution policy', () => {
  it('follows a link whose label was edited — unlike a comment, which refuses', () => {
    // A comment on a `drifted` anchor is about the text that changed, so its
    // agent gate refuses. Relabelling a button does not change where it goes.
    const hint = captureNodeHint(tree(), 'cta')!
    const renamed = reparsedTree('cta:9:4', 'Next')

    const resolved = resolveLinkSource(hint, renamed)
    expect(resolved.confidence).toBe('drifted')
    expect(resolved.live).toBe(true)
  })

  it('breaks a link whose source element is gone, rather than dropping it silently', () => {
    const hint = captureNodeHint(tree(), 'cta')!
    const empty: NodeTree = { nodes: { root: node('root', 'base.body', []) }, rootNodeId: 'root' }

    const resolved = resolveLinkSource(hint, empty)
    expect(resolved.confidence).toBe('detached')
    expect(resolved.live).toBe(false)
    expect(resolved.nodeId).toBeNull()
  })

  it('refreshes the node id when the source only moved', () => {
    const hint = captureNodeHint(tree(), 'cta')!
    const shifted = reparsedTree('cta:9:4', 'Continue')

    const resolved = resolveLinkSource(hint, shifted)
    expect(resolved.confidence).toBe('moved')
    expect(resolved.nodeId).toBe('cta:9:4')
    expect(resolved.live).toBe(true)
  })
})
