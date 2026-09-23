/**
 * `createStudioRuntimeBridge` — dispatch-logic tests drive `handleMessage`
 * directly (no postMessage transport involved); a smaller set of tests
 * exercises the actual `window.addEventListener('message', …)` pipeline with
 * constructed `MessageEvent`s so the origin/source/envelope checks are
 * covered too. Real cross-origin `postMessage` timing and a real iframe are
 * NOT exercised here — see `STATE.md`'s `live-04` handoff, "Pending dogfood".
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  createStudioRuntimeBridge,
  DEFAULT_FRAME_FIT_HEIGHT,
  LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
  RUNTIME_MESSAGE_SOURCE,
  type StudioRuntimeBridge,
} from '@core/studio-runtime'

const PARENT_ORIGIN = 'https://parent.test'

function makeFakeParentWindow() {
  const posted: Array<{ data: unknown; origin: string }> = []
  const fakeWindow = {
    postMessage: (data: unknown, origin: string) => posted.push({ data, origin }),
  } as unknown as Window
  return { fakeWindow, posted }
}


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

let bridge: StudioRuntimeBridge | null = null

afterEach(() => {
  bridge?.dispose()
  bridge = null
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-source], style[data-studio-overlay-id]').forEach((el) => el.remove())
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.documentElement.removeAttribute('data-studio-scheme')
  document.documentElement.removeAttribute('data-theme')
  document.body.style.position = ''
})

describe('createStudioRuntimeBridge — boot', () => {
  it('posts ready immediately', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    expect(posted).toHaveLength(1)
    expect((posted[0]!.data as { message: { type: string } }).message.type).toBe('ready')
    expect(posted[0]!.origin).toBe(PARENT_ORIGIN)
  })
})

describe('createStudioRuntimeBridge — overlay stylesheets', () => {
  it('applyOverlay mounts a style element, removeOverlay removes it', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'applyOverlay', id: 'test-overlay', css: '.x { color: red }' })
    const el = document.querySelector('[data-studio-overlay-id="test-overlay"]')
    expect(el?.textContent).toBe('.x { color: red }')

    bridge.handleMessage({ type: 'removeOverlay', id: 'test-overlay' })
    expect(document.querySelector('[data-studio-overlay-id="test-overlay"]')).toBeNull()
  })

  it('re-applying the same id updates the existing element rather than stacking a new one', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'applyOverlay', id: 'dup', css: 'a' })
    bridge.handleMessage({ type: 'applyOverlay', id: 'dup', css: 'b' })

    expect(document.querySelectorAll('[data-studio-overlay-id="dup"]')).toHaveLength(1)
    expect(document.querySelector('[data-studio-overlay-id="dup"]')?.textContent).toBe('b')
  })
})

describe('createStudioRuntimeBridge — setMode', () => {
  it('design mode starts hover-suppression/scroll-unroll/animation-freeze; live mode stops them', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    expect(document.getElementById('studio-runtime-scroll-unroll')).not.toBeNull()
    expect(document.getElementById('studio-runtime-animation-freeze')).not.toBeNull()

    bridge.handleMessage({ type: 'setMode', mode: 'live' })
    expect(document.getElementById('studio-runtime-scroll-unroll')).toBeNull()
    expect(document.getElementById('studio-runtime-animation-freeze')).toBeNull()
  })

  it('is idempotent — re-sending the same mode does not double-mount', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })

    expect(document.querySelectorAll('#studio-runtime-scroll-unroll')).toHaveLength(1)
  })
})

describe('createStudioRuntimeBridge — selection / hover rings', () => {
  it('select creates a ring element per node id and removes rings for deselected nodes', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div><div data-node-id="n2"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }, { nodeId: 'n2', occurrenceIndex: 0 }] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(2)

    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(1)

    bridge.handleMessage({ type: 'select', refs: [] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('hides a ring for a node id that does not exist in the DOM, without throwing', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    expect(() => bridge!.handleMessage({ type: 'select', refs: [{ nodeId: 'missing', occurrenceIndex: 0 }] })).not.toThrow()
    const ring = document.querySelector('[data-canvas-selection-ring]') as HTMLElement | null
    expect(ring?.style.display).toBe('none')
  })

  it('hover creates/positions a single ring and null clears it', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'hover', nodeId: 'n1', occurrenceIndex: 0 })
    expect(document.querySelectorAll('[data-canvas-hover-ring]')).toHaveLength(1)

    bridge.handleMessage({ type: 'hover', nodeId: null, occurrenceIndex: 0 })
    expect((document.querySelector('[data-canvas-hover-ring]') as HTMLElement).style.display).toBe('none')
  })

  it('mounts exactly one overlay root even across multiple select calls', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })
    bridge.handleMessage({ type: 'select', refs: [] })
    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })

    expect(document.querySelectorAll('#studio-canvas-selection-overlay-root')).toHaveLength(1)
  })
})

describe('createStudioRuntimeBridge — setAxes', () => {
  it('writes dir/lang/data-studio-scheme/data-theme/color-scheme', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'setAxes', axes: { direction: 'rtl', colorScheme: 'dark' } })

    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
    expect(document.documentElement.getAttribute('data-studio-scheme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('clears lang for ltr', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'setAxes', axes: { direction: 'rtl', colorScheme: 'light' } })
    bridge.handleMessage({ type: 'setAxes', axes: { direction: 'ltr', colorScheme: 'light' } })

    expect(document.documentElement.hasAttribute('lang')).toBe(false)
  })
})

describe('createStudioRuntimeBridge — optimistic DOM ops', () => {
  it('insert creates an element via createElement + textContent, never innerHTML', () => {
    document.body.innerHTML = `<div data-node-id="parent"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({
      type: 'optimistic.insert',
      nodeId: 'new1',
      parentNodeId: 'parent',
      parentOccurrenceIndex: 0,
      index: 0,
      tagName: 'span',
      text: '<img onerror=alert(1)>',
    })

    const inserted = document.querySelector('[data-node-id="new1"]')
    expect(inserted?.tagName).toBe('SPAN')
    // The "text" is stored as literal text content, never parsed as markup.
    expect(inserted?.textContent).toBe('<img onerror=alert(1)>')
    expect(inserted?.querySelector('img')).toBeNull()
  })

  it.each(['script', 'SCRIPT', 'Script', 'iframe', 'embed', 'object', 'link', 'base', 'style', 'frame', 'frameset'])(
    'refuses to insert a dangerous element (%s), in any case',
    (tagName) => {
      document.body.innerHTML = `<div data-node-id="parent"></div>`
      const { fakeWindow } = makeFakeParentWindow()
      bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

      bridge.handleMessage({
        type: 'optimistic.insert',
        nodeId: 'new1',
        parentNodeId: 'parent',
        parentOccurrenceIndex: 0,
        index: 0,
        tagName,
        text: undefined,
      })

      expect(document.querySelector('[data-node-id="new1"]')).toBeNull()
      expect(document.body.querySelector('script, iframe, embed, object, link, base, style, frame, frameset')).toBeNull()
    },
  )

  // `live-14` — a detached node broke React's next reconciliation and took
  // the sibling below with it; a delete hides, and the update puts it back.
  it('delete hides the element through a stylesheet rule, never detaches it or touches its inline style', () => {
    document.body.innerHTML = `<div data-node-id="gone" style="color: red"></div><div data-node-id="below"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.delete', nodeId: 'gone', occurrenceIndex: 0 })
    const gone = document.querySelector<HTMLElement>('[data-node-id="gone"]')!
    expect(gone.isConnected).toBe(true)
    expect(gone.hasAttribute('data-studio-optimistic-hidden')).toBe(true)
    expect(gone.getAttribute('style')).toBe('color: red')
    expect(document.getElementById('studio-runtime-optimistic')?.textContent).toContain('[data-studio-optimistic-hidden] { display: none !important; }')
    expect(document.querySelector('[data-node-id="below"]')?.previousElementSibling).toBe(gone)
  })

  it('move re-parents the element at the given index', () => {
    document.body.innerHTML = `
      <div data-node-id="from"><div data-node-id="item"></div></div>
      <div data-node-id="to"></div>
    `
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.move', nodeId: 'item', occurrenceIndex: 0, parentNodeId: 'to', parentOccurrenceIndex: 0, index: 0 })

    const to = document.querySelector('[data-node-id="to"]')
    expect(to?.querySelector('[data-node-id="item"]')).not.toBeNull()
  })

  it('text sets textContent, never innerHTML', () => {
    document.body.innerHTML = `<div data-node-id="t1">old</div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.text', nodeId: 't1', occurrenceIndex: 0, text: '<b>bold</b>' })

    const el = document.querySelector('[data-node-id="t1"]')
    expect(el?.textContent).toBe('<b>bold</b>')
    expect(el?.querySelector('b')).toBeNull()
  })
})

// `speed-01` — a properties-panel style commit/scrub previewed in-frame
// ahead of the file write + HMR round trip.
describe('createStudioRuntimeBridge — optimistic style', () => {
  const STYLE_TAG = 'studio-runtime-optimistic-style'
  const STYLE_ATTR = 'data-studio-optimistic-style'

  function makeFakeHot() {
    const handlers = new Map<string, () => void>()
    return {
      hot: { on: (event: 'vite:beforeUpdate' | 'vite:afterUpdate', cb: () => void) => { handlers.set(event, cb) } },
      fireBeforeUpdate: () => handlers.get('vite:beforeUpdate')?.(),
      fireAfterUpdate: () => handlers.get('vite:afterUpdate')?.(),
    }
  }

  it("applies an inline-target patch as a kebab-cased, !important stylesheet rule, never touching the element's own style", () => {
    document.body.innerHTML = `<div data-node-id="n1" style="color: blue"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({
      type: 'optimistic.style',
      ref: { nodeId: 'n1', occurrenceIndex: 0 },
      patch: { backgroundColor: 'red', width: '100px' },
    })

    const el = document.querySelector<HTMLElement>('[data-node-id="n1"]')!
    expect(el.hasAttribute(STYLE_ATTR)).toBe(true)
    expect(el.getAttribute('style')).toBe('color: blue')
    const sheet = document.getElementById(STYLE_TAG)?.textContent ?? ''
    expect(sheet).toContain('background-color: red !important')
    expect(sheet).toContain('width: 100px !important')
  })

  it('re-applying to the same ref REPLACES its rule rather than appending a second one', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.style', ref: { nodeId: 'n1', occurrenceIndex: 0 }, patch: { color: 'red' } })
    bridge.handleMessage({ type: 'optimistic.style', ref: { nodeId: 'n1', occurrenceIndex: 0 }, patch: { color: 'green' } })

    const sheet = document.getElementById(STYLE_TAG)?.textContent ?? ''
    expect(sheet).not.toContain('red')
    expect(sheet.match(/color:/g)).toHaveLength(1)
    expect(sheet).toContain('color: green !important')
  })

  // A class-target write (`className` present) previews the SAME way an
  // inline write does — `className` is wire-informational only. Studio's
  // parse names a class differently than Vite's own CSS-modules plugin does
  // in the live frame's DOM, so a `.<className>` selector would match
  // nothing there — see `optimisticStyle.ts`'s module doc.
  it('a class-target patch (className present) previews element-scoped too, never as a `.className` selector', () => {
    document.body.innerHTML = `<div data-node-id="n1" class="_page_j4o6g_3"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({
      type: 'optimistic.style',
      ref: { nodeId: 'n1', occurrenceIndex: 0 },
      patch: { color: 'red' },
      className: 'SMS_page__5638d', // Studio's own parse name — deliberately NOT the DOM's real class
    })

    const el = document.querySelector<HTMLElement>('[data-node-id="n1"]')!
    expect(el.hasAttribute(STYLE_ATTR)).toBe(true)
    const sheet = document.getElementById(STYLE_TAG)?.textContent ?? ''
    expect(sheet).toContain('color: red !important')
    expect(sheet).not.toContain('.SMS_page__5638d')
    expect(sheet).not.toContain('._page_j4o6g_3')
  })

  it('clear drops the rule and the attribute for that ref, and no-ops for a ref with nothing active', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'optimistic.style', ref: { nodeId: 'n1', occurrenceIndex: 0 }, patch: { color: 'red' } })

    expect(() =>
      bridge!.handleMessage({ type: 'optimistic.style:clear', ref: { nodeId: 'missing', occurrenceIndex: 0 } }),
    ).not.toThrow()

    bridge.handleMessage({ type: 'optimistic.style:clear', ref: { nodeId: 'n1', occurrenceIndex: 0 } })

    expect(document.querySelector('[data-node-id="n1"]')?.hasAttribute(STYLE_ATTR)).toBe(false)
    expect(document.getElementById(STYLE_TAG)).toBeNull()
  })

  it('vite:beforeUpdate reverts every optimistic style rule and attribute; vite:afterUpdate does the same for a frame that missed the before', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div><div data-node-id="n2" class="card"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    const { hot, fireBeforeUpdate, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })

    bridge.handleMessage({ type: 'optimistic.style', ref: { nodeId: 'n1', occurrenceIndex: 0 }, patch: { color: 'red' } })
    fireBeforeUpdate()
    expect(document.querySelector('[data-node-id="n1"]')?.hasAttribute(STYLE_ATTR)).toBe(false)
    expect(document.getElementById(STYLE_TAG)).toBeNull()

    bridge.handleMessage({
      type: 'optimistic.style',
      ref: { nodeId: 'n2', occurrenceIndex: 0 },
      patch: { color: 'blue' },
      className: 'card',
    })
    fireAfterUpdate()
    expect(document.getElementById(STYLE_TAG)).toBeNull()
    expect(document.querySelector('[data-node-id="n2"]')?.hasAttribute(STYLE_ATTR)).toBe(false)
  })

  it('repositions the selection ring after an apply — inline target and class target both', async () => {
    document.body.innerHTML = `<div data-node-id="n1" class="card"></div>`
    const target = document.querySelector<HTMLElement>('[data-node-id="n1"]')!
    let call = 0
    target.getBoundingClientRect = () => {
      call += 1
      const x = call === 1 ? 0 : call * 10
      return { left: x, top: 0, width: 10, height: 10, right: x + 10, bottom: 10, x, y: 0, toJSON: () => ({}) }
    }
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })
    const ring = document.querySelector<HTMLElement>('[data-canvas-selection-ring]')!
    expect(ring.style.transform).toBe('translate(0px, 0px)')

    bridge.handleMessage({ type: 'optimistic.style', ref: { nodeId: 'n1', occurrenceIndex: 0 }, patch: { color: 'red' } })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(ring.style.transform).not.toBe('translate(0px, 0px)')

    const afterInline = ring.style.transform
    bridge.handleMessage({
      type: 'optimistic.style',
      ref: { nodeId: 'n1', occurrenceIndex: 0 },
      patch: { color: 'blue' },
      className: 'card',
    })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(ring.style.transform).not.toBe(afterInline)
  })
})

describe('createStudioRuntimeBridge — measure', () => {
  it('replies with measure:result carrying a rect and the requested computed-style properties', () => {
    document.body.innerHTML = `<div data-node-id="m1"></div>`
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'measure', requestId: 'req-1', refs: [{ nodeId: 'm1', occurrenceIndex: 0 }], properties: ['display'] })

    const reply = posted.at(-1)!.data as { message: { type: string; requestId: string; measurements: unknown[] } }
    expect(reply.message.type).toBe('measure:result')
    expect(reply.message.requestId).toBe('req-1')
    expect(reply.message.measurements).toHaveLength(1)
    const measurement = reply.message.measurements[0] as { nodeId: string; rect: unknown; computedStyle: Record<string, string> }
    expect(measurement.nodeId).toBe('m1')
    expect(measurement.rect).not.toBeNull()
    expect(Object.keys(measurement.computedStyle)).toContain('display')
  })

  it('reports a null rect for a node id that no longer exists', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'measure', requestId: 'req-2', refs: [{ nodeId: 'missing', occurrenceIndex: 0 }] })

    const reply = posted.at(-1)!.data as { message: { measurements: Array<{ rect: unknown }> } }
    expect(reply.message.measurements[0]!.rect).toBeNull()
  })
})

// `speed-06` — the reply the parent's per-drag snapshot round-trips against.
describe('createStudioRuntimeBridge — dropCandidates', () => {
  it('replies with one candidate per stamped node, with an axis and no empty-box entries', () => {
    document.body.innerHTML = `
      <div data-node-id="row" style="display:flex; flex-direction:row;">
        <span data-node-id="a"></span>
        <span data-node-id="b"></span>
      </div>
    `
    for (const [id, rect] of [
      ['row', { x: 0, y: 0, width: 200, height: 40 }],
      ['a', { x: 0, y: 0, width: 100, height: 40 }],
      ['b', { x: 100, y: 0, width: 100, height: 40 }],
    ] as const) {
      const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!
      el.getBoundingClientRect = () => ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect
    }
    document.body.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 40, left: 0, top: 0, right: 200, bottom: 40, toJSON: () => ({}) }) as DOMRect

    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'dropCandidates', requestId: 'drop-1' })

    const reply = posted.at(-1)!.data as {
      message: { type: string; requestId: string; candidates: Array<{ nodeId: string; axis: string; rect: { width: number; height: number } }> }
    }
    expect(reply.message.type).toBe('dropCandidates:result')
    expect(reply.message.requestId).toBe('drop-1')
    const nodeIds = reply.message.candidates.map((c) => c.nodeId).sort()
    expect(nodeIds).toEqual(['a', 'b', 'row'])
    // `a`/`b` sit inside the flex-row container `row` — inserting a sibling
    // beside either of them is a HORIZONTAL choice; `row` itself sits inside
    // the (default, block) `<body>`, a VERTICAL choice.
    const a = reply.message.candidates.find((c) => c.nodeId === 'a')!
    expect(a.axis).toBe('horizontal')
    const row = reply.message.candidates.find((c) => c.nodeId === 'row')!
    expect(row.axis).toBe('vertical')
    for (const candidate of reply.message.candidates) {
      expect(candidate.rect.width > 0 || candidate.rect.height > 0).toBe(true)
    }
  })

  it('excludes a node whose element has no box (a `display: contents` wrapper) but keeps its children', () => {
    document.body.innerHTML = `
      <div data-node-id="wrapper" style="display:contents;">
        <span data-node-id="child"></span>
      </div>
    `
    const child = document.querySelector<HTMLElement>('[data-node-id="child"]')!
    child.getBoundingClientRect = () => ({ x: 0, y: 0, width: 40, height: 20, left: 0, top: 0, right: 40, bottom: 20, toJSON: () => ({}) }) as DOMRect
    document.body.getBoundingClientRect = () => ({ x: 0, y: 0, width: 40, height: 20, left: 0, top: 0, right: 40, bottom: 20, toJSON: () => ({}) }) as DOMRect

    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'dropCandidates', requestId: 'drop-2' })

    const reply = posted.at(-1)!.data as { message: { candidates: Array<{ nodeId: string }> } }
    const nodeIds = reply.message.candidates.map((c) => c.nodeId)
    expect(nodeIds).toEqual(['child'])
  })
})

/**
 * These tests exercise the REAL listener `createStudioRuntimeBridge`
 * installs (captured via a spy on `addEventListener`, since a real
 * cross-origin `postMessage` isn't available in this harness — Bun/happy-dom's
 * `MessageEvent` constructor requires `source` to be a `MessagePort` or
 * `null`, not an arbitrary window-like object, so a real event carrying a
 * `WindowProxy` source can't be constructed here at all). Calling the
 * captured handler with a plain `{origin, source, data}` object exercises
 * the exact same production code path — `onWindowMessage` only ever reads
 * those three properties — without needing a real `Event`. A real
 * cross-origin postMessage handshake is dogfood-only; see `STATE.md`'s
 * `live-04` handoff.
 */
