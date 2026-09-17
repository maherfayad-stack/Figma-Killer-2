/**
 * S2 — the element drag is a SESSION, not a re-render.
 *
 * The defect this pins: `useCanvasReorderDrag` used to do two forced layout
 * reads (`viewport.getBoundingClientRect()`, twice: once for the pointer's
 * frame-space point and once to recover the zoom) plus one `setState` on
 * EVERY raw `pointermove`. A trackpad or a high-rate mouse raises several
 * pointermoves per painted frame, so a gesture that changes no layout was
 * invalidating layout dozens of times a frame and re-rendering the whole
 * selection overlay with it.
 *
 * The session measures once, writes a ref per move, resolves and paints in
 * ONE rAF, and writes the store once on `pointerup`. These cases assert each
 * of those four independently, plus Escape and the Shift axis lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { constrainToDragAxis } from '@site/canvas/canvasDragSession'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function seedSite() {
  const site = makeSite({
    pages: [
      makePage({
        id: 'home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: {
          root: makeNode({ id: 'root', moduleId: 'base.container', children: ['a', 'b'] }),
          a: makeNode({ id: 'a', moduleId: 'base.text', props: { text: 'A' }, parentId: 'root' }),
          b: makeNode({ id: 'b', moduleId: 'base.text', props: { text: 'B' }, parentId: 'root' }),
        },
      }),
    ],
  })
  useEditorStore.getState().loadSite(site)
  useEditorStore.setState({ selectedNodeId: 'a', selectedNodeIds: ['a'] })
}

/** A box element that counts how many times its rect was read. */
function countingBox(): { element: HTMLElement; reads: () => number } {
  let reads = 0
  const el = document.createElement('div')
  el.getBoundingClientRect = () => {
    reads++
    return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 } as DOMRect
  }
  document.body.appendChild(el)
  return { element: el, reads: () => reads }
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

function dispatchPointer(type: string, x: number, y: number, shiftKey = false) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, shiftKey, button: 0 })
  window.dispatchEvent(event)
}

function pressEscape() {
  const event = new Event('keydown', { bubbles: true, cancelable: true })
  Object.assign(event, { key: 'Escape' })
  window.dispatchEvent(event)
}

/** Run every rAF callback the session queued, the way a painted frame would. */
async function flushFrames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

let viewport: { element: HTMLElement; reads: () => number }
let canvasRoot: { element: HTMLElement; reads: () => number }

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  seedSite()
  viewport = countingBox()
  canvasRoot = countingBox()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function renderDrag() {
  const viewportRef = { current: viewport.element }
  const canvasRootRef = { current: canvasRoot.element }
  let renders = 0
  const hook = renderHook(() => {
    renders++
    return useCanvasReorderDrag({
      viewportRef,
      canvasRootRef,
      iframeElement: null,
      overlayRoot: null,
      selectedNodeIds: ['a'],
      enabled: true,
      bodyDragEnabled: false,
      panBy: () => {},
    })
  })
  return { ...hook, renders: () => renders }
}

describe('useCanvasReorderDrag — one session, one rAF, one store write', () => {
  it('commits React exactly twice across a whole stream of pointer moves', async () => {
    const drag = renderDrag()
    act(() => {
      drag.result.current.handlePointerDown(pointerDownEvent(viewport.element, 500, 400))
    })
    // A press alone is still a click: no commit, and nothing advertising a drag.
    const afterPress = drag.renders()
    expect(drag.result.current.dragging).toBe(false)

    act(() => {
      for (let i = 0; i < 40; i++) dispatchPointer('pointermove', 500 + i, 400 + i)
    })
    await flushFrames()

    expect(drag.result.current.dragging).toBe(true)
    // ONE commit for those 40 events — the `dragging` flip at activation, which
    // the selection overlay's measurement scheduler renders from. The other 39
    // moves produced nothing: the drop line, the refusal chip and the ghost are
    // painted straight into the DOM.
    expect(drag.renders()).toBe(afterPress + 1)

    act(() => { dispatchPointer('pointerup', 540, 440) })
    // And one more at release, closing the gesture.
    expect(drag.result.current.dragging).toBe(false)
    expect(drag.renders()).toBe(afterPress + 2)
  })

  it('measures the viewport ONCE, not twice per pointermove', async () => {
    const drag = renderDrag()
    act(() => {
      drag.result.current.handlePointerDown(pointerDownEvent(viewport.element, 500, 400))
    })
    // One read at `beginDrag` — the index's origin + scale.
    const afterBegin = viewport.reads()
    expect(afterBegin).toBe(1)

    act(() => {
      for (let i = 0; i < 25; i++) dispatchPointer('pointermove', 500 + i, 400)
    })
    await flushFrames()

    // With no transform ref and no reflow, nothing invalidated the index, so
    // 25 moves cost zero further reads of the frame's viewport. The old code
    // did 50.
    expect(viewport.reads()).toBe(afterBegin)
  })

  it('writes the store once, on pointerup', async () => {
    const drag = renderDrag()
    let writes = 0
    const unsubscribe = useEditorStore.subscribe(() => { writes++ })
    try {
      act(() => {
        drag.result.current.handlePointerDown(pointerDownEvent(viewport.element, 500, 400))
      })
      act(() => {
        for (let i = 0; i < 20; i++) dispatchPointer('pointermove', 500 + i, 400)
      })
      await flushFrames()
      // Nothing has been written yet: the selection was already `a`, the drag
      // handle path selects nothing, and the tree is untouched until release.
      expect(writes).toBe(0)

      act(() => { dispatchPointer('pointerup', 520, 400) })
      // At most one transaction — whatever `moveNodes` did (it may resolve to
      // no-op if the drop landed nowhere, which is also "not more than one").
      expect(writes).toBeLessThanOrEqual(1)
    } finally {
      unsubscribe()
    }
  })

  it('Escape abandons the gesture and commits nothing', async () => {
    const before = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    const drag = renderDrag()

    act(() => {
      drag.result.current.handlePointerDown(pointerDownEvent(viewport.element, 500, 400))
    })
    act(() => { dispatchPointer('pointermove', 560, 400) })
    await flushFrames()
    expect(drag.result.current.dragging).toBe(true)

    act(() => { pressEscape() })
    expect(drag.result.current.dragging).toBe(false)

    // A pointerup after the cancel belongs to no session and must not revive it.
    act(() => { dispatchPointer('pointerup', 560, 400) })
    expect(useEditorStore.getState().site!.pages[0]!.nodes.root!.children).toEqual(before)
  })
})

describe('constrainToDragAxis', () => {
  it('locks to the axis the pointer has travelled further along', () => {
    const origin = { x: 100, y: 100 }
    // Mostly horizontal — y is pinned to the origin.
    expect(constrainToDragAxis(origin, { x: 160, y: 110 })).toEqual({ x: 160, y: 100 })
    // Mostly vertical — x is pinned to the origin.
    expect(constrainToDragAxis(origin, { x: 110, y: 160 })).toEqual({ x: 100, y: 160 })
  })

  it('prefers the horizontal axis on an exact diagonal, deterministically', () => {
    // A tie has to resolve the same way every frame, or the ghost flickers
    // between the two axes as the pointer crosses 45°.
    expect(constrainToDragAxis({ x: 0, y: 0 }, { x: 50, y: 50 })).toEqual({ x: 50, y: 0 })
  })
})
