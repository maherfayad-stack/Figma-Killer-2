/**
 * Live-frame parity — gestures fixed in static (portal) frames in Phase 1 and
 * 2, driven here through the in-frame runtime's own message dispatch
 * (`createStudioRuntimeBridge`), the way a Tier 2 live frame receives them:
 *
 *  - canvas-23: a resize carries the Fixed companions the parent's stored
 *    markers imply, and no height is reported while the W×H badge hangs
 *    under the element;
 *  - canvas-26: a resize edge snaps to the tree siblings the parent names,
 *    and the guides go back over the wire;
 *  - store-17: `optimistic.revert` puts back exactly the nodes a refused
 *    write hid or moved, and nothing else;
 *  - canvas-24: a double-click's request carries its stamped ancestors, and a
 *    reply naming the ancestor edits the ancestor.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createStudioRuntimeBridge, LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS, type StudioRuntimeBridge } from '@core/studio-runtime'

const PARENT_ORIGIN = 'https://parent.test'
const BOX = 'pages/Home.tsx:3:4'

let bridge: StudioRuntimeBridge | null = null
let restoreScrollHeight: (() => void) | null = null

afterEach(() => {
  bridge?.dispose()
  bridge = null
  restoreScrollHeight?.()
  restoreScrollHeight = null
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
  document.head.querySelectorAll('style').forEach((el) => el.remove())
})

function boot(): Array<Record<string, unknown>> {
  const posted: Array<Record<string, unknown>> = []
  const parentWindow = { postMessage: (data: { message: Record<string, unknown> }) => posted.push(data.message) } as unknown as Window
  bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow, document })
  bridge.handleMessage({ type: 'setMode', mode: 'design' })
  return posted
}

function placeAt(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}

function stamped(nodeId: string, style = ''): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-node-id', nodeId)
  el.setAttribute('style', style)
  return el
}

function pointerEvent(type: string, init: MouseEventInit): Event {
  const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
  return new Ctor(type, { bubbles: true, cancelable: true, ...(type === 'pointermove' ? { buttons: 1 } : {}), ...init })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('live frame — resize parity (canvas-23, canvas-26)', () => {
  it('a flex:1 item goes Fixed: the commit carries the companion the stored marker implies', () => {
    const posted = boot()
    const row = stamped('pages/Home.tsx:2:2', 'display: flex; width: 600px')
    const box = stamped(BOX, 'flex: 1; width: 100px; height: 40px; box-sizing: border-box')
    row.appendChild(box)
    document.body.appendChild(row)
    placeAt(box, 0, 0, 100, 40)
    bridge!.handleMessage({ type: 'setResizeTarget', ref: { nodeId: BOX, occurrenceIndex: 0 }, proportional: false, sizing: { flex: '1' } })
    const east = document.querySelector<HTMLElement>('[data-canvas-resize-handle="e"]')!
    east.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 20, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 20 }))
    document.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 20 }))
    expect(posted.filter((m) => m.type === 'resize:commit')).toEqual([
      { type: 'resize:commit', nodeId: BOX, occurrenceIndex: 0, patch: { flex: null, width: '140px' } },
    ])
  })

  it('the east edge snaps to a sibling the parent named, and the guides cross the wire', async () => {
    const posted = boot()
    const box = stamped(BOX, 'width: 100px; height: 50px; box-sizing: border-box')
    const sibling = stamped('pages/Home.tsx:4:4')
    document.body.append(box, sibling)
    placeAt(box, 0, 0, 100, 50)
    placeAt(sibling, 110, 0, 100, 50)
    bridge!.handleMessage({
      type: 'setResizeTarget',
      ref: { nodeId: BOX, occurrenceIndex: 0 },
      proportional: false,
      snap: { siblings: [{ nodeId: 'pages/Home.tsx:4:4', occurrenceIndex: 0 }], parent: null, zoom: 1 },
    })
    const east = document.querySelector<HTMLElement>('[data-canvas-resize-handle="e"]')!
    east.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 20, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 206, clientY: 20 }))
    await sleep(40)
    document.dispatchEvent(pointerEvent('pointerup', { clientX: 206, clientY: 20 }))
    expect(posted.filter((m) => m.type === 'resize:guides')).toEqual([
      { type: 'resize:guides', guides: [{ axis: 'x', position: 210, start: 0, end: 50 }] },
      { type: 'resize:guides', guides: [] },
    ])
    expect(posted.filter((m) => m.type === 'resize:commit').map((m) => m.patch)).toEqual([{ width: '210px' }])
  })

  it('reports no height while the badge hangs under the element, and one after the drag', async () => {
    const posted = boot()
    const box = stamped(BOX, 'width: 100px; height: 40px; box-sizing: border-box')
    document.body.appendChild(box)
    placeAt(box, 0, 0, 100, 40)
    bridge!.handleMessage({ type: 'setResizeTarget', ref: { nodeId: BOX, occurrenceIndex: 0 }, proportional: false })
    // The badge overflows the body while a drag is live — the one thing the
    // body's scrollHeight grows by here.
    const resizing = () => document.querySelector('[data-canvas-resizing]') !== null
    const descriptor = Object.getOwnPropertyDescriptor(document.body, 'scrollHeight')
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, get: () => (resizing() ? 930 : 900) })
    restoreScrollHeight = () => {
      if (descriptor) Object.defineProperty(document.body, 'scrollHeight', descriptor)
      else delete (document.body as { scrollHeight?: number }).scrollHeight
    }
    await sleep(LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS + 60)
    const heights = () => posted.filter((m) => m.type === 'frame:resize').map((m) => m.height)
    expect(heights().at(-1)).toBe(900)

    const east = document.querySelector<HTMLElement>('[data-canvas-resize-handle="e"]')!
    east.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 20, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 130, clientY: 20 }))
    // The app churns a node mid-drag (a carousel, a clock) — the frame-fit
    // reset that follows would measure the badge.
    const dot = document.createElement('span')
    document.body.appendChild(dot)
    await sleep(0)
    dot.remove()
    await sleep(LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS + 60)
    expect(heights()).not.toContain(930)

    document.dispatchEvent(pointerEvent('pointerup', { clientX: 130, clientY: 20 }))
    await sleep(40)
    expect(heights()).not.toContain(930)
    expect(heights().at(-1)).toBe(900)
  })
})

describe('live frame — a refused structural write is taken back (store-17)', () => {
  it('optimistic.revert un-hides and un-moves exactly the named nodes', () => {
    boot()
    document.body.innerHTML = [
      '<div data-node-id="list">',
      '<p data-node-id="a">A</p><p data-node-id="b">B</p><p data-node-id="c">C</p>',
      '</div>',
    ].join('')
    bridge!.handleMessage({ type: 'optimistic.delete', nodeId: 'a', occurrenceIndex: 0 })
    bridge!.handleMessage({ type: 'optimistic.delete', nodeId: 'b', occurrenceIndex: 0 })
    bridge!.handleMessage({ type: 'optimistic.move', nodeId: 'c', occurrenceIndex: 0, parentNodeId: 'list', parentOccurrenceIndex: 0, index: 0 })
    const order = () => [...document.querySelectorAll('[data-node-id="list"] > p')].map((p) => p.getAttribute('data-node-id'))
    expect(order()).toEqual(['c', 'a', 'b'])

    bridge!.handleMessage({ type: 'optimistic.revert', refs: [{ nodeId: 'a', occurrenceIndex: 0 }, { nodeId: 'c', occurrenceIndex: 0 }] })

    expect(order()).toEqual(['a', 'b', 'c'])
    expect(document.querySelector('[data-node-id="a"]')!.hasAttribute('data-studio-optimistic-hidden')).toBe(false)
    // A second gesture whose write is still in flight keeps its preview.
    expect(document.querySelector('[data-node-id="b"]')!.hasAttribute('data-studio-optimistic-hidden')).toBe(true)
  })
})

describe('live frame — a double-click names what a click names (canvas-24)', () => {
  it('the request carries the stamped chain, and a reply naming the ancestor edits the ancestor', () => {
    const posted = boot()
    document.body.innerHTML =
      '<button data-node-id="pages/Home.tsx:5:7"><span data-node-id="design-system/components/Button.jsx:99:6">Label</span></button>'
    const inner = document.querySelector<HTMLElement>('span')!
    const outer = document.querySelector<HTMLElement>('button')!
    inner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(posted.filter((m) => m.type === 'text:editStart')).toEqual([
      {
        type: 'text:editStart',
        nodeId: 'design-system/components/Button.jsx:99:6',
        occurrenceIndex: 0,
        ancestors: [
          { nodeId: 'design-system/components/Button.jsx:99:6', occurrenceIndex: 0 },
          { nodeId: 'pages/Home.tsx:5:7', occurrenceIndex: 0 },
        ],
      },
    ])
    bridge!.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:7', occurrenceIndex: 0, allowed: true, text: 'Label' })
    expect(outer.getAttribute('contenteditable')).not.toBeNull()
    expect(inner.getAttribute('contenteditable')).toBeNull()
  })
})
