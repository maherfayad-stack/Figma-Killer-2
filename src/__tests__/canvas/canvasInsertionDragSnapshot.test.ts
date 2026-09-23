/**
 * `speed-06` — the per-drag candidate snapshot `useCanvasInsertionDrag` now
 * resolves against instead of scanning the DOM on every pointer move.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { beginInsertionDragSnapshotSession } from '@site/canvas/canvasInsertionDragSnapshot'
import type { DropCandidateGeometry, FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'

function node(id: string, moduleId: string, children: string[] = [], hidden = false): PageNode {
  return { id, moduleId, props: {}, breakpointOverrides: {}, children, ...(hidden ? { hidden } : {}) }
}

function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return { id: 'page', slug: 'index', title: 'Home', rootNodeId, nodes }
}

function rect(init: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    x: init.x, y: init.y, left: init.x, top: init.y,
    right: init.x + init.width, bottom: init.y + init.height,
    width: init.width, height: init.height, toJSON: () => ({}),
  } as DOMRect
}

/** A fake `FrameDocumentAdapter` exposing only `on`/`measureDropCandidates` — everything this module touches. */
function makeFakeAdapter(resolveWith: () => Promise<DropCandidateGeometry[]>) {
  const handlers = new Map<string, Set<(event: FrameRuntimeEvent) => void>>()
  let calls = 0
  const adapter = {
    on: (type: string, handler: (event: FrameRuntimeEvent) => void) => {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    },
    measureDropCandidates: () => {
      calls += 1
      return resolveWith()
    },
  } as unknown as FrameDocumentAdapter
  return { adapter, emit: (type: string) => handlers.get(type)?.forEach((h) => h({ type } as FrameRuntimeEvent)), callCount: () => calls }
}

function mountViewportAndIframe() {
  const viewport = document.createElement('div')
  viewport.getBoundingClientRect = () => rect({ x: 0, y: 0, width: 400, height: 400 })
  const iframe = document.createElement('iframe')
  iframe.getBoundingClientRect = () => rect({ x: 0, y: 0, width: 400, height: 400 })
  Object.defineProperty(iframe, 'offsetWidth', { value: 400, configurable: true })
  viewport.appendChild(iframe)
  document.body.appendChild(viewport)
  return { viewport, iframe }
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** Several microtask ticks — enough for a `.then().catch().then()` chain to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('beginInsertionDragSnapshotSession', () => {
  it('falls back to the synchronous DOM scan for an iframe with no registered adapter', () => {
    const viewport = document.createElement('div')
    viewport.getBoundingClientRect = () => rect({ x: 0, y: 0, width: 400, height: 400 })
    const container = document.createElement('section')
    container.dataset.nodeId = 'container'
    container.getBoundingClientRect = () => rect({ x: 20, y: 20, width: 200, height: 120 })
    viewport.appendChild(container)
    document.body.appendChild(viewport)

    const tree = page({ root: node('root', 'base.body', ['container']), container: node('container', 'base.container') })
    const session = beginInsertionDragSnapshotSession()

    const candidates = session.candidatesFor(viewport, null, tree)
    expect(candidates.map((c) => c.nodeId)).toEqual(['container'])
    session.dispose()
  })

  it('is empty on the first call to a real (adapter-backed) iframe, then resolves after the round trip', async () => {
    const { viewport, iframe } = mountViewportAndIframe()
    const { adapter, callCount } = makeFakeAdapter(() =>
      Promise.resolve([{ nodeId: 'container', rect: { x: 20, y: 20, width: 200, height: 120 }, axis: 'vertical', reversed: false }]),
    )
    registerFrameAdapter(iframe, adapter)
    const tree = page({ root: node('root', 'base.body', ['container']), container: node('container', 'base.container') })
    const session = beginInsertionDragSnapshotSession()

    expect(session.candidatesFor(viewport, iframe, tree)).toEqual([])
    await flushMicrotasks()

    const candidates = session.candidatesFor(viewport, iframe, tree)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.nodeId).toBe('container')
    expect(candidates[0]!.rect.left).toBe(20)
    expect(callCount()).toBe(1)

    // A second call for the SAME iframe re-measures nothing — the cache holds.
    session.candidatesFor(viewport, iframe, tree)
    expect(callCount()).toBe(1)

    session.dispose()
    unregisterFrameAdapter(iframe)
  })

  it('drops a candidate whose node is hidden or unknown to the tree', async () => {
    const { viewport, iframe } = mountViewportAndIframe()
    const { adapter } = makeFakeAdapter(() =>
      Promise.resolve([
        { nodeId: 'container', rect: { x: 20, y: 20, width: 200, height: 120 }, axis: 'vertical', reversed: false },
        { nodeId: 'ghost', rect: { x: 0, y: 0, width: 10, height: 10 }, axis: 'vertical', reversed: false },
        { nodeId: 'hiddenNode', rect: { x: 0, y: 0, width: 10, height: 10 }, axis: 'vertical', reversed: false },
      ]),
    )
    registerFrameAdapter(iframe, adapter)
    const tree = page({
      root: node('root', 'base.body', ['container', 'hiddenNode']),
      container: node('container', 'base.container'),
      hiddenNode: node('hiddenNode', 'base.container', [], true),
    })
    const session = beginInsertionDragSnapshotSession()
    session.candidatesFor(viewport, iframe, tree)
    await flushMicrotasks()

    const candidates = session.candidatesFor(viewport, iframe, tree)
    expect(candidates.map((c) => c.nodeId)).toEqual(['container'])

    session.dispose()
    unregisterFrameAdapter(iframe)
  })

  it('re-measures a surface on its adapter\'s hmr:after', async () => {
    const { viewport, iframe } = mountViewportAndIframe()
    let width = 200
    const { adapter, emit, callCount } = makeFakeAdapter(() =>
      Promise.resolve([{ nodeId: 'container', rect: { x: 20, y: 20, width, height: 120 }, axis: 'vertical', reversed: false }]),
    )
    registerFrameAdapter(iframe, adapter)
    const tree = page({ root: node('root', 'base.body', ['container']), container: node('container', 'base.container') })
    const session = beginInsertionDragSnapshotSession()

    session.candidatesFor(viewport, iframe, tree)
    await flushMicrotasks()
    expect(session.candidatesFor(viewport, iframe, tree)[0]!.rect.width).toBe(200)

    width = 260
    emit('hmr:after')
    await flushMicrotasks()
    expect(callCount()).toBe(2)
    expect(session.candidatesFor(viewport, iframe, tree)[0]!.rect.width).toBe(260)

    session.dispose()
    unregisterFrameAdapter(iframe)
  })
})
