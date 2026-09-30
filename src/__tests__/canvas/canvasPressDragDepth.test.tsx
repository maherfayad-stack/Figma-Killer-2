/**
 * Press-and-drag moves the layer the press MEANS, in both frame kinds.
 *
 * The owner, verbatim: "I can't drag and drop components that have a click
 * state, because the state triggers first. Same with containers: when I click
 * and drag, it selects children before going to the next step."
 *
 * Three defects behind that, each pinned here at the hook the gesture lives in
 * (the canvas DOM is inside an iframe; `iframeCanvasQuery.ts`):
 *
 *  1. A press on anything rendering a real `<button>` / `<input>` never opened
 *     a drag: `useCanvasFormControlSuppression` cancels the press first (so the
 *     control cannot focus), and the body-drag trigger bailed on
 *     `defaultPrevented`. The control's "click state" was all that happened.
 *  2. The drag carried the INNERMOST element under the pointer, so pressing a
 *     selected container's child dragged — and selected — the child.
 *  3. A Tier 2 (bridge) frame, every project's default, had no press-drag at
 *     all: its presses arrive as runtime `pointer` messages nothing read.
 *
 * Plus the release: the click a drag's pointerup raises must not re-select.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { canvasPressBecameDrag, takeCanvasPressDrag } from '@site/canvas/canvasNodeGestureLatch'
import type { DropCandidateGeometry, FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const FRAME_LEFT = 100
const FRAME_TOP = 50
const FRAME_WIDTH = 400
const FRAME_HEIGHT = 300

type Box = { left: number; top: number; width: number; height: number }

/**
 * body → screen → card → [title, cta (a real <button>)]
 *               → other
 */
const LAYOUT: Record<string, { parent: string | null; tag: string; box: Box }> = {
  body: { parent: null, tag: 'div', box: { left: 0, top: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT } },
  screen: { parent: 'body', tag: 'main', box: { left: 0, top: 0, width: FRAME_WIDTH, height: 300 } },
  card: { parent: 'screen', tag: 'section', box: { left: 0, top: 0, width: FRAME_WIDTH, height: 200 } },
  title: { parent: 'card', tag: 'h2', box: { left: 0, top: 0, width: FRAME_WIDTH, height: 100 } },
  cta: { parent: 'card', tag: 'button', box: { left: 0, top: 100, width: FRAME_WIDTH, height: 100 } },
  other: { parent: 'screen', tag: 'p', box: { left: 0, top: 200, width: FRAME_WIDTH, height: 100 } },
}

function seedSite() {
  const node = (id: string, moduleId: string, children: string[] = []) => makeNode({ id, moduleId, children })
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: 'body',
          nodes: {
            body: node('body', 'base.body', ['screen']),
            screen: node('screen', 'base.container', ['card', 'other']),
            card: node('card', 'base.container', ['title', 'cta']),
            title: node('title', 'base.text'),
            cta: node('cta', 'base.button'),
            other: node('other', 'base.text'),
          },
        }),
      ],
    }),
  )
}

function stubRect(el: Element, { left, top, width, height }: Box) {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect
}

interface Harness {
  iframe: HTMLIFrameElement
  frameDoc: Document
  overlayRoot: HTMLElement
  viewport: HTMLElement
  nodes: Record<string, HTMLElement>
}

