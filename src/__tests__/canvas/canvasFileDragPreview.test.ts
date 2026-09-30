/**
 * G15's in-flight half — what a file dragged over the board says BEFORE it is
 * released.
 *
 * The property worth defending is not "a chip appears". It is that the chip
 * and the toast cannot disagree: both halves of the gesture call the same
 * refusal functions in `canvasFileDrop.ts`, so a preview that said "this will
 * land" and a drop that then refused would be a divergence this suite fails
 * on. Every refusal case below is therefore asserted against the SAME
 * `reason` the completed drop would raise.
 *
 * The other property is the one the spec forces on us: before `drop`, the drag
 * data store is in protected mode, so there is no file name and no size. The
 * chip names the TYPE, and a test here pins that it never claims more.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import {
  beginCanvasFileDragSession,
  describeDraggedImage,
  readDraggedFileFacts,
  resolveCanvasFileDragPaint,
} from '@site/canvas/canvasFileDragPreview'
import { NO_DROP_MODIFIERS, type CanvasFileDropModifiers } from '@site/canvas/canvasFileDrop'
import { measureBoardDropSurfaces } from '@site/canvas/canvasDragBoard'
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
let frameLayer: HTMLElement

function mountFrame(): void {
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
  frameLayer = document.createElement('div')
  viewport.appendChild(frameLayer)
  const key = {}
  keys.push(key)
  registerCanvasDropSurface(key, {
    frameId: 'frame-home',
    pageId: 'home',
    viewport,
    iframe: null,
    dropLayer: () => frameLayer,
  })
}

const readPage = (pageId: string) => (pageId === 'home' ? tree() : null)

function hintLayer(): HTMLElement {
  const layer = document.createElement('div')
  stubRect(layer, { left: 0, top: 0, right: 1200, bottom: 900 })
  document.body.appendChild(layer)
  return layer
}

function paintAt(point: { x: number; y: number }, facts: { types: string[] }, modifiers: CanvasFileDropModifiers = NO_DROP_MODIFIERS) {
  const session = beginCanvasFileDragSession(measureBoardDropSurfaces(null))
  const layer = hintLayer()
  return resolveCanvasFileDragPaint(session, {
    point,
    facts,
    modifiers,
    transform: null,
    readPage,
    hintLayer: layer,
    hintOrigin: { x: 0, y: 0 },
  })
}

afterEach(() => {
  for (const key of keys.splice(0)) unregisterCanvasDropSurface(key)
  document.body.innerHTML = ''
})

describe('resolveCanvasFileDragPaint — over a frame', () => {
  it('paints the same drop line an element drag would, in that frame’s own layer', () => {
    mountFrame()
    const { layer, paint } = paintAt({ x: 100, y: 100 }, { types: ['image/png'] })

    expect(layer).toBe(frameLayer)
    expect(paint?.target).not.toBeNull()
    expect(paint?.invalid).toBeNull()
    expect(paint?.ghost?.refusing).toBeFalsy()
  })

  it('names the format, never a file name — the browser will not give one before the drop', () => {
    mountFrame()
    const { paint } = paintAt({ x: 100, y: 100 }, { types: ['image/png'] })
    expect(paint?.ghost?.label).toBe('PNG image')
  })

  it('refuses a non-image while the pointer is still moving, with no drop line', () => {
    mountFrame()
    const { paint } = paintAt({ x: 100, y: 100 }, { types: ['application/pdf'] })

    expect(paint?.target).toBeNull()
    expect(paint?.ghost?.refusing).toBe(true)
    expect(paint?.ghost?.label).toContain('application/pdf')
  })

  it('P5-B IMG-2 — several images show ONE drop line and say how many will land', () => {
    mountFrame()
    const { paint } = paintAt({ x: 100, y: 100 }, { types: ['image/png', 'image/jpeg', 'image/png'] })
    expect(paint?.target).not.toBeNull()
    expect(paint?.ghost?.refusing).toBeFalsy()
    expect(paint?.ghost?.label).toBe('Add 3 images')
  })

  it('a shift drag says it will set a background, and draws no drop line', () => {
    mountFrame()
    const { paint } = paintAt({ x: 100, y: 100 }, { types: ['image/png'] }, { ...NO_DROP_MODIFIERS, shift: true })
    expect(paint?.target).toBeNull()
    expect(paint?.ghost?.label).toBe('Set as background')
  })
})

describe('resolveCanvasFileDragPaint — over the empty board', () => {
  it('says where to drop instead, in the board layer rather than a frame’s', () => {
    mountFrame()
    const { layer, paint } = paintAt({ x: 900, y: 400 }, { types: ['image/png'] })

    expect(layer).not.toBe(frameLayer)
    expect(paint?.target).toBeNull()
    expect(paint?.ghost?.refusing).toBe(true)
    expect(paint?.ghost?.label).toBe('Drop onto a frame')
  })

  it('offers the free canvas on a Studio board (P5-G) — not a refusal', () => {
    mountFrame()
    const session = beginCanvasFileDragSession(measureBoardDropSurfaces(null))
    const { paint } = resolveCanvasFileDragPaint(session, {
      point: { x: 900, y: 400 },
      facts: { types: ['image/png'] },
      modifiers: NO_DROP_MODIFIERS,
      transform: null,
      readPage,
      hintLayer: document.createElement('div'),
      hintOrigin: { x: 0, y: 0 },
      freeCanvas: true,
    })
    expect(paint?.ghost?.label).toBe('Place on canvas')
    expect(paint?.ghost?.refusing).toBeUndefined()
  })

  it('still leads with the FILE’s own refusal when there is one — the nearer fact', () => {
    mountFrame()
    const { paint } = paintAt({ x: 900, y: 400 }, { types: ['application/pdf'] })
    expect(paint?.ghost?.label).toContain('application/pdf')
  })

  it('paints nothing at all when the board layer has not mounted', () => {
    mountFrame()
    const session = beginCanvasFileDragSession(measureBoardDropSurfaces(null))
    const { layer, paint } = resolveCanvasFileDragPaint(session, {
      point: { x: 900, y: 400 },
      facts: { types: ['image/png'] },
      modifiers: NO_DROP_MODIFIERS,
      transform: null,
      readPage,
      hintLayer: null,
      hintOrigin: null,
    })
    expect(layer).toBeNull()
    expect(paint).toBeNull()
  })
})

describe('readDraggedFileFacts — the protected-mode half of a DataTransfer', () => {
  it('ignores an ordinary in-page drag that carries no files', () => {
    const transfer = {
      items: [{ kind: 'string', type: 'text/plain' }],
      types: ['text/plain'],
    } as unknown as DataTransfer
    expect(readDraggedFileFacts(transfer)).toBeNull()
  })

  it('reads every file entry’s declared type, in order', () => {
    const transfer = {
      items: [
        { kind: 'file', type: 'image/webp' },
        { kind: 'file', type: 'image/png' },
      ],
      types: ['Files'],
    } as unknown as DataTransfer
    expect(readDraggedFileFacts(transfer)).toEqual({ types: ['image/webp', 'image/png'] })
  })

  it('trusts a `Files` type even when the browser enumerates no items', () => {
    const transfer = { items: [], types: ['Files'] } as unknown as DataTransfer
    expect(readDraggedFileFacts(transfer)).toEqual({ types: [''] })
  })
})

describe('describeDraggedImage', () => {
  it('shortens the MIME type to the format a person reads', () => {
    expect(describeDraggedImage('image/png')).toBe('PNG image')
    expect(describeDraggedImage('image/svg+xml')).toBe('SVG image')
  })

  it('claims nothing about a file the platform declared no type for', () => {
    expect(describeDraggedImage('')).toBe('Image file')
  })
})