describe('createStudioRuntimeBridge — postMessage transport', () => {
  function captureMessageListener(): (ev: { origin: string; source: unknown; data: unknown }) => void {
    const original = window.addEventListener.bind(window)
    let captured: ((ev: unknown) => void) | null = null
    window.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'message' && typeof handler === 'function') captured = handler as (ev: unknown) => void
      return original(type, handler as EventListener, opts as boolean | AddEventListenerOptions | undefined)
    }) as typeof window.addEventListener
    return (ev) => {
      window.addEventListener = original
      captured!(ev)
    }
  }

  it('dispatches a validly-sourced, correctly-originated message', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    const dispatch = captureMessageListener()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    dispatch({
      origin: PARENT_ORIGIN,
      source: fakeWindow,
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] } },
    })

    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(1)
  })

  it('ignores a message from the wrong origin', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const dispatch = captureMessageListener()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    dispatch({
      origin: 'https://attacker.test',
      source: fakeWindow,
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] } },
    })

    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('ignores a message from a window that is not the configured parent', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const dispatch = captureMessageListener()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    dispatch({
      origin: PARENT_ORIGIN,
      source: { postMessage: () => {} },
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] } },
    })

    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('ignores unrelated postMessage traffic (wrong source tag)', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const dispatch = captureMessageListener()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    dispatch({
      origin: PARENT_ORIGIN,
      source: fakeWindow,
      data: { source: 'react-devtools-bridge', direction: 'to-frame', message: { type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] } },
    })

    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('ignores a malformed message payload without throwing', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const dispatch = captureMessageListener()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    expect(() => dispatch({ origin: PARENT_ORIGIN, source: fakeWindow, data: 'not an object' })).not.toThrow()
    expect(() =>
      dispatch({ origin: PARENT_ORIGIN, source: fakeWindow, data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select' } } }),
    ).not.toThrow()
  })
})

