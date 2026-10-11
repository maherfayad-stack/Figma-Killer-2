/**
 * SB-3 — the in-frame runtime's `measureAll` reply and its `geometry:dirty`
 * ping, driven through `createStudioRuntimeBridge.handleMessage` the way a Tier
 * 2 live frame receives them. Boxes are stubbed (happy-dom has no layout).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  collectNodeGeometry,
  createStudioRuntimeBridge,
  GEOMETRY_NODES_MAX,
  OutboundRuntimeMessageSchema,
  paintRankOf,
  type StudioRuntimeBridge,
} from '@core/studio-runtime'
import { Value } from '@sinclair/typebox/value'

const PARENT_ORIGIN = 'https://parent.test'

let bridge: StudioRuntimeBridge | null = null

afterEach(() => {
  bridge?.dispose()
  bridge = null
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

function boot(): Array<Record<string, unknown>> {
  const posted: Array<Record<string, unknown>> = []
  const parentWindow = { postMessage: (data: { message: Record<string, unknown> }) => posted.push(data.message) } as unknown as Window
  bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow, document })
  return posted
}

function box(el: Element, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + width, bottom: y + height, x, y, width, height, toJSON: () => ({}) }) as DOMRect
}

function lastOf(posted: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
  const found = [...posted].reverse().find((message) => message.type === type)
  if (!found) throw new Error(`no ${type} was posted`)
  return found
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('measureAll — the reply', () => {
  it('answers with every boxed node: stamp id, same-stamp occurrence, body-relative rect, parent links', () => {
    document.body.innerHTML = `
      <div data-node-id="list">
        <div data-node-id="row"><i data-node-id="cell"></i></div>
        <div data-node-id="row"><i data-node-id="cell"></i></div>
      </div>`
    box(document.body, 4, 4, 300, 300)
    box(document.querySelector('[data-node-id="list"]')!, 4, 4, 300, 100)
    const rows = document.querySelectorAll('[data-node-id="row"]')
    box(rows[0]!, 4, 4, 300, 40)
    box(rows[1]!, 4, 54, 300, 40)
    const cells = document.querySelectorAll('[data-node-id="cell"]')
    box(cells[0]!, 8, 8, 20, 20)
    box(cells[1]!, 8, 58, 20, 20)
    const posted = boot()

    bridge!.handleMessage({ type: 'measureAll', requestId: 'm1' })

    const reply = lastOf(posted, 'measureAll:result') as unknown as {
      requestId: string
      origin: { x: number; y: number }
      truncated: boolean
      nodes: Array<{ nodeId: string; occurrenceIndex: number; parent: number; rect: { x: number; y: number; width: number; height: number } }>
    }
    expect(reply.requestId).toBe('m1')
    expect(reply.origin).toEqual({ x: 4, y: 4 })
    expect(reply.truncated).toBe(false)
    expect(reply.nodes.map((n) => [n.nodeId, n.occurrenceIndex, n.parent])).toEqual([
      ['list', 0, -1],
      ['row', 0, 0],
      ['cell', 0, 1],
      ['row', 1, 0],
      ['cell', 1, 3],
    ])
    expect(reply.nodes[2]!.rect).toEqual({ x: 4, y: 4, width: 20, height: 20 })
    // The reply must satisfy the wire schema the parent checks before reading a field.
    expect(Value.Check(OutboundRuntimeMessageSchema, lastOf(posted, 'measureAll:result'))).toBe(true)
  })

  it('counts the occurrence index across unlisted (boxless) same-stamp nodes, the way hit resolution does', () => {
    document.body.innerHTML = `<div data-node-id="row"></div><div data-node-id="row"></div>`
    box(document.body, 0, 0, 100, 100)
    // Only the SECOND occurrence has a box.
    box(document.querySelectorAll('[data-node-id="row"]')[1]!, 0, 50, 100, 20)
    const posted = boot()
    bridge!.handleMessage({ type: 'measureAll', requestId: 'm' })
    const reply = lastOf(posted, 'measureAll:result') as unknown as { nodes: Array<{ nodeId: string; occurrenceIndex: number }> }
    expect(reply.nodes.map((n) => [n.nodeId, n.occurrenceIndex])).toEqual([['row', 1]])
  })

  it('is bounded: more stamped nodes than the cap yields a truncated prefix, not an oversized reply', () => {
    const html: string[] = []
    for (let i = 0; i < GEOMETRY_NODES_MAX + 25; i += 1) html.push(`<i data-node-id="n${i}"></i>`)
    document.body.innerHTML = html.join('')
    box(document.body, 0, 0, 100, 100)
    for (const el of document.querySelectorAll('[data-node-id]')) box(el, 0, 0, 5, 5)
    const read = collectNodeGeometry(document, window)
    expect(read.nodes).toHaveLength(GEOMETRY_NODES_MAX)
    expect(read.truncated).toBe(true)
  })

  it('an empty page replies with no nodes', () => {
    const posted = boot()
    bridge!.handleMessage({ type: 'measureAll', requestId: 'empty' })
    expect((lastOf(posted, 'measureAll:result') as unknown as { nodes: unknown[] }).nodes).toEqual([])
  })
})

describe('measureAll — paint rank', () => {
  it('doubles z-index and lifts any positioned element above in-flow content', () => {
    expect(paintRankOf('static', 'auto')).toBe(0)
    expect(paintRankOf('static', '5')).toBe(0)
    expect(paintRankOf('relative', 'auto')).toBe(1)
    expect(paintRankOf('absolute', '2')).toBe(5)
    expect(paintRankOf('fixed', '-1')).toBe(-1)
    expect(paintRankOf('', '')).toBe(0)
  })
})

describe('geometry:dirty', () => {
  it('posts nothing for page mutations until the parent has asked for geometry', async () => {
    document.body.innerHTML = `<div data-node-id="a"></div>`
    const posted = boot()
    document.body.appendChild(document.createElement('div'))
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(0)
  })

  it('posts once per read: a burst of mutations is one ping, and the next read re-arms it', async () => {
    document.body.innerHTML = `<div data-node-id="a"></div>`
    box(document.body, 0, 0, 100, 100)
    const posted = boot()
    bridge!.handleMessage({ type: 'measureAll', requestId: 'first' })

    document.body.appendChild(document.createElement('div'))
    document.body.setAttribute('data-x', '1')
    await settle()
    document.body.appendChild(document.createElement('div'))
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(1)

    bridge!.handleMessage({ type: 'measureAll', requestId: 'second' })
    document.body.setAttribute('data-x', '2')
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(2)
  })

  it('a stylesheet written into the head dirties geometry, but the selection chrome stylesheet does not', async () => {
    document.body.innerHTML = `<div data-node-id="a"></div>`
    box(document.body, 0, 0, 100, 100)
    const posted = boot()
    bridge!.handleMessage({ type: 'measureAll', requestId: 'r' })

    // The runtime mounts its own chrome stylesheet on the first select: not the page changing.
    bridge!.handleMessage({ type: 'select', refs: [{ nodeId: 'a', occurrenceIndex: 0 }] })
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(0)

    bridge!.handleMessage({ type: 'applyOverlay', id: 'mc-classes', css: '.a { width: 9px }' })
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(1)
  })

  it('stops after dispose', async () => {
    document.body.innerHTML = `<div data-node-id="a"></div>`
    box(document.body, 0, 0, 100, 100)
    const posted = boot()
    bridge!.handleMessage({ type: 'measureAll', requestId: 'r' })
    bridge!.dispose()
    bridge = null
    document.body.setAttribute('data-x', '1')
    await settle()
    expect(posted.filter((message) => message.type === 'geometry:dirty')).toHaveLength(0)
  })
})
