/**
 * SB-3 — `PortalFrameAdapter.measureAll` and its `geometry:dirty` signal, on a
 * real happy-dom `Document`. happy-dom has no layout engine, so every box is
 * stubbed on `getBoundingClientRect`; what is under test is the adapter's own
 * logic (ancestry, occurrence-free canonical ids, the hit-test flags, the
 * latch, and that nothing observes the frame until geometry is asked for).
 * Real layout is the e2e spec's job (`board-scale-budgets.e2e.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

function freshDoc(): Document {
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
  return document
}

function box(el: Element, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + width, bottom: y + height, x, y, width, height, toJSON: () => ({}) }) as DOMRect
}

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

function adapterFor(doc: Document): PortalFrameAdapter {
  const adapter = new PortalFrameAdapter(doc)
  adapters.push(adapter)
  return adapter
}

describe('PortalFrameAdapter.measureAll', () => {
  it('lists boxed nodes in document order with body-relative rects and nearest-listed-ancestor parents', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `
      <div data-node-id="root">
        <section id="unstamped"><div data-node-id="card"><span data-node-id="label">x</span></div></section>
        <div data-node-id="empty"></div>
      </div>`
    box(doc.body, 10, 20, 400, 600)
    box(doc.querySelector('[data-node-id="root"]')!, 10, 20, 400, 600)
    box(doc.querySelector('[data-node-id="card"]')!, 30, 60, 200, 100)
    box(doc.querySelector('[data-node-id="label"]')!, 40, 70, 50, 20)
    // `empty` keeps happy-dom's all-zero rect: no box, so it is not listed.

    const snapshot = await adapterFor(doc).measureAll()

    expect(snapshot.origin).toEqual({ x: 10, y: 20 })
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.nodes.map((node) => [node.nodeId, node.parent])).toEqual([['root', -1], ['card', 0], ['label', 1]])
    expect(snapshot.nodes[1]!.rect).toEqual({ x: 20, y: 40, width: 200, height: 100 })
    expect(snapshot.nodes[2]!.rect).toEqual({ x: 30, y: 50, width: 50, height: 20 })
  })

  it('measures a display:contents host as the union of its boxed children (nodeVisualRect)', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="host"><b data-node-id="a"></b><b data-node-id="b"></b></div>`
    box(doc.body, 0, 0, 400, 400)
    box(doc.querySelector('[data-node-id="a"]')!, 10, 10, 20, 20)
    box(doc.querySelector('[data-node-id="b"]')!, 50, 40, 20, 20)

    const snapshot = await adapterFor(doc).measureAll()

    expect(snapshot.nodes.map((node) => node.nodeId)).toEqual(['host', 'a', 'b'])
    expect(snapshot.nodes[0]!.rect).toEqual({ x: 10, y: 10, width: 60, height: 50 })
    expect(snapshot.nodes[1]!.parent).toBe(0)
  })

  it('carries the facts a hit test needs: clipping, pointer-events, visibility, transform, paint rank', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `
      <div data-node-id="clip" style="overflow-x: hidden; overflow-y: hidden"></div>
      <div data-node-id="inert" style="pointer-events: none"></div>
      <div data-node-id="hidden" style="visibility: hidden"></div>
      <div data-node-id="turned" style="transform: rotate(10deg)"></div>
      <div data-node-id="top" style="position: relative; z-index: 3"></div>
      <div data-node-id="plain"></div>`
    box(doc.body, 0, 0, 400, 400)
    for (const id of ['clip', 'inert', 'hidden', 'turned', 'top', 'plain']) box(doc.querySelector(`[data-node-id="${id}"]`)!, 0, 0, 10, 10)

    const { nodes } = await adapterFor(doc).measureAll()
    const byId = Object.fromEntries(nodes.map((node) => [node.nodeId, node]))

    expect(byId.clip!.clips).toBe(true)
    expect(byId.plain!.clips).toBe(false)
    expect(byId.inert!.inert).toBe(true)
    expect(byId.hidden!.inert).toBe(true)
    expect(byId.plain!.inert).toBe(false)
    expect(byId.turned!.transformed).toBe(true)
    expect(byId.plain!.transformed).toBe(false)
    // positioned z-index 3 paints above a positioned auto, which paints above in-flow content.
    expect(byId.top!.paint).toBe(7)
    expect(byId.plain!.paint).toBe(0)
  })

  it('an empty document yields an empty snapshot', async () => {
    const doc = freshDoc()
    const snapshot = await adapterFor(doc).measureAll()
    expect(snapshot.nodes).toEqual([])
  })
})

describe('PortalFrameAdapter geometry:dirty', () => {
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('constructs no observer until geometry is asked for, then reuses the one layout observer', async () => {
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
      const adapter = adapterFor(doc)
      expect(constructed).toBe(0)
      await adapter.measureAll()
      // The body layout observer ring tracking already needs, plus ONE head observer for stylesheet rewrites.
      expect(constructed).toBe(2)
      adapter.select([{ nodeId: 'n1' }])
      adapter.hover({ nodeId: 'n1' })
      expect(constructed).toBe(2)
      await adapter.measureAll()
      expect(constructed).toBe(2)
    } finally {
      view.MutationObserver = RealMutationObserver
    }
  })

  it('stays silent before the first measureAll, fires once on a body change after it, and re-arms on the next read', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = adapterFor(doc)
    let fired = 0
    adapter.on('geometry:dirty', () => {
      fired += 1
    })

    doc.body.appendChild(doc.createElement('div'))
    await settle()
    expect(fired).toBe(0)

    await adapter.measureAll()
    doc.body.setAttribute('data-x', '1')
    await settle()
    expect(fired).toBe(1)
    // A burst after the first ping is the same dirtiness: the latch holds until the parent re-reads.
    doc.body.appendChild(doc.createElement('div'))
    doc.body.setAttribute('data-x', '2')
    await settle()
    expect(fired).toBe(1)

    await adapter.measureAll()
    doc.body.setAttribute('data-x', '3')
    await settle()
    expect(fired).toBe(2)
  })

  it('a stylesheet rewrite in the head dirties geometry even though the body never changed', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = adapterFor(doc)
    let fired = 0
    adapter.on('geometry:dirty', () => {
      fired += 1
    })
    await adapter.measureAll()
    adapter.applyOverlay('mc-classes', '.x { width: 10px }')
    await settle()
    expect(fired).toBe(1)
  })

  it('the adapter own selection chrome never dirties geometry once it is mounted', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = adapterFor(doc)
    let fired = 0
    adapter.on('geometry:dirty', () => {
      fired += 1
    })
    // The first ring mounts the overlay root and gives a static body `position: relative`, which can move
    // absolutely-positioned content: a real (and one-time) change, so geometry is read after it.
    adapter.select([{ nodeId: 'n1' }])
    await settle()
    await adapter.measureAll()
    // From here the rings are created, moved and removed inside the chrome root only.
    adapter.hover({ nodeId: 'n1' })
    adapter.select([])
    adapter.select([{ nodeId: 'n1' }])
    await settle()
    expect(fired).toBe(0)
  })

  it('dispose() stops the signal', async () => {
    const doc = freshDoc()
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const adapter = adapterFor(doc)
    let fired = 0
    adapter.on('geometry:dirty', () => {
      fired += 1
    })
    await adapter.measureAll()
    adapter.dispose()
    doc.body.setAttribute('data-x', '1')
    await settle()
    expect(fired).toBe(0)
  })
})
