/**
 * frameGeometryRegistry — lazy per-frame indexes, freshness, and the board
 * hit test. Adapters are stubs that only implement what the registry calls
 * (`measureAll`, `on`), so this proves the registry's own logic: nothing is
 * read until asked, a dirty ping makes the NEXT ask re-read, concurrent asks
 * share one read, and a hit is found in the topmost frame under the point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import type { FrameGeometrySnapshot, NodeGeometry } from '@site/canvas/frameGeometry/frameGeometryTypes'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { BOARD_ORIGIN_SPAN } from '@site/canvas/BoardCanvasLayer/canvasLayerGeometry'
import {
  getFrameGeometry,
  getFrameLocalGeometry,
  hitTestBoard,
  onFrameGeometryDirty,
  peekFrameGeometry,
  readFrameLocalGeometryNow,
} from '@site/canvas/frameGeometry/frameGeometryRegistry'
import { nodesUnderClientPoint } from '@site/canvas/canvasNodesUnderPoint'

function node(nodeId: string, x: number, y: number, width: number, height: number, parent: number): NodeGeometry {
  return { nodeId, rect: { x, y, width, height }, parent, clips: false, inert: false, transformed: false, paint: 0 }
}

class StubAdapter {
  reads = 0
  nodes: NodeGeometry[]
  private readonly dirtyHandlers = new Set<() => void>()
  constructor(nodes: NodeGeometry[]) {
    this.nodes = nodes
  }
  /** A same-origin frame can be read in the caller's task; a bridge frame cannot. */
  synchronous = false
  /** When set, `measureAll` waits for it (a bridge round trip), snapshotting the nodes AT the moment it resolves. */
  gate: Promise<void> | null = null
  measureAll(): Promise<FrameGeometrySnapshot> {
    this.reads += 1
    const gate = this.gate
    if (gate) return gate.then(() => ({ origin: { x: 0, y: 0 }, nodes: this.nodes, truncated: false }))
    return Promise.resolve({ origin: { x: 0, y: 0 }, nodes: this.nodes, truncated: false })
  }
  measureAllNow(): FrameGeometrySnapshot | null {
    if (!this.synchronous) return null
    this.reads += 1
    return { origin: { x: 0, y: 0 }, nodes: this.nodes, truncated: false }
  }
  on(event: FrameRuntimeEvent['type'], handler: () => void): () => void {
    if (event !== 'geometry:dirty') return () => {}
    this.dirtyHandlers.add(handler)
    return () => this.dirtyHandlers.delete(handler)
  }
  markDirty(): void {
    for (const handler of [...this.dirtyHandlers]) handler()
  }
  asAdapter(): FrameDocumentAdapter {
    return this as unknown as FrameDocumentAdapter
  }
}

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, x: left, y: top, width, height, toJSON: () => ({}) } as DOMRect
}

/** An iframe whose client box is stubbed (happy-dom has no layout). */
function iframeAt(left: number, top: number, width: number, height: number): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.getBoundingClientRect = () => rectOf(left, top, width, height)
  document.body.appendChild(iframe)
  return iframe
}

let boardOrigin: HTMLElement
const registered: HTMLIFrameElement[] = []

/** Registers a frame and remembers it for cleanup. */
function mount(iframe: HTMLIFrameElement, adapter: StubAdapter, breakpointId = 'studio'): void {
  registerFrameAdapter(iframe, adapter.asAdapter(), breakpointId)
  registered.push(iframe)
}

beforeEach(() => {
  document.body.innerHTML = ''
  boardOrigin = document.createElement('div')
  boardOrigin.setAttribute('data-studio-board-origin', '')
  // Board (0,0) is at client (100, 50); the board is painted at zoom 0.5.
  boardOrigin.getBoundingClientRect = () => rectOf(100, 50, BOARD_ORIGIN_SPAN * 0.5, 0)
  document.body.appendChild(boardOrigin)
})

afterEach(() => {
  for (const iframe of registered.splice(0)) unregisterFrameAdapter(iframe)
})

