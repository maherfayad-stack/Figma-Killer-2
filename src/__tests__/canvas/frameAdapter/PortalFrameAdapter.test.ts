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

  it('re-applying the same CSS leaves the style element untouched (P6-C)', async () => {
    // A `<style>` whose text is reassigned is re-parsed and invalidates style
    // for the whole document, even when the text is identical — and every
    // mounted frame's injectors re-apply on inputs that change nothing they
    // emit (a click re-runs the forced-state preview in every frame).
    const doc = freshDoc()
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)
    adapter.applyOverlay('same', '')
    adapter.applyOverlay('css', '.x { color: red }')
    const empty = doc.querySelector('[data-studio-overlay-id="same"]')!
    const styled = doc.querySelector('[data-studio-overlay-id="css"]')!
    const records: MutationRecord[] = []
    const observer = new MutationObserver((batch) => records.push(...batch))
    observer.observe(empty, { childList: true, characterData: true, subtree: true })
    observer.observe(styled, { childList: true, characterData: true, subtree: true })
    const textNode = styled.firstChild

    adapter.applyOverlay('same', '')
    adapter.applyOverlay('css', '.x { color: red }')
    await Promise.resolve()
    records.push(...observer.takeRecords())
    expect(records).toEqual([])
    expect(styled.firstChild).toBe(textNode)

    // A real change still lands, and a removed overlay starts over.
    adapter.applyOverlay('css', '.x { color: blue }')
    expect(styled.textContent).toBe('.x { color: blue }')
    adapter.removeOverlay('css')
    adapter.applyOverlay('css', '.x { color: blue }')
    expect(doc.querySelector('[data-studio-overlay-id="css"]')?.textContent).toBe('.x { color: blue }')
    observer.disconnect()
  })
})

describe('PortalFrameAdapter — draws nothing in the frame (SB-4)', () => {
  it('measureAll reads the frame without adding a node, a style or an attribute to it', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div><div data-node-id="n2"></div>`
    const before = doc.documentElement.outerHTML
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)

    const snapshot = await adapter.measureAll()
    expect(snapshot.nodes.map((node) => node.nodeId)).toEqual([])
    expect(adapter.measureAllNow()).not.toBeNull()
    expect(doc.documentElement.outerHTML).toBe(before)
    expect(doc.querySelector('[data-canvas-selection-ring], [data-canvas-hover-ring], [data-studio-canvas-overlay-root]')).toBeNull()
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
  it('removes overlays and the controllers it started', () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = new PortalFrameAdapter(doc)

    adapter.applyOverlay('x', '.a{}')
    adapter.setInteractionMode('design')

    adapter.dispose()

    expect(doc.querySelector('[data-studio-overlay-id="x"]')).toBeNull()
    expect(doc.getElementById('studio-portal-adapter-scroll-unroll')).toBeNull()
    expect(doc.getElementById('studio-portal-adapter-animation-freeze')).toBeNull()
  })
})

describe('PortalFrameAdapter — geometry tracking is armed lazily (PERF-10)', () => {
  it('constructs no MutationObserver until the first measureAll, and one body observer for any number of them', async () => {
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
      // A frame nobody indexes pays nothing: no observer on every attribute write in it.
      expect(constructed).toBe(0)

      await adapter.measureAll()
      const armed = constructed
      expect(armed).toBeGreaterThan(0)
      await adapter.measureAll()
      adapter.measureAllNow()
      expect(constructed).toBe(armed)
    } finally {
      view.MutationObserver = RealMutationObserver
    }
  })

  it('reports geometry:dirty once per read when the body changes, text typed in a box included', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<p data-node-id="n1">hi</p>`
    const adapter = new PortalFrameAdapter(doc)
    adapters.push(adapter)
    let fired = 0
    adapter.on('geometry:dirty', () => {
      fired += 1
    })
    await adapter.measureAll()

    doc.querySelector('p')!.firstChild!.textContent = 'hello'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fired).toBe(1)

    // A latch: more changes before the next read are one signal, not many.
    doc.querySelector('p')!.setAttribute('class', 'a')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fired).toBe(1)

    adapter.measureAllNow()
    doc.querySelector('p')!.setAttribute('class', 'b')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fired).toBe(2)
  })
})