describe('createStudioRuntimeBridge — dispose', () => {
  it('removes overlays, rings, the overlay root, and the message listener', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()

    const originalRemove = window.removeEventListener.bind(window)
    let removedMessageListener = false
    window.removeEventListener = ((type: string, handler: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'message') removedMessageListener = true
      return originalRemove(type, handler as EventListener, opts as boolean | EventListenerOptions | undefined)
    }) as typeof window.removeEventListener

    const localBridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    localBridge.handleMessage({ type: 'applyOverlay', id: 'x', css: '.a{}' })
    localBridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })
    localBridge.handleMessage({ type: 'setMode', mode: 'design' })

    localBridge.dispose()
    window.removeEventListener = originalRemove

    expect(removedMessageListener).toBe(true)
    expect(document.querySelector('[data-studio-overlay-id="x"]')).toBeNull()
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
    expect(document.getElementById('studio-canvas-selection-overlay-root')).toBeNull()
    expect(document.getElementById('studio-runtime-scroll-unroll')).toBeNull()
    expect(document.getElementById('studio-runtime-animation-freeze')).toBeNull()
  })
})

describe('createStudioRuntimeBridge — optimistic-insert ghost sweep', () => {
  /** Minimal `ViteHotContext` stub that records handlers by event name so a test can fire them manually. */
  function makeFakeHot() {
    const handlers = new Map<string, () => void>()
    return {
      hot: {
        on: (event: 'vite:beforeUpdate' | 'vite:afterUpdate', cb: () => void) => {
          handlers.set(event, cb)
        },
      },
      fireAfterUpdate: () => handlers.get('vite:afterUpdate')?.(),
      fireBeforeUpdate: () => handlers.get('vite:beforeUpdate')?.(),
    }
  }

  it('removes every [data-studio-optimistic] ghost once vite:afterUpdate fires', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const { hot, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })

    document.body.innerHTML = `<div data-node-id="parent"></div>`
    bridge.handleMessage({
      type: 'optimistic.insert',
      nodeId: 'ghost',
      parentNodeId: 'parent',
      parentOccurrenceIndex: 0,
      index: 0,
      tagName: 'div',
      text: undefined,
    })
    expect(document.querySelectorAll('[data-studio-optimistic]')).toHaveLength(1)

    fireAfterUpdate()

    expect(document.querySelectorAll('[data-studio-optimistic]')).toHaveLength(0)
  })

  // `live-14` — before React reconciles an update, the DOM is the one it built.
  it('vite:beforeUpdate un-hides an optimistic delete and puts an optimistic move back; vite:afterUpdate does the same for a frame that missed the before', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const { hot, fireBeforeUpdate, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })
    document.body.innerHTML = `
      <div data-node-id="from"><div data-node-id="a"></div><div data-node-id="item"></div><div data-node-id="c"></div></div>
      <div data-node-id="to"></div>
    `
    bridge.handleMessage({ type: 'optimistic.move', nodeId: 'item', occurrenceIndex: 0, parentNodeId: 'to', parentOccurrenceIndex: 0, index: 0 })
    bridge.handleMessage({ type: 'optimistic.delete', nodeId: 'a', occurrenceIndex: 0 })
    expect(document.querySelector('[data-node-id="to"] [data-node-id="item"]')).not.toBeNull()
    expect(document.querySelector('[data-node-id="a"]')?.hasAttribute('data-studio-optimistic-hidden')).toBe(true)

    fireBeforeUpdate()

    const from = document.querySelector('[data-node-id="from"]')!
    expect([...from.children].map((el) => el.getAttribute('data-node-id'))).toEqual(['a', 'item', 'c'])
    expect(document.querySelector('[data-studio-optimistic-hidden]')).toBeNull()

    bridge.handleMessage({ type: 'optimistic.delete', nodeId: 'c', occurrenceIndex: 0 })
    fireAfterUpdate()
    expect(document.querySelector('[data-studio-optimistic-hidden]')).toBeNull()
  })

  it('still posts hmr:after after sweeping', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    const { hot, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })
    posted.length = 0 // drop the initial `ready` post

    fireAfterUpdate()

    expect(posted.some((p) => (p.data as { message: { type: string } }).message.type === 'hmr:after')).toBe(true)
  })

  it('leaves a real (non-ghost) node alone', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const { hot, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })

    document.body.innerHTML = `<div data-node-id="real"></div>`
    fireAfterUpdate()

    expect(document.querySelector('[data-node-id="real"]')).not.toBeNull()
  })
})

