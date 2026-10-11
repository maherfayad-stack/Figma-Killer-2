/**
 * A LIVE (Tier 2 bridge) frame reaches parity with a portal frame for the two
 * gestures a portal frame owns in the parent's own tree:
 *
 *  - a text drawn with the text tool, or Enter on a selected text, opens for
 *    editing — the store session starts and the runtime is asked to open the
 *    editor in the frame (`beginTextEdit`), which the text:commit it answers
 *    with closes;
 *  - a sweep that starts on the frame's background selects the layers it
 *    touches (`useBridgeFrameMarquee`), the same rule as the portal marquee.
 *
 * A fake adapter stands in for `BridgeFrameAdapter` where only `on` and a
 * handful of calls are read; the text start goes through a real one on a stub
 * channel, because `startCanvasTextEdit` tells a bridge frame by its class.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import '@modules/base'
import { toOutboundEnvelope, type InboundEnvelope } from '@core/studio-runtime'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { startCanvasTextEdit } from '@site/canvas/canvasTextEditStart'
import { useBridgeFrameMarquee } from '@site/canvas/useBridgeFrameMarquee'
import { canvasPressBecameDrag, beginCanvasPress } from '@site/canvas/canvasNodeGestureLatch'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

const FRAME_ORIGIN = 'https://live.studio.test'

const page = () =>
  makePage({
    id: 'page-1',
    rootNodeId: 'body',
    nodes: {
      body: makeNode({ id: 'body', moduleId: 'base.body', children: ['screen'] }),
      screen: makeNode({ id: 'screen', moduleId: 'base.container', children: ['a', 'b', 'c'] }),
      a: makeNode({ id: 'a', moduleId: 'base.text', props: { text: 'A' } }),
      b: makeNode({ id: 'b', moduleId: 'base.text', props: { text: 'B' } }),
      c: makeNode({ id: 'c', moduleId: 'base.text', props: { text: 'C' } }),
    },
  })

beforeEach(() => {
  useEditorStore.setState({
    site: makeSite({ pages: [page()] }),
    activePageId: 'page-1',
    selectedNodeId: null,
    selectedNodeIds: [],
    canvasTool: 'move',
    activeInlineEdit: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  useEditorStore.setState({ activeInlineEdit: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
})

describe('a text started in a live frame', () => {
  function mountBridgeFrame(ready: boolean) {
    const posted: InboundEnvelope[] = []
    const channel: BridgeFrameChannel = {
      postMessage: (message) => {
        posted.push(message as InboundEnvelope)
      },
      addEventListener: (type, handler) => {
        if (type === 'message' && ready) handler({ origin: FRAME_ORIGIN, source: undefined, data: toOutboundEnvelope({ type: 'ready' }) } as MessageEvent)
      },
      removeEventListener: () => {},
    }
    const adapter = new BridgeFrameAdapter({ channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['body', 'screen', 'a', 'b', 'c'] })
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-frame-id', 'frame-1')
    const iframe = document.createElement('iframe')
    iframe.setAttribute('data-breakpoint-id', 'studio')
    wrapper.appendChild(iframe)
    document.body.appendChild(wrapper)
    registerFrameAdapter(iframe, adapter, 'studio')
    return { adapter, posted, dispose: () => unregisterFrameAdapter(iframe) }
  }

  it('opens: the session starts in the board frame and the runtime is asked to open the editor', () => {
    const { adapter, posted, dispose } = mountBridgeFrame(true)
    expect(startCanvasTextEdit('a', 'frame-1', { selectAll: true })).toBe(true)
    expect(useEditorStore.getState().activeInlineEdit).toMatchObject({ nodeId: 'a', frameId: 'frame-1', initialValue: 'A', selectAll: true })
    expect(posted.at(-1)!.message).toEqual({ type: 'text:edit', nodeId: 'a', occurrenceIndex: 0, allowed: true, text: 'A', begin: true })
    adapter.dispose()
    dispose()
  })

  it('does not reach into a frame that has not said ready (its portal fallback is the one on screen)', () => {
    const { adapter, posted, dispose } = mountBridgeFrame(false)
    expect(startCanvasTextEdit('a', 'frame-1')).toBe(false)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(posted).toEqual([])
    adapter.dispose()
    dispose()
  })

  it('does not open a node that is not text', () => {
    const { adapter, dispose } = mountBridgeFrame(true)
    expect(startCanvasTextEdit('screen', 'frame-1')).toBe(false)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    adapter.dispose()
    dispose()
  })
})

describe('the marquee in a live frame', () => {
  type Handler = (event: FrameRuntimeEvent) => void
  const MODS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
  const MOUSE = { button: 0, pointerId: 1, pointerType: 'mouse', screenX: 0, screenY: 0 }

  function fakeAdapter() {
    const handlers = new Set<Handler>()
    const adapter = {
      on: (type: string, handler: Handler) => {
        if (type === 'pointer') handlers.add(handler)
        return () => handlers.delete(handler)
      },
      // a: 0-100, b: 120-220, c: 240-340 (vertical, 200 wide).
      measureDropCandidates: () =>
        Promise.resolve([
          { nodeId: 'a', occurrenceIndex: 0, rect: { x: 0, y: 0, width: 200, height: 100 }, axis: 'vertical', reversed: false, childRects: [] },
          { nodeId: 'b', occurrenceIndex: 0, rect: { x: 0, y: 120, width: 200, height: 100 }, axis: 'vertical', reversed: false, childRects: [] },
          { nodeId: 'c', occurrenceIndex: 0, rect: { x: 0, y: 240, width: 200, height: 100 }, axis: 'vertical', reversed: false, childRects: [] },
        ]),
    } as unknown as FrameDocumentAdapter
    const emit = (phase: 'down' | 'move' | 'up', nodeId: string | null, x: number, y: number, buttons = 1, modifiers = MODS) => {
      for (const handler of handlers) {
        handler({ type: 'pointer', phase, nodeId, rect: null, clientX: x, clientY: y, modifiers, buttons, ...MOUSE } as FrameRuntimeEvent)
      }
    }
    return { adapter, emit }
  }

  function Harness({ adapter, iframe }: { adapter: FrameDocumentAdapter; iframe: HTMLIFrameElement }) {
    return (
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <Probe iframe={iframe} />
      </CanvasFrameAdapterContext.Provider>
    )
  }
  function Probe({ iframe }: { iframe: HTMLIFrameElement }) {
    useBridgeFrameMarquee({ enabled: true, iframeElement: iframe, pageId: 'page-1', frameId: 'frame-1' })
    return null
  }

  function mount() {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    iframe.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    Object.defineProperty(iframe, 'clientWidth', { value: 400 })
    Object.defineProperty(iframe, 'clientHeight', { value: 600 })
    const { adapter, emit } = fakeAdapter()
    render(<Harness adapter={adapter} iframe={iframe} />)
    return { emit }
  }

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })

  it('a sweep from the page background selects the layers it touches, and clears its box on release', async () => {
    const { emit } = mount()
    beginCanvasPress()
    await act(async () => {
      emit('down', 'body', 300, 10)
      emit('move', 'body', 301, 12)
    })
    // Under the threshold nothing has started.
    expect(document.querySelector('[style*="--marquee-x"]')).toBeNull()
    await act(async () => {
      emit('move', 'body', 50, 130)
    })
    await settle()
    // The sweep from (300,10) to (50,130) touches a (0-100) and b (120-220).
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a', 'b'])
    expect(document.querySelector('[style*="--marquee-x"]')).not.toBeNull()
    // The release's click must not undo it.
    expect(canvasPressBecameDrag()).toBe(true)
    await act(async () => {
      emit('move', 'body', 50, 250)
    })
    await settle()
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a', 'b', 'c'])
    await act(async () => {
      emit('up', 'body', 50, 250, 0)
    })
    expect(document.querySelector('[style*="--marquee-x"]')).toBeNull()
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a', 'b', 'c'])
  })

  it('a press on a layer is not a marquee', async () => {
    const { emit } = mount()
    beginCanvasPress()
    await act(async () => {
      emit('down', 'a', 10, 10)
      emit('move', 'a', 300, 300)
    })
    await settle()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
    expect(document.querySelector('[style*="--marquee-x"]')).toBeNull()
  })

  it('⌘-drag stays free move: no marquee', async () => {
    const { emit } = mount()
    beginCanvasPress()
    await act(async () => {
      emit('down', 'body', 300, 10, 1, { ...MODS, metaKey: true })
      emit('move', 'body', 50, 250, 1, { ...MODS, metaKey: true })
    })
    await settle()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })
})
