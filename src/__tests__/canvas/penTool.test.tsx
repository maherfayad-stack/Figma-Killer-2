/**
 * P5-D (SVG-7) — the pen: P arms it; clicks place corners, a drag places a
 * smooth point; ⌘Z takes back the last point inside the session (never the
 * editor's undo); ⏎ / Escape / clicking the first point finish; the WHOLE
 * session is one write; fewer than two points write nothing.
 *
 * Here on the empty board, where a path becomes one loose layer on the free
 * canvas (OD-14); the in-frame insert needs layout and is the e2e's.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasToolShortcuts } from '@site/canvas/useCanvasToolShortcuts'
import { CanvasPenToolLayer } from '@site/canvas/CanvasPenToolLayer'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

let frameQueue: FrameRequestCallback[] = []
const realRaf = globalThis.requestAnimationFrame
let origin: HTMLElement | null = null
const createCanvasLayer = mock((_element: unknown, _at: unknown) => 'layer-1' as string | null)
const realCreate = useEditorStore.getState().createCanvasLayer

function flushFrames(): void {
  const queue = frameQueue
  frameQueue = []
  for (const callback of queue) callback(0)
}

beforeEach(() => {
  frameQueue = []
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frameQueue.push(cb)
    return frameQueue.length
  }) as typeof requestAnimationFrame
  origin = document.createElement('div')
  origin.setAttribute('data-studio-board-origin', '')
  // Board (0, 0) at client (0, 0), zoom 2: client px ÷ 2 = board units.
  origin.getBoundingClientRect = () => ({ left: 0, top: 0, width: 2000, height: 2000, right: 2000, bottom: 2000, x: 0, y: 0, toJSON: () => ({}) })
  document.body.append(origin)
  createCanvasLayer.mockClear()
  const page = makePage({ id: 'page-1', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeInlineEdit: null,
    canvasTool: 'pen',
    createCanvasLayer,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  origin?.remove()
  globalThis.requestAnimationFrame = realRaf
  useEditorStore.setState({ canvasTool: 'move', createCanvasLayer: realCreate } as Parameters<typeof useEditorStore.setState>[0])
})

function mountPen(): HTMLElement {
  const transformLayer = document.createElement('div')
  document.body.append(transformLayer)
  const ref = createRef<HTMLDivElement>()
  ;(ref as { current: HTMLDivElement | null }).current = transformLayer
  renderHook(() => useEditorKeyDispatcher())
  const { container } = render(<CanvasPenToolLayer transformLayerRef={ref} />)
  return container.querySelector('[data-canvas-draw-layer="pen"]') as HTMLElement
}

function click(layer: HTMLElement, x: number, y: number, init: Record<string, unknown> = {}): void {
  act(() => {
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: x, clientY: y, ...init })
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: x, clientY: y })
  })
}

function key(init: KeyboardEventInit): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

describe('the pen', () => {
  it('P arms it and P again puts it away', () => {
    useEditorStore.setState({ canvasTool: 'move' } as Parameters<typeof useEditorStore.setState>[0])
    renderHook(() => {
      useEditorKeyDispatcher()
      useCanvasToolShortcuts(true, false)
    })
    key({ key: 'p' })
    expect(useEditorStore.getState().canvasTool).toBe('pen')
    key({ key: 'p' })
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })

  it('three clicks and ⏎ write ONE path, and put the tool away', () => {
    const layer = mountPen()
    click(layer, 20, 20)
    click(layer, 220, 20)
    click(layer, 220, 120)
    key({ key: 'Enter' })
    expect(createCanvasLayer).toHaveBeenCalledTimes(1)
    const [element, at] = createCanvasLayer.mock.calls[0]!
    // Board units are client ÷ 2: (10,10) (110,10) (110,60); stroke pad 1.
    expect(at).toEqual({ x: 9, y: 9 })
    expect(element).toEqual({
      name: 'svg',
      props: {
        width: 102,
        height: 52,
        viewBox: '0 0 102 52',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      children: [{ name: 'path', props: { d: 'M1 1L101 1L101 51' } }],
    })
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })

  it('a drag places a smooth point; clicking the first point closes the path', () => {
    const layer = mountPen()
    click(layer, 0, 0)
    act(() => {
      fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 200, clientY: 0 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 220, clientY: 20 })
      flushFrames()
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 220, clientY: 20 })
    })
    click(layer, 200, 200)
    click(layer, 2, 2) // within 8 screen px of the first point
    expect(createCanvasLayer).toHaveBeenCalledTimes(1)
    const [element] = createCanvasLayer.mock.calls[0]! as [{ children: { props: { d: string } }[] }]
    const d = element.children[0]!.props.d
    expect(d.startsWith('M')).toBe(true)
    expect(d).toContain('C')
    expect(d.endsWith('Z')).toBe(true)
  })

  it('⌘Z takes back the last point without touching the editor undo', () => {
    const layer = mountPen()
    const undo = mock(() => {})
    useEditorStore.setState({ undo } as Parameters<typeof useEditorStore.setState>[0])
    click(layer, 20, 20)
    click(layer, 220, 20)
    click(layer, 220, 120)
    key({ key: 'z', metaKey: true })
    key({ key: 'Enter' })
    expect(undo).not.toHaveBeenCalled()
    const [element] = createCanvasLayer.mock.calls[0]! as [{ children: { props: { d: string } }[] }]
    expect(element.children[0]!.props.d).toBe('M1 1L101 1')
  })

  it('one point and Escape write nothing', () => {
    const layer = mountPen()
    click(layer, 20, 20)
    key({ key: 'Escape' })
    expect(createCanvasLayer).not.toHaveBeenCalled()
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })
})