// `live-12` — a design frame's clicks belong to the editor, and its wheel to the canvas.
describe('createStudioRuntimeBridge — design mode owns the gesture', () => {
  function pointerEvent(type: string, init: MouseEventInit): Event {
    const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    return new Ctor(type, { bubbles: true, cancelable: true, ...init })
  }

  it('in design mode: pointerdown and click are cancelled and never reach the app, wheel is cancelled and forwarded', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const button = document.createElement('button')
    button.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(button)
    let appClicks = 0
    button.addEventListener('click', () => { appClicks += 1 })
    let appPointerDowns = 0
    button.addEventListener('pointerdown', () => { appPointerDowns += 1 })

    const down = pointerEvent('pointerdown', { clientX: 5, clientY: 6 })
    button.dispatchEvent(down)
    const click = pointerEvent('click', { clientX: 5, clientY: 6 })
    button.dispatchEvent(click)
    expect(down.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(appPointerDowns).toBe(0)
    expect(appClicks).toBe(0)
    // …but the parent still heard both, with the node they landed on.
    const phases = posted
      .map((p) => (p.data as { message: { type: string; phase?: string; nodeId?: string | null } }).message)
      .filter((m) => m.type === 'pointer')
      .map((m) => `${m.phase}:${m.nodeId}`)
    expect(phases).toEqual(['down:pages/Home.tsx:3:4', 'click:pages/Home.tsx:3:4'])

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, ctrlKey: true, clientX: 7, clientY: 8 })
    button.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    const wheels = posted.map((p) => (p.data as { message: { type: string } }).message).filter((m) => m.type === 'wheel')
    expect(wheels).toEqual([
      { type: 'wheel', deltaX: 0, deltaY: -120, deltaMode: 0, clientX: 7, clientY: 8, modifiers: { shiftKey: false, altKey: false, ctrlKey: true, metaKey: false } },
    ])
  })

  // `live-13` — the parent tells a pan from a selection by the button state.
  it('forwards the button, buttons and pointer identity with every pointer phase', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(box)
    box.dispatchEvent(pointerEvent('pointerdown', { button: 1, buttons: 4 }))
    const down = posted.map((p) => (p.data as { message: Record<string, unknown> }).message).find((m) => m.type === 'pointer')!
    expect(down.button).toBe(1)
    expect(down.buttons).toBe(4)
    expect(typeof down.pointerId).toBe('number')
    expect(['mouse', 'pen', 'touch', '']).toContain(down.pointerType)
  })

  it('a contenteditable text run keeps its click in design mode — the caret has to land for an inline edit', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const text = document.createElement('p')
    text.setAttribute('contenteditable', 'true')
    document.body.appendChild(text)
    const down = pointerEvent('pointerdown', {})
    text.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
  })

  it('in live mode: the app gets every event and nothing is forwarded as wheel', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'live' })
    const button = document.createElement('button')
    document.body.appendChild(button)
    let appClicks = 0
    button.addEventListener('click', () => { appClicks += 1 })
    const click = pointerEvent('click', {})
    button.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(appClicks).toBe(1)
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 })
    button.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    expect(posted.some((p) => (p.data as { message: { type: string } }).message.type === 'wheel')).toBe(false)
  })
})