describe('frameGeometryRegistry — frame-local reads (SB-4: chrome beside the iframe)', () => {
  it('a frame-local read needs no board origin and returns the frame-viewport box', async () => {
    document.querySelector('[data-studio-board-origin]')?.remove()
    const adapter = new StubAdapter([node('a', 10, 20, 100, 50, -1)])
    const iframe = iframeAt(0, 0, 400, 400)
    mount(iframe, adapter)
    // A board-space ask has nothing to convert against; the frame-local one does not care.
    expect(await getFrameGeometry(iframe)).toBeNull()
    const index = await getFrameLocalGeometry(iframe)
    expect(index?.localRectOf('a')).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('does not disturb the board origin a board-space caller set', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(300, 150, 400, 400)
    mount(iframe, adapter)
    const board = await getFrameGeometry(iframe)
    expect(board?.origin).toEqual({ x: 400, y: 200 })
    const local = await getFrameLocalGeometry(iframe)
    expect(local).toBe(board)
    expect(local?.origin).toEqual({ x: 400, y: 200 })
  })

  it('readFrameLocalGeometryNow: the fresh index as is, a stale same-origin frame re-read in this task, a stale bridge frame null', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(0, 0, 400, 400)
    mount(iframe, adapter)
    // Never built, and a bridge frame cannot answer synchronously.
    expect(readFrameLocalGeometryNow(iframe)).toBeNull()
    const built = await getFrameLocalGeometry(iframe)
    expect(readFrameLocalGeometryNow(iframe)).toBe(built)
    expect(adapter.reads).toBe(1)

    adapter.markDirty()
    expect(readFrameLocalGeometryNow(iframe)).toBeNull()

    adapter.synchronous = true
    adapter.nodes = [node('a', 0, 0, 100, 100, -1), node('b', 5, 5, 10, 10, 0)]
    const rebuilt = readFrameLocalGeometryNow(iframe)
    expect(rebuilt).not.toBe(built)
    expect(rebuilt?.has('b')).toBe(true)
    // And it is cached: the next call is free.
    expect(readFrameLocalGeometryNow(iframe)).toBe(rebuilt)
    expect(adapter.reads).toBe(2)
  })

  it('a dirty ping during a slow read queues a NEWER read: nobody is handed the picture the frame already left', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(0, 0, 400, 400)
    mount(iframe, adapter)
    let release: () => void = () => {}
    adapter.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = getFrameLocalGeometry(iframe)
    adapter.nodes = [node('a', 0, 0, 100, 100, -1), node('late', 1, 1, 5, 5, 0)]
    adapter.markDirty()
    // The asker after the ping must not join the read that started before it.
    const second = getFrameLocalGeometry(iframe)
    release()
    const [one, two] = await Promise.all([first, second])
    expect(adapter.reads).toBe(2)
    expect(two).not.toBe(one)
    expect(two?.has('late')).toBe(true)
    expect(peekFrameGeometry(iframe)).toBe(two)
  })
})

describe('frameGeometryRegistry — building and freshness', () => {
  it('reads nothing until asked, then once, then serves the cache', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    expect(adapter.reads).toBe(0)
    expect(peekFrameGeometry(iframe)).toBeNull()

    const first = await getFrameGeometry(iframe)
    const second = await getFrameGeometry(iframe)

    expect(adapter.reads).toBe(1)
    expect(second).toBe(first)
    expect(peekFrameGeometry(iframe)).toBe(first)
  })

  it('concurrent askers share one read', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    const [one, two] = await Promise.all([getFrameGeometry(iframe), getFrameGeometry(iframe)])
    expect(adapter.reads).toBe(1)
    expect(one).toBe(two)
  })

  it('a geometry:dirty ping makes the next ask re-read, and peek keeps the stale build meanwhile', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    const before = await getFrameGeometry(iframe)
    adapter.nodes = [node('a', 0, 0, 100, 100, -1), node('b', 10, 10, 20, 20, 0)]
    adapter.markDirty()

    expect(peekFrameGeometry(iframe)).toBe(before)
    const after = await getFrameGeometry(iframe)
    expect(adapter.reads).toBe(2)
    expect(after).not.toBe(before)
    expect(after?.has('b')).toBe(true)
  })

  it('a ping that lands while a read is in flight is not lost', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    const pending = getFrameGeometry(iframe)
    adapter.markDirty()
    await pending
    await getFrameGeometry(iframe)
    expect(adapter.reads).toBe(2)
  })

  it('an unregistered iframe has no geometry, and its adapter is no longer listened to', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    await getFrameGeometry(iframe)
    unregisterFrameAdapter(iframe)
    expect(await getFrameGeometry(iframe)).toBeNull()
    expect(peekFrameGeometry(iframe)).toBeNull()
    const seen: HTMLIFrameElement[] = []
    const stop = onFrameGeometryDirty((dirty) => seen.push(dirty))
    adapter.markDirty()
    stop()
    expect(seen).toEqual([])
  })

  it('onFrameGeometryDirty reports which frame went stale', async () => {
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    await getFrameGeometry(iframe)
    const seen: HTMLIFrameElement[] = []
    const stop = onFrameGeometryDirty((dirty) => seen.push(dirty))
    adapter.markDirty()
    stop()
    adapter.markDirty()
    expect(seen).toEqual([iframe])
  })

  it('a failed read yields null and is retried by the next ask', async () => {
    const adapter = new StubAdapter([])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    const original = adapter.measureAll.bind(adapter)
    adapter.measureAll = () => Promise.reject(new Error('timeout'))
    const logged = console.error
    console.error = () => {}
    try {
      expect(await getFrameGeometry(iframe)).toBeNull()
    } finally {
      console.error = logged
    }
    adapter.measureAll = original
    expect(await getFrameGeometry(iframe)).not.toBeNull()
  })

  it('there is nothing to build off a Studio board (no board-origin element)', async () => {
    boardOrigin.remove()
    const adapter = new StubAdapter([node('a', 0, 0, 100, 100, -1)])
    const iframe = iframeAt(100, 50, 50, 50)
    mount(iframe, adapter)
    expect(await getFrameGeometry(iframe)).toBeNull()
    expect(adapter.reads).toBe(0)
  })
})

