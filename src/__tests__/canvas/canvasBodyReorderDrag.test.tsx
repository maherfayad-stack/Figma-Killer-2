/**
 * useCanvasReorderDrag — pressing an element's OWN BODY starts the drag.
 *
 * The reported bug: "when clicking an element and dragging (not from the icon)
 * it doesn't drag". It was accurate and it was not a regression — the canvas
 * reorder drag had exactly ONE activation point, the selection toolbar's
 * hand-grab icon (`SelectionToolbar.tsx`'s `onDragPointerDown`). Pressing the
 * element itself only ever selected it: `NodeRenderer`'s only pointer hook is
 * `onPointerDownCapture` for focus + form-control suppression, and nothing
 * anywhere listened for a press on a node in order to move it. So a press on
 * the body opened no session, and every pointermove after it was inert.
 *
 * These cases pin the second activation point down at the layer the gesture
 * actually lives at — the hook — because the canvas DOM is inside an iframe and
 * a component-level test could not press it (`iframeCanvasQuery.ts`).
 *
 * The frame geometry is deliberately OFFSET from the parent document's origin.
 * A press inside an iframe reports iframe-local coordinates, but every
 * subsequent pointermove reaches the hook's `window` listeners in PARENT client
 * coordinates (natively once the cursor leaves the frame, or translated by
 * `IframeFrameSurface`'s relay while it is inside). Storing the raw local point
 * as the drag origin would therefore make the very first move look like a jump
 * of the whole iframe offset — instantly past the 4px activation distance — so
 * a plain click would become a drag again. `translates the press ...` is that
 * assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

/** Where the frame's iframe element sits in the parent document. */
const FRAME_LEFT = 100
const FRAME_TOP = 50
const FRAME_WIDTH = 400
const FRAME_HEIGHT = 300

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
}

function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  const { left, top, width, height } = rect
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect
}

interface Harness {
  iframe: HTMLIFrameElement
  frameDoc: Document
  overlayRoot: HTMLElement
  viewport: HTMLElement
  /** `[data-node-id]` elements inside the frame document, by node id. */
  nodes: Record<string, HTMLElement>
}

/**
 * A real iframe with a real content document, a node element per page node, and
 * the design-mode overlay root the hook uses as its design-frame gate.
 */
function mountFrame(): Harness {
  const viewport = document.createElement('div')
  stubRect(viewport, { left: FRAME_LEFT, top: FRAME_TOP, width: FRAME_WIDTH, height: FRAME_HEIGHT })
  document.body.appendChild(viewport)

  const iframe = document.createElement('iframe')
  viewport.appendChild(iframe)
  const frameDoc = iframe.contentDocument!
  stubRect(iframe, { left: FRAME_LEFT, top: FRAME_TOP, width: FRAME_WIDTH, height: FRAME_HEIGHT })
  // `iframeLocalPointToParentClientPoint` scales by rect/viewport size; keeping
  // them equal makes the frame unzoomed, so the translation is a pure offset.
  Object.defineProperty(iframe, 'clientWidth', { value: FRAME_WIDTH, configurable: true })
  Object.defineProperty(iframe, 'clientHeight', { value: FRAME_HEIGHT, configurable: true })
  Object.defineProperty(iframe, 'offsetWidth', { value: FRAME_WIDTH, configurable: true })

  const overlayRoot = frameDoc.createElement('div')
  overlayRoot.setAttribute('data-studio-canvas-overlay-root', 'true')
  frameDoc.body.appendChild(overlayRoot)

  const nodes: Record<string, HTMLElement> = {}
  const layout: Record<string, { left: number; top: number; width: number; height: number }> = {
    root: { left: 0, top: 0, width: FRAME_WIDTH, height: 200 },
    a: { left: 0, top: 0, width: FRAME_WIDTH, height: 100 },
    b: { left: 0, top: 100, width: FRAME_WIDTH, height: 100 },
  }
  const rootEl = frameDoc.createElement('div')
  rootEl.setAttribute('data-node-id', 'root')
  stubRect(rootEl, layout.root!)
  frameDoc.body.appendChild(rootEl)
  nodes.root = rootEl
  for (const id of ['a', 'b']) {
    const el = frameDoc.createElement('div')
    el.setAttribute('data-node-id', id)
    stubRect(el, layout[id]!)
    rootEl.appendChild(el)
    nodes[id] = el
  }

  return { iframe, frameDoc, overlayRoot, viewport, nodes }
}

/** A native pointerdown in the FRAME document — iframe-local coordinates. */
function pressInFrame(target: Element, localX: number, localY: number) {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, pointerId: 7, clientX: localX, clientY: localY })
  target.dispatchEvent(event)
  return event
}