// `speed-03` — every native pointermove used to become its own postMessage
// (measured ≈120/s while idly hovering a live frame); `move` is now
// coalesced to one post per animation frame and skipped when it would repeat
// the last posted node + rect.
describe('createStudioRuntimeBridge — move coalescing (`speed-03`)', () => {
  function pointerEvent(type: string, init: MouseEventInit): Event {
    const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    return new Ctor(type, { bubbles: true, cancelable: true, ...init })
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  function pointerMessages(posted: Array<{ data: unknown }>) {
    return posted
      .map((p) => (p.data as { message: Record<string, unknown> }).message)
      .filter((m) => m.type === 'pointer')
  }

  it('100 moves inside one animation frame coalesce to a single message carrying the last coordinates', async () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(box)

    for (let i = 0; i < 100; i += 1) {
      box.dispatchEvent(pointerEvent('pointermove', { clientX: i, clientY: i }))
    }
    // Nothing posts before the frame the batch is coalesced onto fires.
    expect(pointerMessages(posted).filter((m) => m.phase === 'move')).toHaveLength(0)

    await nextFrame()
    const moves = pointerMessages(posted).filter((m) => m.phase === 'move')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ clientX: 99, clientY: 99, nodeId: 'pages/Home.tsx:3:4' })
  })

  it('skips the post when the resolved node and rect are unchanged from the last posted move', async () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(box)

    box.dispatchEvent(pointerEvent('pointermove', { clientX: 1, clientY: 1 }))
    await nextFrame()
    expect(pointerMessages(posted).filter((m) => m.phase === 'move')).toHaveLength(1)

    // Same node, same rect (happy-dom has no layout engine — every element's
    // `getBoundingClientRect()` is the zero rect, so this also covers the
    // "both null-ish" background case) — a different client position alone
    // must not produce a second post.
    box.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    await nextFrame()
    expect(pointerMessages(posted).filter((m) => m.phase === 'move')).toHaveLength(1)

    // Genuinely leaving the node produces a new post.
    document.body.appendChild(document.createElement('span'))
    box.remove()
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 41, clientY: 41 }))
    await nextFrame()
    expect(pointerMessages(posted).filter((m) => m.phase === 'move')).toHaveLength(2)
  })

  it('keeps posting while a button is held, even over the same node + rect — a pan replay needs every position', async () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(box)

    box.dispatchEvent(pointerEvent('pointerdown', { button: 1, buttons: 4, clientX: 0, clientY: 0 }))
    box.dispatchEvent(pointerEvent('pointermove', { buttons: 4, clientX: 10, clientY: 10 }))
    await nextFrame()
    box.dispatchEvent(pointerEvent('pointermove', { buttons: 4, clientX: 20, clientY: 20 }))
    await nextFrame()

    const moves = pointerMessages(posted).filter((m) => m.phase === 'move')
    expect(moves).toHaveLength(2)
    expect(moves.map((m) => m.clientX)).toEqual([10, 20])
  })

  it('flushes a pending move before a down, so the parent never sees the down first', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    document.body.appendChild(box)

    // The move is still pending (no frame has fired) when the down lands.
    box.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 5 }))
    box.dispatchEvent(pointerEvent('pointerdown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }))

    const phases = pointerMessages(posted).map((m) => m.phase)
    expect(phases).toEqual(['move', 'down'])
  })
})

