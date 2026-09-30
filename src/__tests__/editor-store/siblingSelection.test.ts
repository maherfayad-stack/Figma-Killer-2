/**
 * P2-B — the two sibling moves behind Tab / ⇧Tab (IX-3, `selectSiblingNode`)
 * and ⌘A (IX-4, `selectAllSiblingNodes`), pinned at the store seam. The
 * keyboard wiring that calls them is covered in
 * `src/__tests__/canvas/selectionKeyboardHands.test.tsx`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    selectedFrameIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)
afterAll(resetStore)

/**
 * root → [header, main]
 * main → [a, b (hidden), c, d (locked), e]
 */
function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['header', 'main'] }),
      header: makeNode({ id: 'header', moduleId: 'base.container' }),
      main: makeNode({ id: 'main', moduleId: 'base.container', children: ['a', 'b', 'c', 'd', 'e'] }),
      a: makeNode({ id: 'a', moduleId: 'base.text' }),
      b: makeNode({ id: 'b', moduleId: 'base.text', hidden: true }),
      c: makeNode({ id: 'c', moduleId: 'base.text' }),
      d: makeNode({ id: 'd', moduleId: 'base.text', locked: true }),
      e: makeNode({ id: 'e', moduleId: 'base.text' }),
    },
  })
  useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: 'page-1' })
}

const state = () => useEditorStore.getState()

describe('selectSiblingNode (Tab / ⇧Tab)', () => {
  it('walks forward in source order, skipping hidden and locked siblings, and wraps', () => {
    seed()
    state().selectNode('a')
    expect(state().selectSiblingNode('next')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['c'])
    expect(state().selectSiblingNode('next')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['e'])
    expect(state().selectSiblingNode('next')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['a'])
  })

  it('walks backward and wraps the other way', () => {
    seed()
    state().selectNode('a')
    expect(state().selectSiblingNode('previous')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['e'])
    expect(state().selectSiblingNode('previous')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['c'])
  })

  it('collapses a multi-selection to its anchor first (Penpot)', () => {
    seed()
    state().selectMany(['a', 'c'])
    expect(state().selectSiblingNode('next')).toBe(true)
    expect(state().selectedNodeIds).toEqual(['c'])
  })

  it('keeps the board frame the selection came from (WS-10 variant frames)', () => {
    seed()
    state().selectNode('a', 'replace', { frameId: 'frame-b' })
    state().selectSiblingNode('next')
    expect(state().selectedNodeFrameId).toBe('frame-b')
  })

  it('reports false at the root, and leaves the selection alone', () => {
    seed()
    state().selectNode('root')
    expect(state().selectSiblingNode('next')).toBe(false)
    expect(state().selectedNodeId).toBe('root')
  })
})

describe('selectAllSiblingNodes (⌘A)', () => {
  it('selects the visible, unlocked siblings, keeping the anchor last', () => {
    seed()
    state().selectNode('c')
    expect(state().selectAllSiblingNodes()).toBe(true)
    expect(new Set(state().selectedNodeIds)).toEqual(new Set(['a', 'c', 'e']))
  })

  it('climbs one level when every sibling is already selected (Figma)', () => {
    seed()
    state().selectNode('c')
    state().selectAllSiblingNodes()
    expect(state().selectAllSiblingNodes()).toBe(true)
    expect(state().selectedNodeIds).toEqual(['header', 'main'])
  })

  it('climbs to the root alone, because a root is never part of a multi-selection', () => {
    seed()
    state().selectNode('header')
    state().selectAllSiblingNodes()
    expect(state().selectedNodeIds).toEqual(['header', 'main'])
    expect(state().selectAllSiblingNodes()).toBe(true)
    expect(state().selectedNodeIds).toEqual(['root'])
  })

  it('reports false with the root selected — the caller hands over to "all frames"', () => {
    seed()
    state().selectNode('root')
    expect(state().selectAllSiblingNodes()).toBe(false)
    expect(state().selectedNodeIds).toEqual(['root'])
  })

  it('keeps the board frame the selection came from', () => {
    seed()
    state().selectNode('a', 'replace', { frameId: 'frame-b' })
    state().selectAllSiblingNodes()
    expect(state().selectedNodeFrameId).toBe('frame-b')
  })
})
