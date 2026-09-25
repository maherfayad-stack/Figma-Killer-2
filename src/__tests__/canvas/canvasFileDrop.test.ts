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
import {
  NO_DROP_MODIFIERS,
  looksLikeImage,
  planCanvasFileDrop,
  resolveCanvasFileDropIntent,
  type CanvasFileDropModifiers,
} from '@site/canvas/canvasFileDrop'
import type { DropContainerBox } from '@site/canvas/canvasImageDropPlacement'
import {
  registerCanvasDropSurface,
  unregisterCanvasDropSurface,
} from '@site/canvas/canvasDropSurfaceRegistry'
import { makeNode, makePage } from '../fixtures'
import '@modules/base/index'

const ROOT = 'home:body'
const MAIN = 'pages/Home.tsx:4:5'
const H1 = 'pages/Home.tsx:5:7'
const IMG = 'pages/Home.tsx:6:7'
const CODE_IMG = 'pages/Home.tsx:7:7'

const FRAME_BOX = { left: 0, top: 0, right: 500, bottom: 800 }

function tree(): NodeTree<PageNode> {
  return makePage({
    id: 'home',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [MAIN] }),
      [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', children: [H1, IMG, CODE_IMG], parentId: ROOT }),
      [H1]: makeNode({ id: H1, moduleId: 'base.text', props: { text: 'Home' }, parentId: MAIN }),
      [IMG]: makeNode({ id: IMG, moduleId: 'base.image', props: { src: '/old.png' }, parentId: MAIN }),
      // `src={pickHero(locale)}` — computed in code, no literal and no import to repoint.
      [CODE_IMG]: makeNode({ id: CODE_IMG, moduleId: 'base.image', props: { src: '/x.png' }, codeProps: ['src'], parentId: MAIN }),
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
    { id: IMG, rect: { left: 10, top: 220, right: 200, bottom: 400 } },
    { id: CODE_IMG, rect: { left: 220, top: 220, right: 400, bottom: 400 } },
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


function plan(files: File[], point = { x: 100, y: 100 }, modifiers: CanvasFileDropModifiers = NO_DROP_MODIFIERS) {
  return planCanvasFileDrop({ files, point, modifiers, transform: null, readPage })
}

describe('looksLikeImage — a courtesy check, never the gate', () => {
  it('accepts every image/* type', () => {
    expect(looksLikeImage('image/png')).toBe(true)
    expect(looksLikeImage('image/svg+xml')).toBe(true)
  })

  it('accepts a file the platform handed over with NO declared type', () => {
    expect(looksLikeImage('')).toBe(true)
  })

  it('rejects a declared non-image', () => {
    expect(looksLikeImage('application/pdf')).toBe(false)
  })
})

describe('planCanvasFileDrop — a good drop', () => {
  it('names the page and the position inside the frame under the pointer', () => {
    mountFrame('home')
    const result = plan([imageFile()])

    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'frame') throw new Error('expected a frame plan')
    expect(result.pageId).toBe('home')
    expect(result.action.kind).toBe('insert')
    if (result.action.kind !== 'insert') return
    expect(result.action.target.parentId).toBe(MAIN)
    expect(result.files.map((file) => file.name)).toEqual(['photo.png'])
  })

  it('P5-B IMG-2 — three files are ONE plan that inserts all three, in drop order', () => {
    // Before P5-B this refused `multiple-files` ("drop them one by one").
    mountFrame('home')
    const result = plan([imageFile('a.png'), imageFile('b.jpg', 'image/jpeg'), imageFile('c.webp', 'image/webp')])

    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'frame') throw new Error('expected a frame plan')
    expect(result.action.kind).toBe('insert')
    expect(result.files.map((file) => file.name)).toEqual(['a.png', 'b.jpg', 'c.webp'])
    expect(result.skipped).toEqual([])
  })

  it('adds the images of a mixed drop and names the rest as left out', () => {
    mountFrame('home')
    const result = plan([imageFile('a.png'), imageFile('report.pdf', 'application/pdf')])

    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'frame') throw new Error('expected a frame plan')
    expect(result.files.map((file) => file.name)).toEqual(['a.png'])
    expect(result.skipped.map((file) => file.name)).toEqual(['report.pdf'])
  })
})

