/**
 * P2-I (PERF-1) — hover is not an editor-store write.
 *
 * Zustand runs every subscribed selector on every `set()`, and the canvas
 * mounts a handful per node per mounted frame. While hover lived in the
 * store, every pointer crossing — two per element, a leave and an enter — was
 * a `set()` that swept all of them (~40k selector runs per crossing on a
 * 40 × 300 board, `scripts/bench/lib/canvasSubscriberSweep.ts`). The canvas
 * now writes hover to `canvasHover.ts`, which wakes only who asked.
 *
 * These drive the REAL entry points — a pointer crossing on the canvas and on
 * a Layers row — and count store notifications, which is exactly "did the
 * sweep run".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import {
  clearCanvasHover,
  followCanvasHover,
  getCanvasHover,
  setCanvasHover,
  subscribeCanvasHover,
  subscribeCanvasHoverNode,
} from '@site/canvas/canvasHover'
import { queryCanvasElement } from './iframeCanvasQuery'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function setupPage() {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['first', 'second'] })
  const first = makeNode({ id: 'first', moduleId: 'base.text', props: { text: 'First', tag: 'p' } })
  const second = makeNode({ id: 'second', moduleId: 'base.text', props: { text: 'Second', tag: 'p' } })
  useEditorStore.setState({
    site: makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: 'root', nodes: { root, first, second } })] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    playMode: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

async function waitForCanvasNode(id: string): Promise<HTMLElement> {
  for (let i = 0; i < 40; i += 1) {
    const el = queryCanvasElement<HTMLElement>(`[data-node-id="${id}"]`)
    if (el) return el
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error(`Expected node ${id} in the canvas iframe`)
}

beforeEach(() => {
  cleanup()
  clearCanvasHover()
  globalThis.fetch = (async () => new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
})

afterEach(() => {
  cleanup()
  clearCanvasHover()
  globalThis.fetch = originalFetch
})

describe('a hover crossing on the canvas is not an editor-store write (PERF-1)', () => {
  it('enter, leave, enter: the hover moves and the store notifies nobody', async () => {
    setupPage()
    render(
      <DndContext>
        <CanvasRoot />
      </DndContext>,
    )
    const first = await waitForCanvasNode('first')
    const second = await waitForCanvasNode('second')
    // Let the mount's own settle writes (breakpoint activation etc.) land first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    let storeNotifications = 0
    const unsubscribe = useEditorStore.subscribe(() => {
      storeNotifications += 1
    })
    try {
      act(() => {
        fireEvent.mouseEnter(first)
      })
      expect(getCanvasHover()?.nodeId).toBe('first')
      act(() => {
        fireEvent.mouseLeave(first)
        fireEvent.mouseEnter(second)
      })
      expect(getCanvasHover()?.nodeId).toBe('second')
    } finally {
      unsubscribe()
    }
    expect(storeNotifications).toBe(0)
  })

  it('the canvas never stamps the dead `data-hovered` attribute (no stylesheet read it)', async () => {
    setupPage()
    render(
      <DndContext>
        <CanvasRoot />
      </DndContext>,
    )
    const first = await waitForCanvasNode('first')
    act(() => {
      fireEvent.mouseEnter(first)
    })
    expect(first.hasAttribute('data-hovered')).toBe(false)
  })
})

describe('canvasHover: who wakes', () => {
  it('a crossing wakes exactly the two nodes involved, and every whole-value listener once', () => {
    const woken: string[] = []
    const unsubs = ['a', 'b', 'c', 'd'].map((id) => subscribeCanvasHoverNode(id, () => woken.push(id)))
    let wholeValue = 0
    unsubs.push(subscribeCanvasHover(() => (wholeValue += 1)))

    setCanvasHover('a', 'studio', 'frame-1')
    expect(woken).toEqual(['a'])
    setCanvasHover('b', 'studio', 'frame-1')
    expect(woken).toEqual(['a', 'a', 'b'])
    expect(wholeValue).toBe(2)
    for (const unsub of unsubs) unsub()
  })

  it('re-hovering the same node in the same frame wakes nobody (speed-03)', () => {
    setCanvasHover('a', 'studio', 'frame-1')
    let calls = 0
    const unsubs = [subscribeCanvasHoverNode('a', () => (calls += 1)), subscribeCanvasHover(() => (calls += 1))]
    for (let move = 0; move < 20; move += 1) setCanvasHover('a', 'studio', 'frame-1')
    expect(calls).toBe(0)
    // A different frame of the same node IS a change (WS-10 variant frames).
    setCanvasHover('a', 'studio', 'frame-2')
    expect(calls).toBe(2)
    for (const unsub of unsubs) unsub()
  })

  it('follows a reparse: moved ids carry the hover, vanished ids clear it (ERR-5)', () => {
    setCanvasHover('a.tsx:4:5', 'studio', 'frame-1')
    followCanvasHover((id) => (id === 'a.tsx:4:5' ? 'a.tsx:5:5' : id))
    expect(getCanvasHover()).toEqual({ nodeId: 'a.tsx:5:5', breakpointId: 'studio', frameId: 'frame-1' })
    followCanvasHover(() => null)
    expect(getCanvasHover()).toBeNull()
  })
})

describe('store actions that drop the selection drop the hover too', () => {
  it('clearSelection clears it', () => {
    setCanvasHover('a', 'studio', null)
    useEditorStore.getState().clearSelection()
    expect(getCanvasHover()).toBeNull()
  })

  it('arming Play clears it — the hover ring is editing chrome', () => {
    setCanvasHover('a', 'studio', null)
    useEditorStore.getState().setPlayMode(true)
    expect(getCanvasHover()).toBeNull()
    useEditorStore.getState().setPlayMode(false)
  })
})

// perf-12's side note — a `mouseleave` from a child into its parent fires on
// the child only; the parent never gets a `mouseenter` (the pointer never
// left it). The leave hands the hover to where the pointer went.
describe('a leave hands the hover to the node the pointer went into', () => {
  function setupNestedPage() {
    const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['card'] })
    const card = makeNode({ id: 'card', moduleId: 'base.container', children: ['label'] })
    const label = makeNode({ id: 'label', moduleId: 'base.text', props: { text: 'Label', tag: 'p' } })
    useEditorStore.setState({
      site: makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: 'root', nodes: { root, card, label } })] }),
      activePageId: 'page-1',
      activeDocument: null,
      activeBreakpointId: 'desktop',
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedNodeFrameId: null,
      playMode: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('child → parent: the parent keeps the hover', async () => {
    setupNestedPage()
    render(
      <DndContext>
        <CanvasRoot />
      </DndContext>,
    )
    const card = await waitForCanvasNode('card')
    const label = await waitForCanvasNode('label')
    act(() => {
      fireEvent.mouseEnter(card)
      fireEvent.mouseEnter(label)
    })
    expect(getCanvasHover()?.nodeId).toBe('label')
    act(() => {
      fireEvent.mouseLeave(label, { relatedTarget: card })
    })
    expect(getCanvasHover()?.nodeId).toBe('card')
  })

  it('leaving the frame altogether still clears it', async () => {
    setupNestedPage()
    render(
      <DndContext>
        <CanvasRoot />
      </DndContext>,
    )
    const label = await waitForCanvasNode('label')
    act(() => {
      fireEvent.mouseEnter(label)
    })
    act(() => {
      fireEvent.mouseLeave(label, { relatedTarget: null })
    })
    expect(getCanvasHover()).toBeNull()
  })
})