// `live-13` — the frame draws and drags the resize handles; the parent commits.
describe('createStudioRuntimeBridge — resize handles', () => {
  const FRAME = '[data-canvas-resize-frame]'
  const HANDLE = '[data-canvas-resize-handle]'
  const PREVIEW_ATTR = 'data-studio-resize-preview'

  function pointerEvent(type: string, init: MouseEventInit): Event {
    const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    return new Ctor(type, { bubbles: true, cancelable: true, ...init })
  }
  function mountBox(display = 'block'): HTMLElement {
    const box = document.createElement('div')
    box.setAttribute('data-node-id', 'pages/Home.tsx:3:4')
    box.style.display = display
    box.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 50, right: 110, bottom: 70, x: 10, y: 20, toJSON: () => ({}) })
    document.body.appendChild(box)
    return box
  }
  function messages(posted: Array<{ data: unknown }>): Array<Record<string, unknown>> {
    return posted.map((p) => (p.data as { message: Record<string, unknown> }).message)
  }
  function makeFakeHot() {
    const handlers = new Map<string, () => void>()
    return {
      hot: { on: (event: 'vite:beforeUpdate' | 'vite:afterUpdate', cb: () => void) => { handlers.set(event, cb) } },
      fireAfterUpdate: () => handlers.get('vite:afterUpdate')?.(),
    }
  }

  it('setResizeTarget draws eight handles around a sizeable element, and null hides them', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    mountBox()
    bridge.handleMessage({ type: 'setResizeTarget', ref: { nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0 }, proportional: false })
    const frame = document.querySelector<HTMLElement>(FRAME)!
    expect(frame.closest('#studio-canvas-selection-overlay-root')).not.toBeNull()
    expect(frame.style.display).toBe('')
    expect(frame.style.width).toBe('100px')
    expect(frame.style.height).toBe('50px')
    expect(frame.querySelectorAll(HANDLE)).toHaveLength(8)
    bridge.handleMessage({ type: 'setResizeTarget', ref: null, proportional: false })
    expect(frame.style.display).toBe('none')
  })

  it('offers nothing on an element whose display ignores a size', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    mountBox('inline')
    bridge.handleMessage({ type: 'setResizeTarget', ref: { nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0 }, proportional: false })
    const frame = document.querySelector<HTMLElement>(FRAME)
    expect(frame === null || frame.style.display === 'none').toBe(true)
  })

  it('a drag on the east handle previews through a stylesheet, is not forwarded as a pointer, and commits only the width', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = mountBox()
    let appPointerDowns = 0
    box.addEventListener('pointerdown', () => { appPointerDowns += 1 })
    bridge.handleMessage({ type: 'setResizeTarget', ref: { nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0 }, proportional: false })
    const east = document.querySelector<HTMLElement>('[data-canvas-resize-handle="e"]')!

    const down = pointerEvent('pointerdown', { clientX: 110, clientY: 40, button: 0 })
    east.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(appPointerDowns).toBe(0)
    // With the pointer captured, the handle stays the target of every move and
    // the release — as a real browser delivers them.
    east.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 70 }))
    east.dispatchEvent(pointerEvent('pointerup', { clientX: 150, clientY: 70 }))

    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(true)
    expect(document.getElementById('studio-runtime-resize-preview')?.textContent).toContain('width: 140px !important')
    expect(document.getElementById('studio-runtime-resize-preview')?.textContent).not.toContain('height')
    // The element's own inline style is untouched — React's later write is not something to clear.
    expect(box.style.width).toBe('')
    const all = messages(posted)
    expect(all.filter((m) => m.type === 'pointer')).toHaveLength(0)
    expect(all.filter((m) => m.type === 'resize:commit')).toEqual([
      { type: 'resize:commit', nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0, patch: { width: '140px' } },
    ])
  })

  it('a cancelled drag commits nothing and drops the preview; a new target drops a held one', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const box = mountBox()
    bridge.handleMessage({ type: 'setResizeTarget', ref: { nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0 }, proportional: false })
    const south = document.querySelector<HTMLElement>('[data-canvas-resize-handle="s"]')!
    // Dispatched on the DOCUMENT itself, deliberately: a browser that refused
    // the pointer capture delivers the rest of the gesture to the page, where
    // design mode stops propagation at the document — the capture-phase drag
    // listeners must still see it.
    south.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 70, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
    document.dispatchEvent(pointerEvent('pointercancel', {}))
    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(false)
    expect(document.getElementById('studio-runtime-resize-preview')).toBeNull()
    expect(messages(posted).filter((m) => m.type === 'resize:commit')).toHaveLength(0)

    south.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 70, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
    document.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 100 }))
    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(true)
    bridge.handleMessage({ type: 'setResizeTarget', ref: null, proportional: false })
    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(false)
  })

  it('an HMR update clears a held preview — the source now carries the size', () => {
    const { fakeWindow } = makeFakeParentWindow()
    const { hot, fireAfterUpdate } = makeFakeHot()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })
    const box = mountBox()
    bridge.handleMessage({ type: 'setResizeTarget', ref: { nodeId: 'pages/Home.tsx:3:4', occurrenceIndex: 0 }, proportional: false })
    const east = document.querySelector<HTMLElement>('[data-canvas-resize-handle="e"]')!
    east.dispatchEvent(pointerEvent('pointerdown', { clientX: 110, clientY: 40, button: 0 }))
    document.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 40 }))
    document.dispatchEvent(pointerEvent('pointerup', { clientX: 150, clientY: 40 }))
    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(true)
    fireAfterUpdate()
    expect(box.hasAttribute(PREVIEW_ATTR)).toBe(false)
  })
})