describe('planCanvasFileDrop — onto an image (IMG-3)', () => {
  const overImg = { x: 100, y: 300 }

  it('one file dropped ON an <img> replaces it', () => {
    mountFrame('home')
    const result = plan([imageFile()], overImg)
    expect(result.ok && result.kind === 'frame' && result.action).toEqual({ kind: 'replace', nodeId: IMG })
  })

  it('alt inserts beside the image instead', () => {
    mountFrame('home')
    const result = plan([imageFile()], overImg, { ...NO_DROP_MODIFIERS, alt: true })
    expect(result.ok && result.kind === 'frame' && result.action.kind).toBe('insert')
  })

  it('several files never replace one image — they are inserted', () => {
    mountFrame('home')
    const result = plan([imageFile('a.png'), imageFile('b.png')], overImg)
    expect(result.ok && result.kind === 'frame' && result.action.kind).toBe('insert')
  })

  it('refuses to replace an image whose src is computed in code, and offers alt', () => {
    mountFrame('home')
    const result = plan([imageFile()], { x: 300, y: 300 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('locked-image')
    expect(result.refusal.message).toMatch(/Hold (⌥|Alt)/)
  })
})

describe('planCanvasFileDrop — shift sets a background (IMG-7)', () => {
  it('names the container under the pointer', () => {
    mountFrame('home')
    const result = plan([imageFile()], { x: 100, y: 100 }, { ...NO_DROP_MODIFIERS, shift: true })
    expect(result.ok && result.kind === 'frame' && result.action).toEqual({ kind: 'background', nodeId: MAIN })
  })

  it('refuses more than one file — a background takes one image', () => {
    mountFrame('home')
    const result = plan([imageFile('a.png'), imageFile('b.png')], { x: 100, y: 100 }, { ...NO_DROP_MODIFIERS, shift: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('one-background')
  })
})

describe('resolveCanvasFileDropIntent — cmd places absolutely, the K6 rule (IMG-9)', () => {
  const candidates = [
    { nodeId: MAIN, depth: 1, rect: { left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 }, axis: 'vertical' as const },
    { nodeId: H1, depth: 2, rect: { left: 10, top: 10, right: 490, bottom: 200, width: 480, height: 190 }, axis: 'vertical' as const },
  ]
  const box = (position: string): DropContainerBox => ({
    contentWidth: 460,
    paddingOrigin: { x: 0, y: 0 },
    paddingWidth: 500,
    position,
    direction: 'ltr',
  })

  it('writes the pointer offset from the padding box inside a positioned container', () => {
    const intent = resolveCanvasFileDropIntent({
      tree: tree(),
      candidates,
      point: { x: 120, y: 60 },
      zoom: 1,
      facts: { types: ['image/png'] },
      modifiers: { ...NO_DROP_MODIFIERS, absolute: true },
      measureContainer: () => box('relative'),
    })
    expect(intent.ok && intent.action.kind === 'insert' && intent.action.absolute).toEqual({
      property: 'left',
      inline: 120,
      top: 60,
    })
  })

  it('refuses a static container with the K6 remedy, and never measures without cmd', () => {
    let measured = 0
    const input = {
      tree: tree(),
      candidates,
      point: { x: 120, y: 60 },
      zoom: 1,
      facts: { types: ['image/png'] },
      measureContainer: () => {
        measured += 1
        return box('static')
      },
    }
    const refused = resolveCanvasFileDropIntent({ ...input, modifiers: { ...NO_DROP_MODIFIERS, absolute: true } })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal.reason).toBe('static-parent')
    expect(refused.refusal.staticParent?.parentNodeId).toBe(MAIN)
    expect(refused.refusal.message).toContain('position: relative')

    measured = 0
    const flow = resolveCanvasFileDropIntent({ ...input, modifiers: NO_DROP_MODIFIERS })
    expect(flow.ok && flow.action.kind === 'insert' && flow.action.absolute).toBe(null)
    expect(measured).toBe(0)
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
      modifiers: NO_DROP_MODIFIERS,
      freeCanvas: { left: 100, top: 50, zoom: 0.5 },
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok || plan.kind !== 'canvas') throw new Error('expected a free-canvas plan')
    // Client (900, 400) against a board origin at (100, 50), at 50% zoom.
    expect(plan.at).toEqual({ x: 1600, y: 700 })
  })

  it('takes every image of a multi-file drop onto the free canvas, whatever keys are held, and names the rest (P5-G + P5-B)', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile('a.png'), imageFile('notes.pdf', 'application/pdf'), imageFile('b.jpg', 'image/jpeg')],
      point: { x: 900, y: 400 },
      transform: null,
      readPage,
      modifiers: { alt: true, shift: true, absolute: true },
      freeCanvas: { left: 0, top: 0, zoom: 1 },
    })

    if (!plan.ok || plan.kind !== 'canvas') throw new Error('expected a free-canvas plan')
    expect(plan.files.map((file) => file.name)).toEqual(['a.png', 'b.jpg'])
    expect(plan.skipped.map((file) => file.name)).toEqual(['notes.pdf'])
  })

  it('still puts the image in the frame under the pointer when there is one', () => {
    mountFrame('home')
    const plan = planCanvasFileDrop({
      files: [imageFile()],
      point: { x: 100, y: 100 },
      transform: null,
      readPage,
      modifiers: NO_DROP_MODIFIERS,
      freeCanvas: { left: 0, top: 0, zoom: 1 },
    })
    expect(plan.ok && plan.kind).toBe('frame')
  })

  it('refuses a drop on the empty board and says where to drop instead', () => {
    mountFrame('home')
    const result = plan([imageFile()], { x: 900, y: 400 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('no-frame')
    expect(result.refusal.message).toContain('Drop the image onto a frame')
  })

  it('refuses a drop with no image in it, and names what it is', () => {
    mountFrame('home')
    const result = plan([imageFile('report.pdf', 'application/pdf')])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('not-an-image')
    expect(result.refusal.message).toContain('application/pdf')
    expect(result.refusal.message).toContain('report.pdf')
  })

  it('lets an untyped file through — the server byte sniff is the gate', () => {
    mountFrame('home')
    expect(plan([imageFile('notes.txt', '')]).ok).toBe(true)
  })

  it('refuses a drop carrying no file at all', () => {
    mountFrame('home')
    expect(plan([]).ok).toBe(false)
  })

  it('refuses a frame whose page has gone', () => {
    mountFrame('deleted-page')
    const result = plan([imageFile()])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('no-frame')
  })

  it('refuses a frame with no page of its own — a CMS breakpoint frame is not a file', () => {
    mountFrame(null)
    expect(plan([imageFile()]).ok).toBe(false)
  })
})
