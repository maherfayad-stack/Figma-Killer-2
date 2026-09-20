/**
 * `live-12` — the parent half of clicking and zooming through a Tier 2 bridge
 * frame. A fake adapter stands in for `BridgeFrameAdapter` (only `on` is
 * exercised) and is registered under a real `<iframe>` element, which is how
 * the hook finds the element to re-dispatch a wheel on.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { CanvasSelectionContext } from '@site/canvas/CanvasContexts'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { useBridgeFrameInteraction } from '@site/canvas/BoardFramesLayer/useBridgeFrameInteraction'


// happy-dom has no `WheelEvent`; the runtime and the hook construct one. A
// `MouseEvent` carrying the four delta fields is all either of them reads.
class TestWheelEvent extends MouseEvent {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaZ: number
  readonly deltaMode: number
  constructor(type: string, init: MouseEventInit & { deltaX?: number; deltaY?: number; deltaZ?: number; deltaMode?: number } = {}) {
    super(type, init)
    this.deltaX = init.deltaX ?? 0
    this.deltaY = init.deltaY ?? 0
    this.deltaZ = init.deltaZ ?? 0
    this.deltaMode = init.deltaMode ?? 0
  }
}
if (typeof WheelEvent === 'undefined') Object.assign(globalThis, { WheelEvent: TestWheelEvent })

type Handler = (event: FrameRuntimeEvent) => void

function makeFakeAdapter() {
  const handlers = new Map<string, Set<Handler>>()
  const adapter = {
    on: (type: string, handler: Handler) => {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    },
  } as unknown as FrameDocumentAdapter
  const emit = (event: FrameRuntimeEvent) => handlers.get(event.type)?.forEach((h) => h(event))
  return { adapter, emit, subscriptions: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) }
}

function Harness({ adapter, isActive = true, onActivate = () => {} }: { adapter: FrameDocumentAdapter; isActive?: boolean; onActivate?: (breakpointId: string) => void }) {
  useBridgeFrameInteraction(adapter, { breakpointId: 'bp-mobile', frameId: 'frame-1', isActive, onActivate })
  return null
}

const MODS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
const NO_SELECTION = { onNodeClick: () => {}, onFrameNodeClick: () => {}, onNodeHover: () => {}, onNodeContextMenu: () => {}, onNodeDoubleClick: () => {}, onNodePointerDown: () => {}, onNodePointerUp: () => {} }

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useBridgeFrameInteraction', () => {
  it('routes a forwarded click to onFrameNodeClick with the frame and breakpoint it came from, and a move to hover', () => {
    const { adapter, emit } = makeFakeAdapter()
    const clicks: unknown[] = []
    const hovers: unknown[] = []
    const value = {
      onNodeClick: () => {},
      onFrameNodeClick: (...args: unknown[]) => clicks.push(args),
      onNodeHover: (...args: unknown[]) => hovers.push(args),
      onNodeContextMenu: () => {},
      onNodeDoubleClick: () => {},
      onNodePointerDown: () => {},
      onNodePointerUp: () => {},
    }
    render(
      <CanvasSelectionContext.Provider value={value}>
        <Harness adapter={adapter} />
      </CanvasSelectionContext.Provider>,
    )
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/Home.tsx:3:4', rect: null, clientX: 1, clientY: 2, modifiers: { ...MODS, metaKey: true } })
    emit({ type: 'pointer', phase: 'click', nodeId: null, rect: null, clientX: 1, clientY: 2, modifiers: MODS })
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/Home.tsx:5:6', rect: null, clientX: 1, clientY: 2, modifiers: MODS })
    expect(clicks).toEqual([['pages/Home.tsx:3:4', { ...MODS, metaKey: true }, 'bp-mobile', 'frame-1']])
    expect(hovers).toEqual([['pages/Home.tsx:5:6', 'bp-mobile', 'frame-1']])
  })

  it('re-dispatches a forwarded wheel on the iframe element in parent client pixels, modifiers intact', () => {
    const { adapter, emit } = makeFakeAdapter()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    // The frame is drawn at half scale: 200 css px of a 400 px wide viewport.
    iframe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 300, right: 300, bottom: 350, x: 100, y: 50, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    registerFrameAdapter(iframe, adapter)
    const seen: WheelEvent[] = []
    document.addEventListener('wheel', (e) => seen.push(e))

    render(
      <CanvasSelectionContext.Provider value={{ onNodeClick: () => {}, onFrameNodeClick: () => {}, onNodeHover: () => {}, onNodeContextMenu: () => {}, onNodeDoubleClick: () => {}, onNodePointerDown: () => {}, onNodePointerUp: () => {} }}>
        <Harness adapter={adapter} />
      </CanvasSelectionContext.Provider>,
    )
    emit({ type: 'wheel', deltaX: 0, deltaY: -120, deltaMode: 0, clientX: 40, clientY: 60, modifiers: { ...MODS, ctrlKey: true } })
    expect(seen).toHaveLength(1)
    expect(seen[0].target).toBe(iframe)
    expect(seen[0].deltaY).toBe(-120)
    expect(seen[0].ctrlKey).toBe(true)
    expect(seen[0].clientX).toBe(100 + 40 * 0.5)
    expect(seen[0].clientY).toBe(50 + 60 * 0.5)
    unregisterFrameAdapter(iframe)
  })

  it('activates an inactive frame on press and on click, before the selection runs', () => {
    const { adapter, emit } = makeFakeAdapter()
    const order: string[] = []
    render(
      <CanvasSelectionContext.Provider value={{ ...NO_SELECTION, onFrameNodeClick: (id) => order.push(`select:${id}`) }}>
        <Harness adapter={adapter} isActive={false} onActivate={(bp) => order.push(`activate:${bp}`)} />
      </CanvasSelectionContext.Provider>,
    )
    emit({ type: 'pointer', phase: 'down', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS })
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS })
    expect(order).toEqual(['activate:bp-mobile', 'activate:bp-mobile', 'select:pages/SMS.tsx:41:8'])
  })

  it('leaves an active frame alone', () => {
    const { adapter, emit } = makeFakeAdapter()
    let activated = 0
    render(
      <CanvasSelectionContext.Provider value={NO_SELECTION}>
        <Harness adapter={adapter} isActive onActivate={() => { activated += 1 }} />
      </CanvasSelectionContext.Provider>,
    )
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS })
    expect(activated).toBe(0)
  })

  it('unsubscribes when the adapter goes away', () => {
    const first = makeFakeAdapter()
    const value = { onNodeClick: () => {}, onFrameNodeClick: () => {}, onNodeHover: () => {}, onNodeContextMenu: () => {}, onNodeDoubleClick: () => {}, onNodePointerDown: () => {}, onNodePointerUp: () => {} }
    const view = render(
      <CanvasSelectionContext.Provider value={value}>
        <Harness adapter={first.adapter} />
      </CanvasSelectionContext.Provider>,
    )
    expect(first.subscriptions()).toBe(2)
    view.unmount()
    expect(first.subscriptions()).toBe(0)
  })
})