// `live-18` — double-click-to-edit text inside a bridge frame.
describe('createStudioRuntimeBridge — inline text edit', () => {
  function mouseEvent(type: string, init: MouseEventInit = {}): MouseEvent {
    return new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  }
  function keyEvent(type: string, init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  }
  function messages(posted: Array<{ data: unknown }>): Array<Record<string, unknown>> {
    return posted.map((p) => (p.data as { message: Record<string, unknown> }).message)
  }
  function mountText(text: string): HTMLElement {
    const el = document.createElement('p')
    el.setAttribute('data-node-id', 'pages/Home.tsx:5:2')
    el.textContent = text
    document.body.appendChild(el)
    return el
  }

  it('a double-click in design mode posts text:editStart and claims the gesture', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    const dbl = mouseEvent('dblclick')
    el.dispatchEvent(dbl)
    expect(dbl.defaultPrevented).toBe(true)
    expect(messages(posted).filter((m) => m.type === 'text:editStart')).toEqual([
      { type: 'text:editStart', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0 },
    ])
    // Not yet contentEditable — the parent hasn't replied.
    expect(el.getAttribute('contenteditable')).toBeNull()
  })

  it('a double-click in live mode does nothing — the runtime asks only in design mode', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'live' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    expect(messages(posted).some((m) => m.type === 'text:editStart')).toBe(false)
  })

  it('an allowed reply seeds the text, makes the element editable, and focuses it', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'canonical text' })

    expect(el.contentEditable).toBe('plaintext-only')
    expect(el.textContent).toBe('canonical text')
    expect(document.activeElement).toBe(el)
  })

  it('a refused reply leaves the element untouched', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: false })

    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(el.textContent).toBe('hello')
  })

  it('a reply for a stale/mismatched request is ignored', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    // No editStart was ever sent for this node — a reply with nothing pending.
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'nope' })
    expect(el.getAttribute('contenteditable')).toBeNull()
  })

  it('Enter without Shift commits the CURRENT DOM text and removes the attribute; the app never sees the keydown', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })

    let appKeydowns = 0
    document.body.addEventListener('keydown', () => { appKeydowns += 1 })
    el.textContent = 'hello world' // the user typed directly into the real element
    const enter = keyEvent('keydown', { key: 'Enter' })
    el.dispatchEvent(enter)

    expect(enter.defaultPrevented).toBe(true)
    expect(appKeydowns).toBe(0)
    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(el.textContent).toBe('hello world')
    expect(messages(posted).filter((m) => m.type === 'text:commit')).toEqual([
      { type: 'text:commit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, text: 'hello world' },
    ])
  })

  it('Shift+Enter does not commit — plain newline behaviour is left to the browser', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })
    el.dispatchEvent(keyEvent('keydown', { key: 'Enter', shiftKey: true }))
    expect(messages(posted).filter((m) => m.type === 'text:commit')).toHaveLength(0)
    expect(el.getAttribute('contenteditable')).not.toBeNull()
  })

  it('Escape cancels — restores the seeded text, removes the attribute, and posts text:cancel', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })
    el.textContent = 'typed but abandoned'
    const escape = keyEvent('keydown', { key: 'Escape' })
    el.dispatchEvent(escape)

    expect(escape.defaultPrevented).toBe(true)
    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(el.textContent).toBe('hello')
    expect(messages(posted).filter((m) => m.type === 'text:cancel')).toEqual([
      { type: 'text:cancel', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0 },
    ])
    expect(messages(posted).filter((m) => m.type === 'text:commit')).toHaveLength(0)
  })

  it('blur commits — clicking away ends the session', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })
    el.textContent = 'blurred away'
    el.dispatchEvent(new Event('blur'))

    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(messages(posted).filter((m) => m.type === 'text:commit')).toEqual([
      { type: 'text:commit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, text: 'blurred away' },
    ])
  })

  it('a text over the 20000-char ceiling is truncated before it is posted', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })
    el.textContent = 'x'.repeat(20_050)
    el.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))

    const commit = messages(posted).find((m) => m.type === 'text:commit') as { text: string } | undefined
    expect(commit?.text).toHaveLength(20_000)
  })

  it("vite:beforeUpdate with an edit still open cancels it (nothing was ever written to the store to undo)", () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    const handlers = new Map<string, () => void>()
    const hot = { on: (event: 'vite:beforeUpdate' | 'vite:afterUpdate', cb: () => void) => { handlers.set(event, cb) } }
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document, hot })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    const el = mountText('hello')
    el.dispatchEvent(mouseEvent('dblclick'))
    bridge.handleMessage({ type: 'text:edit', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0, allowed: true, text: 'hello' })
    el.textContent = 'unsaved edit'

    handlers.get('vite:beforeUpdate')?.()

    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(el.textContent).toBe('hello')
    expect(messages(posted).filter((m) => m.type === 'text:cancel')).toEqual([
      { type: 'text:cancel', nodeId: 'pages/Home.tsx:5:2', occurrenceIndex: 0 },
    ])
  })

  it('a double-click on the runtime\'s own chrome is never a text edit', () => {
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    bridge.handleMessage({ type: 'select', refs: [{ nodeId: 'n1', occurrenceIndex: 0 }] })
    const ring = document.querySelector('[data-canvas-selection-ring]')!
    ring.dispatchEvent(mouseEvent('dblclick'))
    expect(messages(posted).some((m) => m.type === 'text:editStart')).toBe(false)
  })
})

