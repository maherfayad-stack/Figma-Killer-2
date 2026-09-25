/**
 * PortalFrameAdapter — tested against a real happy-dom `Document`, this
 * repo's normal DOM test story. No iframe-query helper needed: the adapter
 * IS the thing under test here, not code that queries around one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { runFrameDocumentAdapterContract } from './frameDocumentAdapter.contract'

function freshDoc(): Document {
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-source], style[data-studio-overlay-id]').forEach((el) => el.remove())
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.body.style.position = ''
  return document
}

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

runFrameDocumentAdapterContract('PortalFrameAdapter', () => {
  const doc = freshDoc()
  doc.body.innerHTML = `<div data-node-id="n1"></div>`
  const adapter = new PortalFrameAdapter(doc)
  adapters.push(adapter)
  return { adapter, existingRef: { nodeId: 'n1' }, cleanup: () => adapter.dispose() }
})

describe('PortalFrameAdapter — overlay stylesheets', () => {
  it('applyOverlay mounts a style element, removeOverlay removes it', () => {
    const doc = freshDoc()
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    adapter.applyOverlay('test-overlay', '.x { color: red }')
    const el = doc.querySelector('[data-studio-overlay-id="test-overlay"]')
    expect(el?.textContent).toBe('.x { color: red }')

    adapter.removeOverlay('test-overlay')
    expect(doc.querySelector('[data-studio-overlay-id="test-overlay"]')).toBeNull()
  })
})

describe('PortalFrameAdapter — selection / hover rings', () => {
  it('select creates a ring element per node and removes rings for deselected nodes', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div><div data-node-id="n2"></div>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    adapter.select([{ nodeId: 'n1' }, { nodeId: 'n2' }])
    expect(doc.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(2)

    adapter.select([{ nodeId: 'n1' }])
    expect(doc.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(1)

    adapter.select([])
    expect(doc.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
  })

  it('hover creates/positions a single ring and null clears it', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    adapter.hover({ nodeId: 'n1' })
    expect(doc.querySelectorAll('[data-canvas-hover-ring]')).toHaveLength(1)

    adapter.hover(null)
    expect((doc.querySelector('[data-canvas-hover-ring]') as HTMLElement).style.display).toBe('none')
  })
})

describe('PortalFrameAdapter — measure', () => {
  it('resolves rects + requested computed-style properties for an existing node', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="m1"></div>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    const [measurement] = await adapter.measure([{ nodeId: 'm1' }], ['display'])
    expect(measurement!.nodeId).toBe('m1')
    expect(measurement!.rect).not.toBeNull()
    expect(Object.keys(measurement!.computedStyle)).toContain('display')
  })

  it('reports a null rect for a node that does not exist', async () => {
    const doc = freshDoc()
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    const [measurement] = await adapter.measure([{ nodeId: 'missing' }])
    expect(measurement!.rect).toBeNull()
  })
})

describe('PortalFrameAdapter — setInteractionMode', () => {
  it('design mode starts scroll-unroll/animation-freeze; live mode stops them', () => {
    const doc = freshDoc()
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    adapter.setInteractionMode('design')
    expect(doc.getElementById('studio-portal-adapter-scroll-unroll')).not.toBeNull()
    expect(doc.getElementById('studio-portal-adapter-animation-freeze')).not.toBeNull()

    adapter.setInteractionMode('live')
    expect(doc.getElementById('studio-portal-adapter-scroll-unroll')).toBeNull()
    expect(doc.getElementById('studio-portal-adapter-animation-freeze')).toBeNull()
  })
})

describe('PortalFrameAdapter — optimistic DOM ops', () => {
  it('insert/move/delete mutate the DOM directly, never through innerHTML', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="parent"></div>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    adapter.optimistic.insert('new1', 'parent', 0, 'span', '<img onerror=alert(1)>')
    const inserted = doc.querySelector('[data-node-id="new1"]')
    expect(inserted?.tagName).toBe('SPAN')
    expect(inserted?.textContent).toBe('<img onerror=alert(1)>')
    expect(inserted?.querySelector('img')).toBeNull()

    adapter.optimistic.delete('new1')
    expect(doc.querySelector('[data-node-id="new1"]')).toBeNull()
  })
})

describe('PortalFrameAdapter — on(pointer)', () => {
  it('forwards a click on a node-id-carrying element as a pointer event', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="p1"></div>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    const events: Array<{ nodeId: string | null }> = []
    adapter.on('pointer', (msg) => events.push(msg))

    const target = doc.querySelector('[data-node-id="p1"]')!
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(events).toHaveLength(1)
    expect(events[0]!.nodeId).toBe('p1')
  })
})

describe('PortalFrameAdapter — dispose', () => {
  it('removes overlays, rings, and the overlay root', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = new PortalFrameAdapter(doc)

    adapter.applyOverlay('x', '.a{}')
    adapter.select([{ nodeId: 'n1' }])
    adapter.setInteractionMode('design')

    adapter.dispose()

    expect(doc.querySelector('[data-studio-overlay-id="x"]')).toBeNull()
    expect(doc.querySelectorAll('[data-canvas-selection-ring]')).toHaveLength(0)
    expect(doc.getElementById('studio-portal-adapter-scroll-unroll')).toBeNull()
    expect(doc.getElementById('studio-portal-adapter-animation-freeze')).toBeNull()
  })
})

describe('PortalFrameAdapter — ring tracking is armed lazily (PERF-10)', () => {
  it('constructs no MutationObserver until the first select/hover', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const view = doc.defaultView as unknown as { MutationObserver: typeof MutationObserver }
    const RealMutationObserver = view.MutationObserver
    let constructed = 0
    view.MutationObserver = class extends RealMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback)
        constructed += 1
      }
    }
    try {
      const adapter = new PortalFrameAdapter(doc)
      adapters.push(adapter)
      // Portal mode's rings are `BreakpointSelectionOverlay`'s own portal, so
      // on an ordinary board nothing calls select/hover — and nothing may be
      // observing every attribute write in the frame on the adapter's behalf.
      expect(constructed).toBe(0)

      adapter.hover({ nodeId: 'n1' })
      expect(constructed).toBe(1)
      adapter.select([{ nodeId: 'n1' }])
      expect(constructed).toBe(1)
    } finally {
      view.MutationObserver = RealMutationObserver
    }
  })
})
