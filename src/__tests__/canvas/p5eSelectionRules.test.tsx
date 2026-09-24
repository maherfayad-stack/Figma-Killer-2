/**
 * P5-E — the pure rules behind the in-frame marquee (IX-16), ⏎ on text
 * (IX-7), the created-node follow-up (T types into the new text, ⇧A lays out
 * the new group), and the "Select layer" list (IX-26).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasSelectionKeyboard } from '@site/canvas/useCanvasSelectionKeyboard'
import { marqueeBetween, marqueeHits, type MarqueeCandidate } from '@site/canvas/inFrameMarquee'
import {
  armCreatedNodeFollowUp,
  cancelCreatedNodeFollowUp,
  FOLLOW_UP_WINDOW_MS,
  offerSelectionToFollowUp,
} from '@site/canvas/createdNodeFollowUp'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['card', 'title'] }),
      card: makeNode({ id: 'card', moduleId: 'base.container', children: ['inner'] }),
      inner: makeNode({ id: 'inner', moduleId: 'base.container' }),
      title: makeNode({ id: 'title', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeInlineEdit: null,
    canvasTool: 'move',
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(seed)
afterEach(() => {
  cleanup()
  cancelCreatedNodeFollowUp()
  useEditorStore.setState({ activeInlineEdit: null } as Parameters<typeof useEditorStore.setState>[0])
})

describe('in-frame marquee hits (IX-16, OD-6)', () => {
  const candidates: MarqueeCandidate[] = [
    { nodeId: 'card', depth: 1, rect: { x: 0, y: 0, width: 100, height: 100 } },
    { nodeId: 'inner', depth: 2, rect: { x: 10, y: 10, width: 30, height: 30 } },
    { nodeId: 'title', depth: 1, rect: { x: 0, y: 120, width: 100, height: 20 } },
  ]
  const isDescendant = (id: string, ancestor: string) => id === 'inner' && ancestor === 'card'

  it('selects the SHALLOWEST level the rectangle touches', () => {
    expect(marqueeHits(candidates, marqueeBetween({ x: 20, y: 20 }, { x: 50, y: 130 }), { deepest: false, isDescendant })).toEqual(['card', 'title'])
  })

  it('with ⌥, the DEEPEST hits instead', () => {
    expect(marqueeHits(candidates, marqueeBetween({ x: 20, y: 20 }, { x: 50, y: 130 }), { deepest: true, isDescendant })).toEqual(['inner', 'title'])
  })

  it('a rectangle over nothing selects nothing', () => {
    expect(marqueeHits(candidates, marqueeBetween({ x: 200, y: 200 }, { x: 250, y: 250 }), { deepest: false, isDescendant })).toEqual([])
  })
})

describe('the created-node follow-up', () => {
  it('runs on the first selection of a node that did not exist when it was armed', () => {
    const ran: string[] = []
    armCreatedNodeFollowUp((id) => ran.push(id))
    // Selecting something that already existed drops it: the user did something else.
    expect(offerSelectionToFollowUp(['card'])).toBe(false)
    expect(offerSelectionToFollowUp(['brand-new'])).toBe(false)
    expect(ran).toEqual([])

    armCreatedNodeFollowUp((id) => ran.push(id))
    expect(offerSelectionToFollowUp(['brand-new'])).toBe(true)
    expect(ran).toEqual(['brand-new'])
    // Once only.
    expect(offerSelectionToFollowUp(['another'])).toBe(false)
  })

  it('expires, so a stale arming can never fire on a later gesture', () => {
    const ran: string[] = []
    armCreatedNodeFollowUp((id) => ran.push(id), 1_000)
    expect(offerSelectionToFollowUp(['brand-new'], 1_000 + FOLLOW_UP_WINDOW_MS + 1)).toBe(false)
    expect(ran).toEqual([])
  })
})

describe('⏎ on a text layer types into it (IX-7)', () => {
  function mount() {
    return renderHook(() => {
      useEditorKeyDispatcher()
      useCanvasSelectionKeyboard(true, false, () => {})
    })
  }

  function press(init: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    document.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('opens the inline edit on the selected text, as a double-click would', () => {
    mount()
    useEditorStore.getState().selectNode('title')
    expect(press({ key: 'Enter' })).toBe(true)
    expect(useEditorStore.getState().activeInlineEdit).toMatchObject({ nodeId: 'title', prop: 'text' })
  })

  it('on a container it selects ALL the children instead', () => {
    mount()
    useEditorStore.getState().selectNode('root')
    press({ key: 'Enter' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['card', 'title'])
  })
})
