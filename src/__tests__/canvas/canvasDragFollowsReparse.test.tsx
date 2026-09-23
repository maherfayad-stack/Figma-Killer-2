/**
 * ERR-23 — a drag whose element was re-addressed mid-gesture.
 *
 * The drag session keeps its ids and its tree in a ref, captured at
 * `pointerdown`, because it must commit React exactly twice per gesture. A
 * reparse that landed WHILE the pointer was down (an agent's write, the resync
 * of the previous gesture) therefore never reached it, and the release
 * committed against the pre-write ids: a thrown "stale target" swallowed into
 * a `console.warn`, or — when the write permuted line numbers — a move of the
 * element that had inherited the dragged one's address.
 *
 * Both reload paths now publish the follower they mapped the selection
 * through (`reparseNodeFollow.ts`), and the session re-addresses itself from
 * it: the release moves the element the user grabbed, at its new id, or the
 * gesture ends when that element is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const ROOT = 'a.tsx:2:3'
const TITLE = 'a.tsx:3:5'
const WIDTH = 1000

function text(id: string, value: string) {
  return makeNode({ id, moduleId: 'base.text', props: { text: value, tag: 'p' }, parentId: ROOT })
}

function page(children: [string, string][]): Page {
  return makePage({
    id: 'home',
    slug: 'index',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: children.map(([id]) => id) }),
      ...Object.fromEntries(children.map(([id, value]) => [id, text(id, value)])),
    },
  })
}

const before = () => page([[TITLE, 'Title'], ['a.tsx:4:5', 'Body']])
/** An agent inserted a banner on line 4: "Body" is now `a.tsx:5:5`, and `a.tsx:4:5` is the banner. */
const withBannerAbove = () => page([[TITLE, 'Title'], ['a.tsx:4:5', 'NEW BANNER'], ['a.tsx:5:5', 'Body']])

function stubRect(el: Element, top: number, height: number, width = WIDTH) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top, width, height, right: width, bottom: top + height, x: 0, y: top }) as DOMRect
}

let viewport: HTMLElement

/** Render the page's `[data-node-id]` boxes into the viewport, stacked top to bottom, 60px each. */
function renderDom(ids: string[]) {
  viewport.innerHTML = ''
  const rootEl = document.createElement('div')
  rootEl.setAttribute('data-node-id', ROOT)
  stubRect(rootEl, 0, ids.length * 60)
  viewport.appendChild(rootEl)
  ids.forEach((id, i) => {
    const el = document.createElement('div')
    el.setAttribute('data-node-id', id)
    stubRect(el, i * 60, 60)
    rootEl.appendChild(el)
  })
}

function pointerDownEvent(el: HTMLElement, x: number, y: number) {
  return {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    currentTarget: el,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent<HTMLElement>
}

function dispatchPointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button: 0 })
  window.dispatchEvent(event)
}

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

let moves: { ids: string[]; parentId: string; index: number }[]

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeInlineEdit: null,
    enteredInstanceIds: [],
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadSite(makeSite({ pages: [before()] }))
  useEditorStore.getState().setActivePage('home')
  useEditorStore.getState().selectNode('a.tsx:4:5')
  moves = []
  // The commit's own store action, observed rather than run: what ERR-23 is
  // about is WHICH element the release names, not how a move is written.
  useEditorStore.setState({
    moveNodes: (ids: string[], parentId: string, index: number) => {
      moves.push({ ids: [...ids], parentId, index })
    },
  } as unknown as Parameters<typeof useEditorStore.setState>[0])

  viewport = document.createElement('div')
  stubRect(viewport, 0, 800)
  Object.defineProperty(viewport, 'offsetWidth', { value: WIDTH, configurable: true })
  document.body.appendChild(viewport)
  renderDom([TITLE, 'a.tsx:4:5'])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function renderDrag() {
  const viewportRef = { current: viewport }
  return renderHook(() =>
    useCanvasReorderDrag({
      viewportRef,
      canvasRootRef: viewportRef,
      iframeElement: null,
      overlayRoot: null,
      selectedNodeIds: ['a.tsx:4:5'],
      pageId: 'home',
      enabled: true,
      bodyDragEnabled: false,
      panBy: () => {},
    }),
  )
}

describe('a reparse mid-drag re-addresses the session (ERR-23)', () => {
  it('releases onto the element the user grabbed, at its new id — not the one that inherited its address', async () => {
    const { result } = renderDrag()
    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 90))
    })
    act(() => {
      dispatchPointer('pointermove', 500, 50)
    })
    await nextFrame()
    expect(result.current.dragging).toBe(true)

    // The agent's write lands while the pointer is down.
    act(() => {
      useEditorStore.getState().patchPages({ pages: [withBannerAbove()] })
      renderDom([TITLE, 'a.tsx:4:5', 'a.tsx:5:5'])
    })
    expect(result.current.dragging).toBe(true)

    // Drop above the title.
    act(() => {
      dispatchPointer('pointermove', 500, 10)
    })
    await nextFrame()
    act(() => {
      dispatchPointer('pointerup', 500, 10)
    })

    expect(moves).toHaveLength(1)
    expect(moves[0]!.ids).toEqual(['a.tsx:5:5'])
    expect(moves[0]!.parentId).toBe(ROOT)
  })

  it('ends the gesture when the dragged element is gone, and the release commits nothing', async () => {
    const { result } = renderDrag()
    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 90))
    })
    act(() => {
      dispatchPointer('pointermove', 500, 50)
    })
    await nextFrame()
    expect(result.current.dragging).toBe(true)

    act(() => {
      useEditorStore.getState().patchPages({ pages: [page([[TITLE, 'Title']])] })
      renderDom([TITLE])
    })

    expect(result.current.dragging).toBe(false)
    act(() => {
      dispatchPointer('pointerup', 500, 10)
    })
    expect(moves).toEqual([])
  })
})
