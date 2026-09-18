/**
 * D2 G3 — dragging an element out of one frame and into another.
 *
 * The three things this gesture can silently get wrong, asserted here because
 * nothing else can see them:
 *
 *  1. **The drop line is painted in the frame the pointer is over.** Each
 *     frame's `.viewport` is `overflow: hidden`, so chrome drawn into the
 *     ORIGIN frame's layer while the pointer is elsewhere is drawn where
 *     nobody can see it — a drag that looks broken rather than one that
 *     refuses. Crossing back must clear the frame being left.
 *  2. **The commit is a transplant, not a move.** The two ends are two files;
 *     routing a cross-frame drop through `moveNodes` would plan an anchor in a
 *     tree the element is not in.
 *  3. **Two frames of the SAME page are not a cross-frame drop.** A "duplicate
 *     as variant" sibling shares its page id, so a drop between the two is an
 *     ordinary reparent and must keep going through `moveNodes`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useCanvasReorderDrag } from '@site/canvas/useCanvasReorderDrag'
import {
  registerCanvasDropSurface,
  unregisterCanvasDropSurface,
} from '@site/canvas/canvasDropSurfaceRegistry'
import type { TransplantDestination } from '@site/store/slices/site/types'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
const HOME_A = 'pages/Home.tsx:6:7'
const HOME_B = 'pages/Home.tsx:7:7'

const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'

/** Where each frame sits in parent-document client space — deliberately disjoint. */
const HOME_BOX = { left: 0, top: 0, right: 500, bottom: 800 }
const ABOUT_BOX = { left: 600, top: 0, right: 1100, bottom: 800 }

function seedSite(): void {
  const site = makeSite({
    pages: [
      makePage({
        id: 'home',
        slug: 'index',
        title: 'Home',
        rootNodeId: HOME_ROOT,
        nodes: {
          [HOME_ROOT]: makeNode({ id: HOME_ROOT, moduleId: 'base.container', children: [HOME_MAIN] }),
          [HOME_MAIN]: makeNode({
            id: HOME_MAIN,
            moduleId: 'base.container',
            children: [HOME_A, HOME_B],
            parentId: HOME_ROOT,
          }),
          [HOME_A]: makeNode({ id: HOME_A, moduleId: 'base.text', props: { text: 'A' }, parentId: HOME_MAIN }),
          [HOME_B]: makeNode({ id: HOME_B, moduleId: 'base.text', props: { text: 'B' }, parentId: HOME_MAIN }),
        },
      }),
      makePage({
        id: 'about',
        slug: 'about',
        title: 'About',
        rootNodeId: ABOUT_ROOT,
        nodes: {
          [ABOUT_ROOT]: makeNode({ id: ABOUT_ROOT, moduleId: 'base.container', children: [ABOUT_MAIN] }),
          [ABOUT_MAIN]: makeNode({
            id: ABOUT_MAIN,
            moduleId: 'base.container',
            children: [ABOUT_H1],
            parentId: ABOUT_ROOT,
          }),
          [ABOUT_H1]: makeNode({ id: ABOUT_H1, moduleId: 'base.text', props: { text: 'About' }, parentId: ABOUT_MAIN }),
        },
      }),
    ],
  })
  useEditorStore.getState().loadSite(site)
  useEditorStore.setState({
    activePageId: 'home',
    selectedNodeId: HOME_A,
    selectedNodeIds: [HOME_A],
  } as Parameters<typeof useEditorStore.setState>[0])
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
  // `indexLocalPoint` recovers the canvas scale from `rect.width / offsetWidth`
  // — 1:1 here, so the frame space and the client space coincide and the
  // pointer coordinates below read literally.
  Object.defineProperty(el, 'offsetWidth', { value: box.right - box.left, configurable: true })
}

/**
 * A frame's viewport plus one `[data-node-id]` box per node the drag must see.
 *
 * Every rect here is in PARENT-DOCUMENT CLIENT space, which is what
 * `measureCanvasDropCandidates` reads before making each one viewport-local —
 * so the About frame's children sit at x 600+, not at 0.
 */
function mountFrame(box: Box, nodes: { id: string; rect: Box }[]): HTMLElement {
  const viewport = document.createElement('div')
  stubRect(viewport, box)
  document.body.appendChild(viewport)
  for (const node of nodes) {
    const el = document.createElement('div')
    el.setAttribute('data-node-id', node.id)
    stubRect(el, node.rect)
    viewport.appendChild(el)
  }
  return viewport
}