function mountFrame(): Harness {
  const viewport = document.createElement('div')
  stubRect(viewport, { left: FRAME_LEFT, top: FRAME_TOP, width: FRAME_WIDTH, height: FRAME_HEIGHT })
  document.body.appendChild(viewport)
  const iframe = document.createElement('iframe')
  viewport.appendChild(iframe)
  const frameDoc = iframe.contentDocument!
  stubRect(iframe, { left: FRAME_LEFT, top: FRAME_TOP, width: FRAME_WIDTH, height: FRAME_HEIGHT })
  Object.defineProperty(iframe, 'clientWidth', { value: FRAME_WIDTH, configurable: true })
  Object.defineProperty(iframe, 'clientHeight', { value: FRAME_HEIGHT, configurable: true })
  Object.defineProperty(iframe, 'offsetWidth', { value: FRAME_WIDTH, configurable: true })

  const overlayRoot = frameDoc.createElement('div')
  overlayRoot.setAttribute('data-studio-canvas-overlay-root', 'true')
  frameDoc.body.appendChild(overlayRoot)

  const nodes: Record<string, HTMLElement> = {}
  for (const [id, { parent, tag, box }] of Object.entries(LAYOUT)) {
    const el = frameDoc.createElement(tag)
    el.setAttribute('data-node-id', id)
    stubRect(el, box)
    ;(parent ? nodes[parent]! : frameDoc.body).appendChild(el)
    nodes[id] = el
  }
  return { iframe, frameDoc, overlayRoot, viewport, nodes }
}

/** A native pointerdown in the FRAME document, iframe-local coordinates. */
function pressInFrame(target: Element, localX: number, localY: number, init: { metaKey?: boolean; alreadyCancelled?: boolean } = {}) {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, pointerId: 7, clientX: localX, clientY: localY, metaKey: init.metaKey ?? false })
  // What `useCanvasFormControlSuppression` does to every press on an authored
  // control, in the same capture phase, before the drag trigger hears it.
  if (init.alreadyCancelled) event.preventDefault()
  target.dispatchEvent(event)
}

function dispatchWindowPointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  window.dispatchEvent(event)
}

function selectOnly(...ids: string[]) {
  useEditorStore.setState({ selectedNodeId: ids.at(-1) ?? null, selectedNodeIds: ids, selectedNodeFrameId: null } as Parameters<
    typeof useEditorStore.setState
  >[0])
}

let harness: Harness

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    enteredInstanceIds: [],
    activeInlineEdit: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  seedSite()
  harness = mountFrame()
  takeCanvasPressDrag()
})

afterEach(() => {
  cleanup()
  unregisterFrameAdapter(harness.iframe)
  document.body.innerHTML = ''
})

function renderDrag(options: { overlayRoot?: HTMLElement | null; bridgeAdapter?: FrameDocumentAdapter | null } = {}) {
  const viewportRef = { current: harness.viewport }
  // The frame's adapter reaches the hook the way it does in the overlay:
  // through `BreakpointFrame`'s context.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CanvasFrameAdapterContext.Provider value={options.bridgeAdapter ?? null}>{children}</CanvasFrameAdapterContext.Provider>
  )
  return renderHook(
    () =>
      useCanvasReorderDrag({
        viewportRef,
        canvasRootRef: viewportRef,
        iframeElement: harness.iframe,
        overlayRoot: options.overlayRoot === undefined ? harness.overlayRoot : options.overlayRoot,
        selectedNodeIds: useEditorStore.getState().selectedNodeIds,
        frameId: null,
        enabled: true,
        bodyDragEnabled: true,
        panBy: () => {},
      }),
    { wrapper },
  )
}

