/**
 * `createStudioRuntimeBridge` — dispatch-logic tests drive `handleMessage`
 * directly (no postMessage transport involved); a smaller set of tests
 * exercises the actual `window.addEventListener('message', …)` pipeline with
 * constructed `MessageEvent`s so the origin/source/envelope checks are
 * covered too. Real cross-origin `postMessage` timing and a real iframe are
 * NOT exercised here — see `STATE.md`'s `live-04` handoff, "Pending dogfood".
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createStudioRuntimeBridge, RUNTIME_MESSAGE_SOURCE, type StudioRuntimeBridge } from '@core/studio-runtime'

const PARENT_ORIGIN = 'https://parent.test'

function makeFakeParentWindow() {
  const posted: Array<{ data: unknown; origin: string }> = []
  const fakeWindow = {
    postMessage: (data: unknown, origin: string) => posted.push({ data, origin }),
  } as unknown as Window
  return { fakeWindow, posted }
}

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

    bridge.handleMessage({ type: 'select', nodeIds: ['n1', 'n2'] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(2)

    bridge.handleMessage({ type: 'select', nodeIds: ['n1'] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(1)

    bridge.handleMessage({ type: 'select', nodeIds: [] })
    expect(document.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('hides a ring for a node id that does not exist in the DOM, without throwing', () => {
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    expect(() => bridge!.handleMessage({ type: 'select', nodeIds: ['missing'] })).not.toThrow()
    const ring = document.querySelector('[data-canvas-selection-ring]') as HTMLElement | null
    expect(ring?.style.display).toBe('none')
  })

  it('hover creates/positions a single ring and null clears it', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'hover', nodeId: 'n1' })
    expect(document.querySelectorAll('[data-canvas-hover-ring]')).toHaveLength(1)

    bridge.handleMessage({ type: 'hover', nodeId: null })
    expect((document.querySelector('[data-canvas-hover-ring]') as HTMLElement).style.display).toBe('none')
  })

  it('mounts exactly one overlay root even across multiple select calls', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'select', nodeIds: ['n1'] })
    bridge.handleMessage({ type: 'select', nodeIds: [] })
    bridge.handleMessage({ type: 'select', nodeIds: ['n1'] })

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

  it('delete removes the element', () => {
    document.body.innerHTML = `<div data-node-id="gone"></div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.delete', nodeId: 'gone' })
    expect(document.querySelector('[data-node-id="gone"]')).toBeNull()
  })

  it('move re-parents the element at the given index', () => {
    document.body.innerHTML = `
      <div data-node-id="from"><div data-node-id="item"></div></div>
      <div data-node-id="to"></div>
    `
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.move', nodeId: 'item', parentNodeId: 'to', index: 0 })

    const to = document.querySelector('[data-node-id="to"]')
    expect(to?.querySelector('[data-node-id="item"]')).not.toBeNull()
  })

  it('text sets textContent, never innerHTML', () => {
    document.body.innerHTML = `<div data-node-id="t1">old</div>`
    const { fakeWindow } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'optimistic.text', nodeId: 't1', text: '<b>bold</b>' })

    const el = document.querySelector('[data-node-id="t1"]')
    expect(el?.textContent).toBe('<b>bold</b>')
    expect(el?.querySelector('b')).toBeNull()
  })
})

describe('createStudioRuntimeBridge — measure', () => {
  it('replies with measure:result carrying a rect and the requested computed-style properties', () => {
    document.body.innerHTML = `<div data-node-id="m1"></div>`
    const { fakeWindow, posted } = makeFakeParentWindow()
    bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })

    bridge.handleMessage({ type: 'measure', requestId: 'req-1', nodeIds: ['m1'], properties: ['display'] })

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

    bridge.handleMessage({ type: 'measure', requestId: 'req-2', nodeIds: ['missing'] })

    const reply = posted.at(-1)!.data as { message: { measurements: Array<{ rect: unknown }> } }
    expect(reply.message.measurements[0]!.rect).toBeNull()
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
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', nodeIds: ['n1'] } },
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
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', nodeIds: ['n1'] } },
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
      data: { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message: { type: 'select', nodeIds: ['n1'] } },
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
      data: { source: 'react-devtools-bridge', direction: 'to-frame', message: { type: 'select', nodeIds: ['n1'] } },
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
    localBridge.handleMessage({ type: 'select', nodeIds: ['n1'] })
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
