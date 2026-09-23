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
import { useEditorStore } from '@site/store/store'


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
  const startTextEditCalls: Array<[nodeId: string, allowed: boolean, text: string | undefined]> = []
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
    startTextEdit: (nodeId: string, allowed: boolean, text?: string) => {
      startTextEditCalls.push([nodeId, allowed, text])
    },
  } as unknown as FrameDocumentAdapter
  const emit = (event: FrameRuntimeEvent) => handlers.get(event.type)?.forEach((h) => h(event))
  return {
    adapter,
    emit,
    startTextEditCalls,
    subscriptions: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  }
}

function Harness({ adapter, isActive = true, onActivate = () => {} }: { adapter: FrameDocumentAdapter; isActive?: boolean; onActivate?: (breakpointId: string) => void }) {
  useBridgeFrameInteraction(adapter, { breakpointId: 'bp-mobile', frameId: 'frame-1', isActive, onActivate })
  return null
}

const MODS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
/** A primary-button mouse press, as the runtime reports one. `screenX/screenY` default to 0 — irrelevant off the pan-replay path (`live-19`). */
const MOUSE = { button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', screenX: 0, screenY: 0 }
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
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/Home.tsx:3:4', rect: null, clientX: 1, clientY: 2, modifiers: { ...MODS, metaKey: true }, ...MOUSE })
    emit({ type: 'pointer', phase: 'click', nodeId: null, rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/Home.tsx:5:6', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
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
    registerFrameAdapter(iframe, adapter, 'bp-mobile')
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
    emit({ type: 'pointer', phase: 'down', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
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
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
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
    // pointer, wheel, resize:commit, text:editStart, text:commit, text:cancel
    expect(first.subscriptions()).toBe(6)
    view.unmount()
    expect(first.subscriptions()).toBe(0)
  })

  // `live-13` — a pan press inside the frame is the canvas's gesture, replayed
  // on the iframe element so `useCanvas`'s drag handler sees it.
  //
  // `live-19` — the `move`/`up` assertions below are deliberately written
  // with `clientX`/`clientY` values that do NOT match a rect-based
  // recomputation (999/-50 rather than the frame-local point a naive
  // conversion would produce a sane-looking number from): if the
  // implementation ever regresses to reading them, these numbers would fail
  // loudly instead of silently passing on a coincidence.
  it('replays a middle-button press, its moves and its release on the iframe element as a screenX/screenY delta from the down point, and drops the click that follows', () => {
    const { adapter, emit } = makeFakeAdapter()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    // The frame is drawn at half scale: 200 css px of a 400 px wide viewport.
    iframe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 300, right: 300, bottom: 350, x: 100, y: 50, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    registerFrameAdapter(iframe, adapter, 'bp-mobile')
    const seen: PointerEvent[] = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) document.addEventListener(type, (e) => seen.push(e as PointerEvent))
    const order: string[] = []
    render(
      <CanvasSelectionContext.Provider value={{ ...NO_SELECTION, onFrameNodeClick: (id) => order.push(`select:${id}`), onNodePointerDown: (id) => order.push(`down:${id}`), onNodeHover: (id) => order.push(`hover:${id}`) }}>
        <Harness adapter={adapter} isActive={false} onActivate={(bp) => order.push(`activate:${bp}`)} />
      </CanvasSelectionContext.Provider>,
    )
    const MIDDLE = { button: 1, buttons: 4, pointerId: 7, pointerType: 'mouse' }
    // down: converted ONCE from the frame-local point through the iframe's rect.
    emit({ type: 'pointer', phase: 'down', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 40, clientY: 60, screenX: 500, screenY: 700, modifiers: MODS, ...MIDDLE })
    // move: the hardware pointer moved +80 screen px right, 0 vertically. Its
    // frame-local clientX (999) is nonsense on purpose — see the `it` doc.
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 999, clientY: 999, screenX: 580, screenY: 700, modifiers: MODS, ...MIDDLE, button: -1 })
    // up: +40 more screen px right from the move (120 total from down).
    emit({ type: 'pointer', phase: 'up', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: -50, clientY: -50, screenX: 620, screenY: 700, modifiers: MODS, ...MIDDLE, buttons: 0 })
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 80, clientY: 60, screenX: 620, screenY: 700, modifiers: MODS, ...MIDDLE, buttons: 0 })
    expect(seen.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointerup'])
    expect(seen.every((e) => e.target === iframe && e.pointerId === 7)).toBe(true)
    expect(seen[0].button).toBe(1)
    // down: 100 + 40*0.5 = 120.
    expect(seen[0].clientX).toBe(120)
    // move: down's 120 + (580 - 500) screen delta = 200 — NOT 100 + 999*0.5.
    expect(seen[1].clientX).toBe(200)
    // up: down's 120 + (620 - 500) = 240 — NOT 100 + -50*0.5.
    expect(seen[2].clientX).toBe(240)
    // Neither the press nor the click that ended the pan touched selection or activation…
    expect(order).toEqual([])
    // …and the next ordinary click does.
    emit({ type: 'pointer', phase: 'click', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE })
    expect(order).toEqual(['activate:bp-mobile', 'select:pages/SMS.tsx:41:8'])
    // A move from a different pointer while nothing is panning is a hover, as before.
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...MOUSE, button: -1, buttons: 0 })
    expect(order.at(-1)).toBe('hover:pages/SMS.tsx:41:8')
    unregisterFrameAdapter(iframe)
  })

  // `live-19` — the disproven "pin the rect" fix's own failure mode: once the
  // canvas is actually panning, the FRAME's on-screen rect drifts mid-gesture
  // (here simulated the same way that attempt's test did — the rect moves
  // +80px between `down` and the first `move`) — and the corrected,
  // screen-delta-based replay must be UNAFFECTED by that drift, because it
  // never reads the rect again after `down`.
  it('is unaffected by the iframe rect drifting mid-pan (the disproven pinned-rect fix\'s own failure mode)', () => {
    const { adapter, emit } = makeFakeAdapter()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    let left = 100
    iframe.getBoundingClientRect = () => ({ left, top: 50, width: 200, height: 300, right: left + 200, bottom: 350, x: left, y: 50, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    registerFrameAdapter(iframe, adapter, 'bp-mobile')
    const seen: PointerEvent[] = []
    for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) document.addEventListener(type, (e) => seen.push(e as PointerEvent))
    render(
      <CanvasSelectionContext.Provider value={NO_SELECTION}>
        <Harness adapter={adapter} isActive />
      </CanvasSelectionContext.Provider>,
    )
    const MIDDLE = { button: 1, buttons: 4, pointerId: 7, pointerType: 'mouse' }
    emit({ type: 'pointer', phase: 'down', nodeId: null, rect: null, clientX: 40, clientY: 60, screenX: 500, screenY: 700, modifiers: MODS, ...MIDDLE })
    // The rect drifts +80px — an intervening rAF-deferred `applyTransformToDOM`
    // pan write landing between the two runtime messages, exactly as it would
    // for real (`speed-03`'s cross-realm coalescing delay).
    left = 180
    // The mouse did not physically move (screenX unchanged) — the correct
    // replayed point is therefore IDENTICAL to the down point, regardless of
    // where the iframe's rect has drifted to.
    emit({ type: 'pointer', phase: 'move', nodeId: null, rect: null, clientX: 40, clientY: 60, screenX: 500, screenY: 700, modifiers: MODS, ...MIDDLE, button: -1 })
    expect(seen[0].clientX).toBe(100 + 40 * 0.5)
    expect(seen[1].clientX).toBe(seen[0].clientX)
    unregisterFrameAdapter(iframe)
  })

  // `live-19` — continuous pan: several `move`s in a row, each advancing
  // `screenX` while the frame's own `clientX` stays pinned at the down's
  // value (the frame is chasing the mouse, so its local report of the
  // pointer stops advancing — the exact failure mode that sank the
  // pinned-rect fix). The replayed points must still advance smoothly.
  it('advances the replayed point continuously across several moves, driven by screenX alone', () => {
    const { adapter, emit } = makeFakeAdapter()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    iframe.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    registerFrameAdapter(iframe, adapter, 'bp-mobile')
    const seen: PointerEvent[] = []
    for (const type of ['pointerdown', 'pointermove'] as const) document.addEventListener(type, (e) => seen.push(e as PointerEvent))
    render(
      <CanvasSelectionContext.Provider value={NO_SELECTION}>
        <Harness adapter={adapter} isActive />
      </CanvasSelectionContext.Provider>,
    )
    const MIDDLE = { button: 1, buttons: 4, pointerId: 7, pointerType: 'mouse' }
    emit({ type: 'pointer', phase: 'down', nodeId: null, rect: null, clientX: 50, clientY: 50, screenX: 1000, screenY: 1000, modifiers: MODS, ...MIDDLE })
    // Three moves, frame-local clientX PINNED at the down's value (the frame
    // is chasing the mouse) while screenX advances 10, 20, 30.
    for (const dx of [10, 20, 30]) {
      emit({ type: 'pointer', phase: 'move', nodeId: null, rect: null, clientX: 50, clientY: 50, screenX: 1000 + dx, screenY: 1000, modifiers: MODS, ...MIDDLE, button: -1 })
    }
    expect(seen.map((e) => e.clientX)).toEqual([50, 60, 70, 80])
    unregisterFrameAdapter(iframe)
  })

  // `speed-06` — a drag that started OUTSIDE this frame entirely (an
  // asset-card drag) and whose pointer has now moved inside this bridge
  // frame's iframe: the runtime's own `pointer` messages must be replayed on
  // the iframe element (so the PARENT's `window` drag-session listeners see
  // them), never routed to hover/selection.
  it('replays a relayed drag\'s moves and release on the iframe element, never as hover/selection', () => {
    const { adapter, emit } = makeFakeAdapter()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    iframe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 300, right: 300, bottom: 350, x: 100, y: 50, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    registerFrameAdapter(iframe, adapter)
    const seen: PointerEvent[] = []
    for (const type of ['pointermove', 'pointerup'] as const) document.addEventListener(type, (e) => seen.push(e as PointerEvent))
    const order: string[] = []
    render(
      <CanvasSelectionContext.Provider value={{ ...NO_SELECTION, onNodeHover: (id) => order.push(`hover:${id}`), onNodePointerUp: (id) => order.push(`up:${id}`) }}>
        <Harness adapter={adapter} />
      </CanvasSelectionContext.Provider>,
    )
    document.documentElement.dataset.studioCanvasDragging = '1'
    document.documentElement.dataset.studioCanvasDraggingPointerId = '9'
    const RELAY = { button: -1, buttons: 1, pointerId: 9, pointerType: 'mouse', screenX: 0, screenY: 0 }
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 40, clientY: 60, modifiers: MODS, ...RELAY })
    emit({ type: 'pointer', phase: 'up', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 80, clientY: 60, modifiers: MODS, ...RELAY, buttons: 0 })
    delete document.documentElement.dataset.studioCanvasDragging
    delete document.documentElement.dataset.studioCanvasDraggingPointerId

    expect(seen.map((e) => e.type)).toEqual(['pointermove', 'pointerup'])
    expect(seen.every((e) => e.target === iframe && e.pointerId === 9)).toBe(true)
    expect(seen[0].clientX).toBe(100 + 40 * 0.5)
    expect(seen[1].clientX).toBe(100 + 80 * 0.5)
    // Neither move nor up reached the frame's own hover/selection handlers.
    expect(order).toEqual([])

    // With the relay flag cleared, the SAME pointer id's move is an ordinary hover again.
    emit({ type: 'pointer', phase: 'move', nodeId: 'pages/SMS.tsx:41:8', rect: null, clientX: 1, clientY: 2, modifiers: MODS, ...RELAY })
    expect(order).toEqual(['hover:pages/SMS.tsx:41:8'])
    unregisterFrameAdapter(iframe)
  })

  it('commits a resize the frame finished through setNodeInlineStyles', () => {
    const { adapter, emit } = makeFakeAdapter()
    const commits: unknown[] = []
    useEditorStore.setState({ setNodeInlineStyles: (nodeId: string, patch: unknown) => commits.push([nodeId, patch]) } as Parameters<typeof useEditorStore.setState>[0])
    render(
      <CanvasSelectionContext.Provider value={NO_SELECTION}>
        <Harness adapter={adapter} />
      </CanvasSelectionContext.Provider>,
    )
    emit({ type: 'resize:commit', nodeId: 'pages/SMS.tsx:41:8', patch: { width: '240px' } })
    expect(commits).toEqual([['pages/SMS.tsx:41:8', { width: '240px' }]])
  })

  // `live-18` — the frame asks (`text:editStart`), the store decides through
  // the SAME `startInlineEdit` predicate the portal double-click handler
  // uses, and the reply crosses back through `adapter.startTextEdit`.
  describe('inline text edit', () => {
    afterEach(() => {
      useEditorStore.setState({ activeInlineEdit: null } as Parameters<typeof useEditorStore.setState>[0])
    })

    it('an allowed text:editStart replies with the seeded text from the new session', () => {
      const { adapter, emit, startTextEditCalls } = makeFakeAdapter()
      const startCalls: unknown[] = []
      useEditorStore.setState({
        startInlineEdit: (nodeId: string, breakpointId: string, frameId?: string | null) => {
          startCalls.push([nodeId, breakpointId, frameId])
          useEditorStore.setState({
            activeInlineEdit: {
              nodeId,
              prop: 'text',
              breakpointId,
              frameId: frameId ?? null,
              localeOverride: null,
              multiline: false,
              initialValue: 'canonical text',
              committed: false,
            },
          } as Parameters<typeof useEditorStore.setState>[0])
          return true
        },
      } as Parameters<typeof useEditorStore.setState>[0])
      render(
        <CanvasSelectionContext.Provider value={NO_SELECTION}>
          <Harness adapter={adapter} />
        </CanvasSelectionContext.Provider>,
      )
      emit({ type: 'text:editStart', nodeId: 'pages/SMS.tsx:41:8' })
      expect(startCalls).toEqual([['pages/SMS.tsx:41:8', 'bp-mobile', 'frame-1']])
      expect(startTextEditCalls).toEqual([['pages/SMS.tsx:41:8', true, 'canonical text']])
    })

    it('a refused text:editStart replies with allowed: false and no text', () => {
      const { adapter, emit, startTextEditCalls } = makeFakeAdapter()
      useEditorStore.setState({ startInlineEdit: () => false } as Parameters<typeof useEditorStore.setState>[0])
      render(
        <CanvasSelectionContext.Provider value={NO_SELECTION}>
          <Harness adapter={adapter} />
        </CanvasSelectionContext.Provider>,
      )
      emit({ type: 'text:editStart', nodeId: 'pages/SMS.tsx:41:8' })
      expect(startTextEditCalls).toEqual([['pages/SMS.tsx:41:8', false, undefined]])
    })

    it('text:commit for the active session applies the value and ends the session', () => {
      const { adapter, emit } = makeFakeAdapter()
      const applied: unknown[] = []
      let ended = 0
      useEditorStore.setState({
        activeInlineEdit: {
          nodeId: 'pages/SMS.tsx:41:8',
          prop: 'text',
          breakpointId: 'bp-mobile',
          frameId: 'frame-1',
          localeOverride: null,
          multiline: false,
          initialValue: 'x',
          committed: false,
        },
        applyInlineEditValue: (value: string) => applied.push(value),
        endInlineEdit: () => { ended += 1 },
      } as Parameters<typeof useEditorStore.setState>[0])
      render(
        <CanvasSelectionContext.Provider value={NO_SELECTION}>
          <Harness adapter={adapter} />
        </CanvasSelectionContext.Provider>,
      )
      emit({ type: 'text:commit', nodeId: 'pages/SMS.tsx:41:8', text: 'new text' })
      expect(applied).toEqual(['new text'])
      expect(ended).toBe(1)
    })

    it('text:commit for a node that no longer matches the active session is ignored', () => {
      const { adapter, emit } = makeFakeAdapter()
      const applied: unknown[] = []
      useEditorStore.setState({
        activeInlineEdit: {
          nodeId: 'some-other-node',
          prop: 'text',
          breakpointId: 'bp-mobile',
          frameId: 'frame-1',
          localeOverride: null,
          multiline: false,
          initialValue: 'x',
          committed: false,
        },
        applyInlineEditValue: (value: string) => applied.push(value),
      } as Parameters<typeof useEditorStore.setState>[0])
      render(
        <CanvasSelectionContext.Provider value={NO_SELECTION}>
          <Harness adapter={adapter} />
        </CanvasSelectionContext.Provider>,
      )
      emit({ type: 'text:commit', nodeId: 'pages/SMS.tsx:41:8', text: 'new text' })
      expect(applied).toHaveLength(0)
    })

    it('text:cancel for the active session reverts through cancelInlineEdit', () => {
      const { adapter, emit } = makeFakeAdapter()
      let cancelled = 0
      useEditorStore.setState({
        activeInlineEdit: {
          nodeId: 'pages/SMS.tsx:41:8',
          prop: 'text',
          breakpointId: 'bp-mobile',
          frameId: 'frame-1',
          localeOverride: null,
          multiline: false,
          initialValue: 'x',
          committed: false,
        },
        cancelInlineEdit: () => { cancelled += 1 },
      } as Parameters<typeof useEditorStore.setState>[0])
      render(
        <CanvasSelectionContext.Provider value={NO_SELECTION}>
          <Harness adapter={adapter} />
        </CanvasSelectionContext.Provider>,
      )
      emit({ type: 'text:cancel', nodeId: 'pages/SMS.tsx:41:8' })
      expect(cancelled).toBe(1)
    })
  })
})
