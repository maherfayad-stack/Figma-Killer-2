/**
 * selectOnPress — the press ring on PARENT-document chrome (SB-4).
 *
 * The press arrives as an event inside the frame's document; the ring it
 * restyles is the frame's hover ring, which lives beside the iframe. The press
 * reaches it through `window.frameElement` and `frameChromeRegistry`, and places
 * it from the frame's rect index when the hover was not on the pressed layer —
 * with no element read and no write inside the frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { registerFrameChrome } from '@site/canvas/frameChromeRegistry'
import { getFrameLocalGeometry } from '@site/canvas/frameGeometry/frameGeometryRegistry'
import { flushPressQueue, selectOnPress } from '@site/canvas/pressRing'
import { useEditorStore } from '@site/store/store'

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let timers: Array<{ id: number; ms: number; run: () => void }>
let nextId: number

interface FakeFrameWindow {
  win: Window
  frames: Array<() => void>
}

/** The frame's window as `selectOnPress` sees it: a rAF queue, key listeners, and the iframe element it lives in. */
function fakeFrameWindow(iframe: HTMLIFrameElement): FakeFrameWindow {
  const frames: Array<() => void> = []
  const win = {
    frameElement: iframe,
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window
  return { win, frames }
}

function pressedElement(win: Window): Element {
  return { ownerDocument: { defaultView: win } } as unknown as Element
}

function rectOf(x: number, y: number, width: number, height: number) {
  return { x, y, width, height }
}

class StubAdapter {
  on(): () => void {
    return () => {}
  }
  measureAll() {
    return Promise.resolve({
      origin: { x: 0, y: 0 },
      truncated: false,
      nodes: [
        { nodeId: 'root', rect: rectOf(0, 0, 400, 600), parent: -1, clips: false, inert: false, transformed: false, paint: 0 },
        { nodeId: 'card', rect: rectOf(20, 30, 120, 60), parent: 0, clips: false, inert: false, transformed: false, paint: 0 },
      ],
    })
  }
  measureAllNow() {
    return null
  }
  asAdapter(): FrameDocumentAdapter {
    return this as unknown as FrameDocumentAdapter
  }
}

let iframe: HTMLIFrameElement
let ring: HTMLElement
let unregisterChrome: () => void

beforeEach(async () => {
  timers = []
  nextId = 1
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = nextId
    nextId += 1
    timers.push({ id, ms, run })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout

  document.body.innerHTML = ''
  iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  ring = document.createElement('div')
  ring.setAttribute('data-canvas-hover-ring', 'true')
  ring.style.display = 'none'
  document.body.appendChild(ring)
  unregisterChrome = registerFrameChrome(iframe, { hoverRing: () => ring })
  registerFrameAdapter(iframe, new StubAdapter().asAdapter(), 'studio')
  await getFrameLocalGeometry(iframe)
  useEditorStore.setState({ selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  flushPressQueue()
  unregisterChrome()
  unregisterFrameAdapter(iframe)
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

describe('selectOnPress — the frame\'s hover ring, in the parent document', () => {
  it('a press on a layer the hover was NOT on places the ring from the rect index and shows it as a selection ring', () => {
    const { win } = fakeFrameWindow(iframe)
    let selected = 0
    selectOnPress(pressedElement(win), 'card', () => {
      selected += 1
    })

    expect(selected).toBe(0)
    expect(ring.getAttribute('data-canvas-press-ring')).toBe('true')
    expect(ring.getAttribute('data-canvas-overlay-node-id')).toBe('card')
    expect(ring.style.display).toBe('')
    expect(ring.style.transform).toBe('translate(20px, 30px)')
    expect(ring.style.width).toBe('120px')
    expect(ring.style.height).toBe('60px')
  })

  it('a hover already on the pressed layer is only restyled: the attribute, no placement', () => {
    ring.setAttribute('data-canvas-overlay-node-id', 'card')
    ring.style.display = ''
    ring.style.transform = 'translate(1px, 2px)'
    const { win } = fakeFrameWindow(iframe)
    selectOnPress(pressedElement(win), 'card', () => {})

    expect(ring.getAttribute('data-canvas-press-ring')).toBe('true')
    expect(ring.style.transform).toBe('translate(1px, 2px)')
  })

  it('the selection runs one paint later, and the ring goes back to a hover ring once the real one has had its frames', () => {
    const { win, frames } = fakeFrameWindow(iframe)
    let selected = 0
    selectOnPress(pressedElement(win), 'card', () => {
      selected += 1
      useEditorStore.setState({ selectedNodeIds: ['card'] } as Parameters<typeof useEditorStore.setState>[0])
    })
    expect(selected).toBe(0)

    // The press paints; then the queue runs in one task.
    frames.shift()!()
    flushPressQueue()
    expect(selected).toBe(1)
    // The real ring gets two frames before the borrowed one is handed back.
    expect(ring.hasAttribute('data-canvas-press-ring')).toBe(true)
    frames.shift()!()
    frames.shift()!()
    expect(ring.hasAttribute('data-canvas-press-ring')).toBe(false)
  })

  it('without a ring to borrow, or an index to place it from, the press selects at once', () => {
    const { win } = fakeFrameWindow(iframe)
    unregisterChrome()
    let selected = 0
    selectOnPress(pressedElement(win), 'card', () => {
      selected += 1
    })
    expect(selected).toBe(1)
    expect(ring.hasAttribute('data-canvas-press-ring')).toBe(false)

    unregisterChrome = registerFrameChrome(iframe, { hoverRing: () => ring })
    selectOnPress(pressedElement(win), 'ghost-node-with-no-box', () => {
      selected += 1
    })
    expect(selected).toBe(2)
    expect(ring.hasAttribute('data-canvas-press-ring')).toBe(false)
  })
})
