/**
 * P5-D — vector edit mode's gesture contract, in happy-dom (the geometry that
 * needs real layout is `tests/e2e/studio-vector.e2e.ts`):
 *
 *   - a drag of 200 pointer moves makes ZERO editor-store commits and ONE
 *     `/save`, carrying one `svg-attr` edit for the stamped part;
 *   - the real in-frame `<path>` follows the pointer (D6) — and gets its old
 *     `d` back when the write does not land;
 *   - a press that never travels (a click) writes nothing;
 *   - Delete is the rung's, never the node's; Escape leaves the mode.
 *
 * The frame is a real iframe whose document holds the stamped svg; the two
 * measurements happy-dom cannot make (`getScreenCTM`, the board origin's rect)
 * are stubbed with known values, so the expected coordinates are exact.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { BoardVectorLayer } from '@site/canvas/BoardVectorLayer/BoardVectorLayer'
import { enterVectorEdit, exitVectorEdit, getVectorEditTarget } from '@site/canvas/BoardVectorLayer/vectorEditState'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { makeNode, makePage, makeSite } from '../fixtures'

const HOST = 'src/Icon.tsx:3:6'
const MARKUP = '<svg viewBox="0 0 24 24"><path data-studio-svg-part="4:8" d="M0 0L10 0L10 10"/></svg>'

let frameQueue: FrameRequestCallback[] = []
const realRaf = globalThis.requestAnimationFrame
const realCancel = globalThis.cancelAnimationFrame
const realFetch = globalThis.fetch
let saves: unknown[] = []
let cleanupDom: (() => void) | null = null

function flushFrames(): void {
  const queue = frameQueue
  frameQueue = []
  for (const callback of queue) callback(0)
}

function seedStore(): void {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [HOST] }),
      [HOST]: makeNode({ id: HOST, moduleId: 'base.svg', props: { svg: MARKUP } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    selectedNodeId: HOST,
    selectedNodeIds: [HOST],
    activeInlineEdit: null,
    zoom: 1,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** A board origin at client (0, 0), zoom 1, and a frame whose content starts at board (100, 50). */
function mountFrame(): SVGPathElement {
  const origin = document.createElement('div')
  origin.setAttribute('data-studio-board-origin', '')
  origin.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) })
  const frame = document.createElement('div')
  frame.setAttribute('data-frame-id', 'f1')
  const iframe = document.createElement('iframe')
  frame.appendChild(iframe)
  document.body.append(origin, frame)
  iframe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50, toJSON: () => ({}) })
  const doc = iframe.contentDocument!
  doc.body.innerHTML = MARKUP.replace('<svg ', `<svg data-node-id="${HOST}" `)
  const path = doc.querySelector('path') as unknown as SVGPathElement
  // viewBox scale 2, offset (10, 20) inside the frame.
  ;(path as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 })
  // The portal adapter is how the canvas reaches a frame's document (never a raw reach-in).
  registerFrameAdapter(iframe, new PortalFrameAdapter(doc), 'desktop')
  cleanupDom = () => {
    unregisterFrameAdapter(iframe)
    origin.remove()
    frame.remove()
  }
  return path
}

beforeEach(() => {
  frameQueue = []
  saves = []
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frameQueue.push(cb)
    return frameQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/admin/api/studio/save')) saves.push(JSON.parse(String(init?.body)))
    // Nothing landed: the canvas must put the old shape back.
    return new Response(
      JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false, refusals: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  seedStore()
})

afterEach(() => {
  act(() => exitVectorEdit())
  cleanup()
  cleanupDom?.()
  cleanupDom = null
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancel
  globalThis.fetch = realFetch
})

function enter(): { hit: SVGPathElement; path: SVGPathElement } {
  const path = mountFrame()
  const { container } = render(<BoardVectorLayer />)
  act(() => enterVectorEdit({ hostNodeId: HOST, pageId: 'page-1', frameId: 'f1' }))
  const hit = container.querySelector('[data-vector-hit]') as SVGPathElement
  expect(hit).not.toBeNull()
  return { hit, path }
}

describe('vector edit mode', () => {
  it('draws every anchor of the part in board units, as ONE path', () => {
    const { hit } = enter()
    const anchors = hit.ownerDocument.querySelector('[data-vector-anchors]')!.getAttribute('d')!
    // local (0,0) (10,0) (10,10) → ×2 + (10,20) + frame (100,50)
    expect(anchors.match(/M/g)?.length).toBe(3)
    expect(anchors).toContain('M106 66h8v8h-8z') // (110, 70) ± 4
    expect(anchors).toContain('M126 66h8v8h-8z') // (130, 70)
    expect(anchors).toContain('M126 86h8v8h-8z') // (130, 90)
  })

  it('a 200-move drag makes zero store commits, previews on the real path, and posts ONE svg-attr', async () => {
    const { hit, path } = enter()
    await act(async () => {
      fireEvent.pointerDown(hit, { pointerId: 1, button: 0, clientX: 130, clientY: 70 })
    })
    let commits = 0
    const unsubscribe = useEditorStore.subscribe(() => {
      commits += 1
    })
    for (let i = 1; i <= 200; i += 1) {
      fireEvent.pointerMove(hit, { pointerId: 1, clientX: 130 + i / 10, clientY: 70 + i / 10 })
      if (i % 4 === 0) flushFrames()
    }
    flushFrames()
    unsubscribe()
    expect(commits).toBe(0)
    // Board delta (20, 20) is (10, 10) in the path's own units.
    expect(path.getAttribute('d')).toBe('M0 0L20 10L10 10')

    await act(async () => {
      fireEvent.pointerUp(hit, { pointerId: 1, clientX: 150, clientY: 90 })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(saves).toHaveLength(1)
    expect((saves[0] as { edits: unknown[] }).edits).toEqual([
      { kind: 'svg-attr', nodeId: HOST, part: '4:8', partTag: 'path', set: { d: 'M0 0L20 10L10 10' } },
    ])
    // The server wrote nothing: the preview is taken back.
    expect(path.getAttribute('d')).toBe('M0 0L10 0L10 10')
  })

  it('a press that never travels writes nothing', async () => {
    const { hit, path } = enter()
    await act(async () => {
      fireEvent.pointerDown(hit, { pointerId: 1, button: 0, clientX: 130, clientY: 70 })
      fireEvent.pointerMove(hit, { pointerId: 1, clientX: 131, clientY: 70 })
      flushFrames()
      fireEvent.pointerUp(hit, { pointerId: 1, clientX: 131, clientY: 70 })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(saves).toHaveLength(0)
    expect(path.getAttribute('d')).toBe('M0 0L10 0L10 10')
  })

  it('Delete belongs to the rung (the svg is not deleted); Escape leaves the mode', () => {
    enter()
    renderHook(() => useEditorKeyDispatcher())
    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    document.dispatchEvent(del)
    expect(del.defaultPrevented).toBe(true)
    expect(useEditorStore.getState().site!.pages[0]!.nodes[HOST]).toBeDefined()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(getVectorEditTarget()).toBeNull()
  })

  it('leaves the mode when something else is selected', () => {
    enter()
    act(() => {
      useEditorStore.setState({ selectedNodeId: 'root', selectedNodeIds: ['root'] } as Parameters<typeof useEditorStore.setState>[0])
    })
    expect(getVectorEditTarget()).toBeNull()
  })
})