describe('a portal frame — the press drags the layer it means', () => {
  it('a component rendering a real <button> can be dragged by its body (its press is cancelled first)', () => {
    const { result } = renderDrag()
    act(() => pressInFrame(harness.nodes.cta!, 20, 120, { alreadyCancelled: true }))
    act(() => dispatchWindowPointer('pointermove', 160, 200))
    // Was false: the cancelled press never opened a session, so the button's
    // own pressed state was all the gesture ever did.
    expect(result.current.dragging).toBe(true)
  })

  it('with nothing selected, a press on a nested element drags its top-level layer — not the child', () => {
    const { result } = renderDrag()
    act(() => pressInFrame(harness.nodes.title!, 20, 20))
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
    act(() => dispatchWindowPointer('pointermove', 160, 110))
    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['card'])
  })

  it('pressing a child of the SELECTED container drags the container and leaves the selection alone', () => {
    selectOnly('card')
    const { result } = renderDrag()
    act(() => pressInFrame(harness.nodes.title!, 20, 20))
    act(() => dispatchWindowPointer('pointermove', 160, 110))
    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['card'])
  })

  it('⌘ held drags the innermost layer', () => {
    selectOnly('card')
    const { result } = renderDrag()
    act(() => pressInFrame(harness.nodes.title!, 20, 20, { metaKey: true }))
    act(() => dispatchWindowPointer('pointermove', 160, 110))
    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['title'])
  })

  it('marks the press as a drag once it activates, so its release click selects nothing — and the next press clears it', () => {
    renderDrag()
    act(() => pressInFrame(harness.nodes.title!, 20, 20))
    expect(canvasPressBecameDrag()).toBe(false)
    act(() => dispatchWindowPointer('pointermove', 160, 110))
    act(() => dispatchWindowPointer('pointerup', 160, 110))
    expect(canvasPressBecameDrag()).toBe(true)

    act(() => pressInFrame(harness.nodes.other!, 20, 220))
    expect(canvasPressBecameDrag()).toBe(false)
  })

  it('a press that stays a click is not a drag', () => {
    renderDrag()
    act(() => pressInFrame(harness.nodes.title!, 20, 20))
    act(() => dispatchWindowPointer('pointerup', 121, 70))
    expect(canvasPressBecameDrag()).toBe(false)
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })
})

describe('a bridge (Tier 2) frame — the press arrives as a runtime message', () => {
  type Handler = (event: FrameRuntimeEvent) => void

  function fakeBridgeAdapter(candidates: DropCandidateGeometry[]) {
    const handlers = new Set<Handler>()
    let measured = 0
    const adapter = {
      on: (type: string, handler: Handler) => {
        if (type !== 'pointer') return () => {}
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      measureDropCandidates: () => {
        measured += 1
        return Promise.resolve(candidates)
      },
    } as unknown as FrameDocumentAdapter
    const down = (nodeId: string, localX: number, localY: number, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => {
      const event = {
        type: 'pointer',
        phase: 'down',
        nodeId,
        occurrenceIndex: 0,
        rect: null,
        clientX: localX,
        clientY: localY,
        screenX: 0,
        screenY: 0,
        modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers },
        ancestors: [],
        button: 0,
        buttons: 1,
        pointerId: 7,
        pointerType: 'mouse',
      } as unknown as FrameRuntimeEvent
      for (const handler of handlers) handler(event)
    }
    return { adapter, down, measuredCount: () => measured }
  }

  it('a press-and-move on a live frame opens the same drag session, on the layer the press means', async () => {
    const bridge = fakeBridgeAdapter([])
    registerFrameAdapter(harness.iframe, bridge.adapter, 'desktop')
    const { result } = renderDrag({ overlayRoot: null, bridgeAdapter: bridge.adapter })

    await act(async () => {
      bridge.down('title', 20, 20)
      // The trigger runs after every other listener of the message.
      await Promise.resolve()
    })
    // The candidates come over the wire, not from a DOM scan.
    expect(bridge.measuredCount()).toBe(1)
    act(() => dispatchWindowPointer('pointermove', 160, 110))
    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['card'])
    act(() => dispatchWindowPointer('pointerup', 160, 110))
    expect(canvasPressBecameDrag()).toBe(true)
  })

  it('inside the selected container, the live press drags the container', async () => {
    selectOnly('card')
    const bridge = fakeBridgeAdapter([])
    registerFrameAdapter(harness.iframe, bridge.adapter, 'desktop')
    const { result } = renderDrag({ overlayRoot: null, bridgeAdapter: bridge.adapter })
    await act(async () => {
      bridge.down('cta', 20, 120)
      await Promise.resolve()
    })
    act(() => dispatchWindowPointer('pointermove', 160, 200))
    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['card'])
  })
})
