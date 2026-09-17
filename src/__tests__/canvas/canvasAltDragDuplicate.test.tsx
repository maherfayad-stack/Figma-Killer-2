/**
 * K2 — Alt+drag duplicates.
 *
 * Two halves, asserted at the layer each actually lives at:
 *
 *  - the DRAG SESSION reads Alt per pointer event, so releasing the key
 *    mid-gesture reverts the drop to a move and pressing it turns a move into
 *    a copy. The commit reads the modifier state at RELEASE, which is the only
 *    reading that matches what the ghost was showing an instant earlier.
 *  - the STORE routes an Alt drop to `duplicateNodesTo`, which on an ordinary
 *    (non-studio) tree degrades to "duplicate in place, then move the copies"
 *    — the original stays exactly where it was, which is the whole difference
 *    between this gesture and the one without the modifier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
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

function boxElement(): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }) as DOMRect
  document.body.appendChild(el)
  return el
}

function pointerDownEvent(el: HTMLElement, x: number, y: number, altKey = false) {
  return {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    altKey,
    currentTarget: el,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent<HTMLElement>
}

function dispatchPointer(type: string, x: number, y: number, altKey = false) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, altKey, button: 0 })
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
      overlayRoot: null,
      selectedNodeIds: ['a'],
      enabled: true,
      bodyDragEnabled: false,
      panBy: () => {},
    }),
  )
}

/** The layer the session paints into, as `BreakpointSelectionOverlay` supplies it. */
function mountDropLayer(ref: React.RefObject<HTMLDivElement | null>) {
  const layer = document.createElement('div')
  document.body.appendChild(layer)
  ref.current = layer
  return layer
}

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

describe('Alt+drag — the ghost reads the modifier live', () => {
  it('shows the copy badge while Alt is held and drops it the moment Alt is released', async () => {
    const { result } = renderDrag()
    const layer = mountDropLayer(result.current.dropLayerRef)

    act(() => {
      result.current.handlePointerDown(pointerDownEvent(viewport, 500, 400, true))
    })
    act(() => { dispatchPointer('pointermove', 560, 400, true) })
    await nextFrame()

    const ghost = layer.querySelector('[data-canvas-drag-ghost]')
    expect(ghost).not.toBeNull()
    expect(ghost?.getAttribute('data-duplicating')).toBe('true')

    // Alt released mid-drag — the gesture is a move again, and the badge goes
    // with it. Latching the modifier at pointerdown would leave it lying.
    act(() => { dispatchPointer('pointermove', 570, 400, false) })
    await nextFrame()
    expect(ghost?.getAttribute('data-duplicating')).toBeNull()

    act(() => { dispatchPointer('pointerup', 570, 400, false) })
  })
})

describe('Alt+drag — what lands', () => {
  it('leaves the original in place and adds a copy at the drop position', () => {
    const before = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    expect(before).toEqual(['a', 'b'])

    // Driven through the store action the session commits to, rather than
    // through a synthetic 800px-wide hit test: what K2 has to guarantee is
    // that the ORIGINAL survives, which is a store question, not a geometry
    // one (the geometry is S2's, and tested there).
    useEditorStore.getState().duplicateNodesTo(['a'], 'root', 2)

    const after = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    expect(after).toHaveLength(3)
    // The original is untouched, at its own index.
    expect(after[0]).toBe('a')
    // The copy is a real, distinct node — not the same id twice.
    expect(new Set(after).size).toBe(3)
  })

  it('is a no-op for an empty selection', () => {
    const before = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    expect(useEditorStore.getState().duplicateNodesTo([], 'root', 0)).toEqual([])
    expect(useEditorStore.getState().site!.pages[0]!.nodes.root!.children).toEqual(before)
  })
})