function pointerDownEvent(el: HTMLElement, x: number, y: number) {
  return {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    altKey: false,
    currentTarget: el,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent<HTMLElement>
}

function dispatchPointer(type: string, x: number, y: number, altKey = false): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, altKey, button: 0 })
  window.dispatchEvent(event)
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

let homeViewport: HTMLElement
let aboutViewport: HTMLElement
let aboutLayer: HTMLDivElement
let surfaceKey: object
let transplantCalls: { nodeIds: string[]; destination: TransplantDestination }[]
let moveCalls: { nodeIds: string[]; parentId: string; index: number }[]

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  seedSite()

  homeViewport = mountFrame(HOME_BOX, [
    { id: HOME_MAIN, rect: { left: 0, top: 0, right: 500, bottom: 800 } },
    { id: HOME_A, rect: { left: 10, top: 10, right: 490, bottom: 200 } },
    { id: HOME_B, rect: { left: 10, top: 210, right: 490, bottom: 400 } },
  ])
  aboutViewport = mountFrame(ABOUT_BOX, [
    { id: ABOUT_MAIN, rect: { left: 600, top: 0, right: 1100, bottom: 800 } },
    { id: ABOUT_H1, rect: { left: 610, top: 10, right: 1090, bottom: 200 } },
  ])

  aboutLayer = document.createElement('div')
  aboutViewport.appendChild(aboutLayer)

  transplantCalls = []
  moveCalls = []
  useEditorStore.setState({
    transplantNodes: (nodeIds: string[], destination: TransplantDestination) => {
      transplantCalls.push({ nodeIds, destination })
    },
    moveNodes: (nodeIds: string[], parentId: string, index: number) => {
      moveCalls.push({ nodeIds, parentId, index })
    },
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  if (surfaceKey) unregisterCanvasDropSurface(surfaceKey)
  cleanup()
  document.body.innerHTML = ''
})

/** Publish the About frame as a place a drag can land. */
function registerAboutSurface(pageId: string | null = 'about'): void {
  surfaceKey = {}
  registerCanvasDropSurface(surfaceKey, {
    frameId: 'frame-about',
    pageId,
    viewport: aboutViewport,
    iframe: null,
    dropLayer: () => aboutLayer,
  })
}

function renderDrag() {
  const viewportRef = { current: homeViewport }
  const canvasRootRef = { current: homeViewport }
  return renderHook(() =>
    useCanvasReorderDrag({
      viewportRef,
      canvasRootRef,
      iframeElement: null,
      overlayRoot: null,
      selectedNodeIds: [HOME_A],
      frameId: 'frame-home',
      pageId: 'home',
      enabled: true,
      bodyDragEnabled: false,
      // No `panBy`: the About frame's box sits well inside the stubbed canvas
      // root, so auto-pan never arms and cannot move the coordinates under the
      // assertions below.
    }),
  )
}

/** The origin frame's own layer, as `BreakpointSelectionOverlay` supplies it. */
function mountOriginLayer(ref: React.RefObject<HTMLDivElement | null>): HTMLDivElement {
  const layer = document.createElement('div')
  homeViewport.appendChild(layer)
  ref.current = layer
  return layer
}

/** Press on the origin frame and travel past the activation distance. */
async function beginDragOverHome(result: { current: ReturnType<typeof useCanvasReorderDrag> }): Promise<void> {
  await act(async () => {
    result.current.handlePointerDown(pointerDownEvent(homeViewport, 100, 100))
  })
  await act(async () => {
    dispatchPointer('pointermove', 140, 140)
  })
  await nextFrame()
}

describe('cross-frame drag — where the chrome is painted', () => {
  it('paints the drop line in the frame the pointer is over, and clears the one it left', async () => {
    registerAboutSurface()
    const { result } = renderDrag()
    const originLayer = mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    expect(originLayer.childElementCount).toBeGreaterThan(0)
    expect(aboutLayer.childElementCount).toBe(0)

    // Into the About frame, over its `<h1>`.
    await act(async () => {
      dispatchPointer('pointermove', 700, 100)
    })
    await nextFrame()

    expect(aboutLayer.childElementCount).toBeGreaterThan(0)
    const aboutIndicator = aboutLayer.querySelector<HTMLElement>('[data-position]')
    expect(aboutIndicator).not.toBeNull()
    expect(aboutIndicator!.style.display).not.toBe('none')
    // Everything the origin frame was showing is hidden — nothing is left
    // behind in a frame the pointer has gone from.
    for (const child of Array.from(originLayer.children)) {
      expect((child as HTMLElement).style.display).toBe('none')
    }

    // ...and back again.
    await act(async () => {
      dispatchPointer('pointermove', 140, 300)
    })
    await nextFrame()
    for (const child of Array.from(aboutLayer.children)) {
      expect((child as HTMLElement).style.display).toBe('none')
    }
  })

  it('leaves the gesture alone when the other frame renders the SAME page', async () => {
    // A "duplicate as variant" sibling: a different frame id, the same page.
    registerAboutSurface('home')
    const { result } = renderDrag()
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 700, 100)
    })
    await nextFrame()
    await act(async () => {
      dispatchPointer('pointerup', 700, 100)
    })

    expect(transplantCalls).toHaveLength(0)
    expect(aboutLayer.childElementCount).toBe(0)
  })
})