describe('frameGeometryRegistry — board hit test', () => {
  it('converts the client point to board units through the painted zoom and finds the node', async () => {
    // Frame at board (200, 100): client = 100 + 200*0.5, 50 + 100*0.5 = (200, 100); 400x300 board px = 200x150 client px.
    const adapter = new StubAdapter([node('page', 0, 0, 400, 300, -1), node('card', 40, 40, 100, 100, 0)])
    mount(iframeAt(200, 100, 200, 150), adapter, 'desktop')

    // Client (230, 130) = board (260, 160) = frame-local (60, 60): inside card (40..140).
    const found = await hitTestBoard({ x: 230, y: 130 })

    expect(found?.breakpointId).toBe('desktop')
    expect(found?.hits.map((hit) => hit.nodeId)).toEqual(['card', 'page'])
    expect(found?.hits[0]?.rect).toEqual({ x: 240, y: 140, width: 100, height: 100 })
  })

  it('returns null over empty board and reads no frame for it', async () => {
    const adapter = new StubAdapter([node('page', 0, 0, 400, 300, -1)])
    mount(iframeAt(200, 100, 200, 150), adapter)
    expect(await hitTestBoard({ x: 10, y: 10 })).toBeNull()
    expect(adapter.reads).toBe(0)
  })

  it('picks the topmost frame (last registered) when two overlap the point', async () => {
    const under = new StubAdapter([node('under', 0, 0, 400, 300, -1)])
    const over = new StubAdapter([node('over', 0, 0, 400, 300, -1)])
    mount(iframeAt(200, 100, 200, 150), under, 'a')
    mount(iframeAt(200, 100, 200, 150), over, 'b')
    const found = await hitTestBoard({ x: 230, y: 130 })
    expect(found?.breakpointId).toBe('b')
    expect(under.reads).toBe(0)
  })

  it('a dragged frame answers at its new place without a re-read', async () => {
    const adapter = new StubAdapter([node('page', 0, 0, 400, 300, -1)])
    let left = 200
    const iframe = document.createElement('iframe')
    iframe.getBoundingClientRect = () => rectOf(left, 100, 200, 150)
    document.body.appendChild(iframe)
    mount(iframe, adapter)
    expect((await hitTestBoard({ x: 230, y: 130 }))?.hits[0]?.nodeId).toBe('page')

    left = 600
    expect(await hitTestBoard({ x: 230, y: 130 })).toBeNull()
    expect((await hitTestBoard({ x: 630, y: 130 }))?.hits[0]?.nodeId).toBe('page')
    expect(adapter.reads).toBe(1)
  })
})

describe('nodesUnderClientPoint', () => {
  it('lists the layers under the point innermost first, capped', async () => {
    const nodes = [node('root', 0, 0, 400, 300, -1)]
    for (let i = 1; i <= 20; i += 1) nodes.push(node(`n${i}`, 0, 0, 400 - i, 300 - i, i - 1))
    mount(iframeAt(200, 100, 200, 150), new StubAdapter(nodes))
    const ids = await nodesUnderClientPoint(230, 130)
    expect(ids).toHaveLength(12)
    expect(ids[0]).toBe('n20')
    expect(ids[1]).toBe('n19')
  })

  it('is empty over empty board', async () => {
    expect(await nodesUnderClientPoint(5, 5)).toEqual([])
  })
})