/** A pointer event on the parent `window` — PARENT client coordinates. */
function dispatchWindowPointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 7, button: 0 })
  window.dispatchEvent(event)
}

let harness: Harness

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeInlineEdit: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  seedSite()
  harness = mountFrame()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function renderDrag(overrides: { bodyDragEnabled?: boolean; overlayRoot?: HTMLElement | null } = {}) {
  const viewportRef = { current: harness.viewport }
  const canvasRootRef = { current: harness.viewport }
  return renderHook(() =>
    useCanvasReorderDrag({
      viewportRef,
      canvasRootRef,
      iframeElement: harness.iframe,
      overlayRoot: overrides.overlayRoot === undefined ? harness.overlayRoot : overrides.overlayRoot,
      selectedNodeIds: useEditorStore.getState().selectedNodeIds,
      frameId: null,
      enabled: true,
      bodyDragEnabled: overrides.bodyDragEnabled ?? true,
      panBy: () => {},
    }),
  )
}

describe('useCanvasReorderDrag — pressing the element body', () => {
  it('starts a drag from a press on the element itself, not just the toolbar handle', () => {
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    // Still a click at this point — the activation distance has not been cleared.
    expect(result.current.dragging).toBe(false)

    act(() => {
      // The press was at parent (120, 70); this is 40px to the right of it.
      dispatchWindowPointer('pointermove', 160, 70)
    })

    // This is the whole bug: before the body-drag path existed, no session was
    // ever opened here and `dragging` stayed false forever.
    expect(result.current.dragging).toBe(true)

    act(() => {
      dispatchWindowPointer('pointerup', 160, 70)
    })
    expect(result.current.dragging).toBe(false)
  })

  it('translates the press from iframe-local to parent client coordinates', () => {
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    act(() => {
      // Parent (122, 71) is 2.2px from the real origin (120, 70) — under the
      // 4px activation distance, so this is still a click. If the origin had
      // been stored as the raw iframe-local (20, 20), the same move would read
      // as ~102px of travel and this press would have become a drag.
      dispatchWindowPointer('pointermove', 122, 71)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('selects the pressed element when the drag activates, not when it is pressed', () => {
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.b!, 20, 120)
    })
    // A press that may still turn out to be a click must not pre-empt
    // NodeRenderer's own click-to-select (which owns the Cmd/Shift modifiers).
    expect(useEditorStore.getState().selectedNodeId).toBeNull()

    act(() => {
      dispatchWindowPointer('pointermove', 160, 170)
    })

    expect(result.current.dragging).toBe(true)
    expect(useEditorStore.getState().selectedNodeId).toBe('b')
  })

  it('drags the whole selection when the press lands inside it', () => {
    useEditorStore.setState({ selectedNodeId: 'a', selectedNodeIds: ['a', 'b'] } as Parameters<
      typeof useEditorStore.setState
    >[0])
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.b!, 20, 120)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 170)
    })

    expect(result.current.dragging).toBe(true)
    // Not collapsed to just the pressed node.
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a', 'b'])
  })

  it('stands down while an inline text edit owns the pointer', () => {
    useEditorStore.setState({
      activeInlineEdit: { nodeId: 'a', breakpointId: 'desktop', frameId: null },
    } as Parameters<typeof useEditorStore.setState>[0])
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 70)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('ignores presses on editor chrome portaled into the same frame document', () => {
    const { result } = renderDrag()
    const handle = harness.frameDoc.createElement('div')
    handle.setAttribute('data-canvas-resize-handle', 'se')
    harness.overlayRoot.appendChild(handle)

    act(() => {
      pressInFrame(handle, 20, 20)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 70)
    })

    // A resize is `useElementResizeDrag`'s gesture; this hook must not claim it.
    expect(result.current.dragging).toBe(false)
  })

  it('never drags the root node', () => {
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.root!, 20, 190)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 240)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('does not arm at all in a frame with no design-mode overlay root (live view)', () => {
    const { result } = renderDrag({ overlayRoot: null })

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 70)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('does not arm without structural edit permission', () => {
    const { result } = renderDrag({ bodyDragEnabled: false })

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 160, 70)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('commits nothing when the press never clears the activation distance', () => {
    const before = useEditorStore.getState().site!.pages[0]!.nodes.root!.children
    const { result } = renderDrag()

    act(() => {
      pressInFrame(harness.nodes.a!, 20, 20)
    })
    act(() => {
      dispatchWindowPointer('pointermove', 122, 71)
    })
    act(() => {
      dispatchWindowPointer('pointerup', 122, 71)
    })

    expect(result.current.dragging).toBe(false)
    expect(useEditorStore.getState().site!.pages[0]!.nodes.root!.children).toEqual(before)
    expect(useEditorStore.getState().selectedNodeId).toBeNull()
  })
})