describe('createStudioRuntimeBridge — frame fit resets (PERF-9)', () => {
  const drainMutations = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('attribute writes from an animating app never reset the fit; nodes added and removed reset it once, debounced', async () => {
    const { fakeWindow } = makeFakeParentWindow()
    document.body.innerHTML = '<div id="slide" class="a"></div>'
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
    bridge.handleMessage({ type: 'setMode', mode: 'design' })
    await Bun.sleep(LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS + 50)
    // A fitted pin the frame settled at. A reset writes it back to the floor.
    document.body.style.height = '1234px'
    await drainMutations()

    const slide = document.getElementById('slide')!
    for (let frame = 0; frame < 30; frame += 1) {
      slide.setAttribute('class', frame % 2 ? 'a' : 'b')
      slide.style.transform = `translateX(${frame}px)`
      await drainMutations()
    }
    expect(document.body.style.height).toBe('1234px')

    for (let frame = 0; frame < 10; frame += 1) {
      const dot = document.createElement('span')
      document.body.appendChild(dot)
      await drainMutations()
      dot.remove()
      await drainMutations()
    }
    // Still inside the trailing debounce: the app is churning nodes every frame.
    expect(document.body.style.height).toBe('1234px')
    await Bun.sleep(LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS + 50)
    expect(document.body.style.height).toBe(`${DEFAULT_FRAME_FIT_HEIGHT}px`)
  })
})