describe('cross-frame drag — what the drop writes', () => {
  it('commits ONE transplant naming both pages, never a move', async () => {
    registerAboutSurface()
    const { result } = renderDrag()
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 700, 100)
    })
    await nextFrame()
    await act(async () => {
      dispatchPointer('pointerup', 700, 100)
    })

    expect(moveCalls).toHaveLength(0)
    expect(transplantCalls).toHaveLength(1)
    expect(transplantCalls[0]!.nodeIds).toEqual([HOME_A])
    expect(transplantCalls[0]!.destination.originPageId).toBe('home')
    expect(transplantCalls[0]!.destination.pageId).toBe('about')
    expect(transplantCalls[0]!.destination.parentId).toBe(ABOUT_MAIN)
    expect(transplantCalls[0]!.destination.copy).toBeUndefined()
  })

  it('Alt at release makes the cross-frame drop a COPY', async () => {
    registerAboutSurface()
    const { result } = renderDrag()
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 700, 100, true)
    })
    await nextFrame()
    await act(async () => {
      dispatchPointer('pointerup', 700, 100, true)
    })

    expect(transplantCalls).toHaveLength(1)
    expect(transplantCalls[0]!.destination.copy).toBe(true)
  })

  it('writes nothing when the pointer ends over empty board between the frames', async () => {
    registerAboutSurface()
    const { result } = renderDrag()
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 550, 400)
    })
    await nextFrame()
    await act(async () => {
      dispatchPointer('pointerup', 550, 400)
    })

    expect(transplantCalls).toHaveLength(0)
    expect(moveCalls).toHaveLength(0)
  })

  it('Escape mid-gesture over another frame writes nothing and clears that frame', async () => {
    registerAboutSurface()
    const { result } = renderDrag()
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 700, 100)
    })
    await nextFrame()

    await act(async () => {
      const escape = new Event('keydown', { bubbles: true, cancelable: true })
      Object.assign(escape, { key: 'Escape' })
      window.dispatchEvent(escape)
    })
    await act(async () => {
      dispatchPointer('pointerup', 700, 100)
    })

    expect(transplantCalls).toHaveLength(0)
    for (const child of Array.from(aboutLayer.children)) {
      expect((child as HTMLElement).style.display).toBe('none')
    }
  })
})

describe('cross-frame drag — a refused drop says so while the pointer is down', () => {
  it('shows the refusal chip and writes nothing when the selection is more than one element', async () => {
    registerAboutSurface()
    useEditorStore.setState({
      selectedNodeIds: [HOME_A, HOME_B],
    } as Parameters<typeof useEditorStore.setState>[0])

    const viewportRef = { current: homeViewport }
    const { result } = renderHook(() =>
      useCanvasReorderDrag({
        viewportRef,
        canvasRootRef: { current: homeViewport },
        iframeElement: null,
        overlayRoot: null,
        selectedNodeIds: [HOME_A, HOME_B],
        frameId: 'frame-home',
        pageId: 'home',
        enabled: true,
        bodyDragEnabled: false,
      }),
    )
    mountOriginLayer(result.current.dropLayerRef)

    await beginDragOverHome(result)
    await act(async () => {
      dispatchPointer('pointermove', 700, 100)
    })
    await nextFrame()

    const chip = aboutLayer.querySelector<HTMLElement>('[data-testid="canvas-drop-refusal"]')
    expect(chip).not.toBeNull()
    expect(chip!.style.display).not.toBe('none')
    expect(chip!.textContent).toContain('one by one')

    await act(async () => {
      dispatchPointer('pointerup', 700, 100)
    })
    expect(transplantCalls).toHaveLength(0)
  })
})
