/**
 * useCanvasReorderDrag — the drag activation distance.
 *
 * The session used to go live on `pointerdown`, which made a plain click on the
 * selection toolbar's "Drag selected layers" handle a completed zero-distance
 * drag. A couple of pixels of hand jitter is enough for one `pointermove` to
 * resolve a drop target, and `pointerup` then committed `moveNodes` to it — so
 * the selected element reparented itself under a click the user meant as a
 * click, and appeared to jump away on its own.
 *
 * The gesture is now held as a click until the pointer clears
 * `DRAG_ACTIVATE_PX` (4px): below that there is no drop target, no auto-pan, and
 * no move on pointerup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

/** A page with a container holding two text children — enough to have somewhere to drop. */
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

/** A DOM element standing in for the canvas viewport / root, with a real box. */
function boxElement(): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }) as DOMRect
  document.body.appendChild(el)
  return el
}

/** Minimal React-style pointer event the hook's `handlePointerDown` accepts. */
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
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent & {
    clientX: number
    clientY: number
    pointerId: number
  }
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1 })
  window.dispatchEvent(event)
}

let viewport: HTMLElement

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  seedSite()
  viewport = boxElement()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function renderDrag() {
  const viewportRef = { current: viewport }
  const canvasRootRef = { current: viewport }
  return renderHook(() =>
    useCanvasReorderDrag({
      viewportRef,
      canvasRootRef,
      iframeElement: null,
      selectedNodeIds: ['a'],
      enabled: true,
      panBy: () => {},
    }),
  )
}

describe('useCanvasReorderDrag — activation distance', () => {
  it('does not report a drag on pointerdown alone', () => {
    const { result } = renderDrag()

    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 400))
    })

    // The press is still a click: nothing should be advertising a live drag.
    expect(result.current.dragging).toBe(false)
  })

  it('treats a press with sub-threshold jitter as a click and moves nothing', () => {
    const before = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    const { result } = renderDrag()

    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 400))
    })
    act(() => {
      // 2px of travel — under DRAG_ACTIVATE_PX.
      dispatchPointer('pointermove', 502, 401)
    })

    expect(result.current.dragging).toBe(false)

    act(() => {
      dispatchPointer('pointerup', 502, 401)
    })

    // The tree is untouched — this is the regression: it used to commit a move.
    expect(useEditorStore.getState().site!.pages[0]!.nodes.root!.children).toEqual(before)
    expect(result.current.dragging).toBe(false)
  })

  it('becomes a real drag once the pointer clears the threshold', () => {
    const { result } = renderDrag()

    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 400))
    })
    act(() => {
      // 40px of travel — comfortably past DRAG_ACTIVATE_PX.
      dispatchPointer('pointermove', 540, 400)
    })

    expect(result.current.dragging).toBe(true)

    act(() => {
      dispatchPointer('pointerup', 540, 400)
    })

    // Session ended either way; the point is that it *was* a drag.
    expect(result.current.dragging).toBe(false)
  })
})
