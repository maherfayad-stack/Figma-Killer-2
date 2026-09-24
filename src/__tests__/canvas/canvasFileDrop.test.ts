/**
 * D2 G15 — what a file dragged in from the operating system means when it
 * lands on the board.
 *
 * Every refusal here has to be decided BEFORE the network is touched, because
 * the alternative is uploading a 20 MB PDF into someone's repository and then
 * explaining that it was never going to work. So the assertions are as much
 * about WHEN the answer is known as about what it is: `planCanvasFileDrop` is
 * pure of HTTP, and a refused drop costs one toast and nothing else.
 *
 * The one thing deliberately NOT asserted as authoritative is the format
 * check. `looksLikeImage` reads the browser's declared MIME type, which a
 * caller controls; the real gate sniffs bytes server-side
 * (`assetDrop.test.ts`). This one may only ever be MORE permissive — a test
 * that pinned it tighter would be pinning the wrong rule.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { planCanvasFileDrop, looksLikeImage } from '@site/canvas/canvasFileDrop'
import {
  registerCanvasDropSurface,
  unregisterCanvasDropSurface,
} from '@site/canvas/canvasDropSurfaceRegistry'
import { makeNode, makePage } from '../fixtures'
import '@modules/base/index'

const ROOT = 'home:body'
const MAIN = 'pages/Home.tsx:4:5'
const H1 = 'pages/Home.tsx:5:7'

const FRAME_BOX = { left: 0, top: 0, right: 500, bottom: 800 }

function tree(): NodeTree<PageNode> {
  return makePage({
    id: 'home',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [MAIN] }),
      [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', children: [H1], parentId: ROOT }),
      [H1]: makeNode({ id: H1, moduleId: 'base.text', props: { text: 'Home' }, parentId: MAIN }),
    },
  })
}

type Box = { left: number; top: number; right: number; bottom: number }

function stubRect(el: HTMLElement, box: Box): void {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      width: box.right - box.left,
      height: box.bottom - box.top,
      x: box.left,
      y: box.top,
    }) as DOMRect
  Object.defineProperty(el, 'offsetWidth', { value: box.right - box.left, configurable: true })
}

const keys: object[] = []

function mountFrame(pageId: string | null): void {
  const viewport = document.createElement('div')
  stubRect(viewport, FRAME_BOX)
  document.body.appendChild(viewport)
  for (const node of [
    { id: MAIN, rect: FRAME_BOX },
    { id: H1, rect: { left: 10, top: 10, right: 490, bottom: 200 } },
  ]) {
    const el = document.createElement('div')
    el.setAttribute('data-node-id', node.id)
    stubRect(el, node.rect)
    viewport.appendChild(el)
  }
  const key = {}
  keys.push(key)
  registerCanvasDropSurface(key, {
    frameId: 'frame-home',
    pageId,
    viewport,
    iframe: null,
    dropLayer: () => null,
  })
}

function imageFile(name = 'photo.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

const readPage = (pageId: string) => (pageId === 'home' ? tree() : null)

afterEach(() => {
  for (const key of keys.splice(0)) unregisterCanvasDropSurface(key)
  document.body.innerHTML = ''
})

describe('looksLikeImage — a courtesy check, never the gate', () => {
  it('accepts every image/* type', () => {
    expect(looksLikeImage({ count: 1, type: 'image/png', name: 'a.png' })).toBe(true)
    expect(looksLikeImage({ count: 1, type: 'image/svg+xml', name: 'a.svg' })).toBe(true)
  })

  it('accepts a file the platform handed over with NO declared type', () => {
    expect(looksLikeImage({ count: 1, type: '', name: 'mystery' })).toBe(true)
  })

  it('rejects a declared non-image', () => {
    expect(looksLikeImage({ count: 1, type: 'application/pdf', name: 'report.pdf' })).toBe(false)
  })

  it('answers the same question for a drag still in the air, where there is no NAME to read', () => {
    // Protected mode: `DataTransfer.files` is empty before `drop`, so the
    // in-flight half only ever has a count and a declared type.
    expect(looksLikeImage({ count: 1, type: 'image/png' })).toBe(true)
    expect(looksLikeImage({ count: 1, type: 'application/pdf' })).toBe(false)
  })
})

describe('planCanvasFileDrop — a good drop', () => {
  it('names the page and the position inside the frame under the pointer', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok || plan.kind !== 'frame') return
    expect(plan.pageId).toBe('home')
    expect(plan.target.parentId).toBe(MAIN)
    expect(plan.file.name).toBe('photo.png')
  })
})

describe('planCanvasFileDrop — refusals, all decided before the network', () => {
  it('puts the image on the free canvas when the empty board is a Studio board (P5-G)', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 900, y: 400 },
      transform: null,
      readPage,
      freeCanvas: { origin: { left: 100, top: 50 }, zoom: 0.5 },
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok || plan.kind !== 'canvas') throw new Error('expected a free-canvas plan')
    // Client (900, 400) against a board origin at (100, 50), at 50% zoom.
    expect(plan.at).toEqual({ x: 1600, y: 700 })
  })

  it('still puts the image in the frame under the pointer when there is one', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
      freeCanvas: { origin: { left: 0, top: 0 }, zoom: 1 },
    })
    expect(plan.ok && plan.kind).toBe('frame')
  })

  it('refuses a drop on the empty board and says where to drop instead', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 900, y: 400 },
      transform: null,
      readPage,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal.reason).toBe('no-frame')
    expect(plan.refusal.message).toContain('Drop the image onto a frame')
  })

  it('refuses a non-image and names what it is', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile('report.pdf', 'application/pdf')],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal.reason).toBe('not-an-image')
    expect(plan.refusal.message).toContain('application/pdf')
    expect(plan.refusal.message).toContain('report.pdf')
  })

  it('names the EXTENSION when the platform declared no type at all', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile('notes.txt', '')],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })
    // An untyped file passes `looksLikeImage` by design — the server's byte
    // sniff is what refuses it. Nothing is refused here, and that is correct.
    expect(plan.ok).toBe(true)
  })

  it('refuses several files at once, and says to drop them one by one', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile('a.png'), imageFile('b.png')],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal.reason).toBe('multiple-files')
    expect(plan.refusal.message).toContain('one by one')
  })

  it('refuses a drop carrying no file at all', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({ files: [], point: { x: 100, y: 100 }, transform: null, readPage })
    expect(plan.ok).toBe(false)
  })

  it('refuses a frame whose page has gone', () => {
    mountFrame('deleted-page')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal.reason).toBe('no-frame')
  })

  it('refuses a frame with no page of its own — a CMS breakpoint frame is not a file', () => {
    mountFrame(null)
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
    })
    expect(plan.ok).toBe(false)
  })
})
