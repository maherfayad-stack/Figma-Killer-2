/**
 * The hover ring is measured on the node the pointer moved TO, not the one it
 * came from.
 *
 * Hover moving straight from one node to another (every pointer entry into a
 * child: body → main → an icon) used to schedule no measure pass. Nothing else
 * notices it either: the overlay measures on events (`overlayMeasureScheduler`),
 * and the ring's own attribute write is filtered as selection chrome. So the
 * ring kept the FIRST node's box while its `data-canvas-overlay-node-id` said
 * the second. Found in a real browser by `svg-renders-as-itself.e2e.ts`: the hover
 * ring on an `<svg>` had the frame body's 1024×800 box.
 *
 * happy-dom has no layout, so each node's rect is stubbed to a distinct box.
 * The test asserts on the ring's written placement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { SELECTION_OVERLAY_ROOT_ID } from '@core/studio-runtime'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { setCanvasHover } from '@site/canvas/canvasHover'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const BREAKPOINT = { id: 'studio', label: 'Studio', mediaQuery: '(max-width: 1024px)', width: 800 }

const BOXES: Record<string, { x: number; y: number; width: number; height: number }> = {
  first: { x: 10, y: 10, width: 300, height: 200 },
  second: { x: 40, y: 260, width: 48, height: 48 },
}

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeBreakpointId: BREAKPOINT.id,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = originalFetch
})

function stubRect(element: Element, box: { x: number; y: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: box.x,
      y: box.y,
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box,
    }),
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('BreakpointSelectionOverlay — the hover ring follows a hover that moves between nodes', () => {
  it('re-measures when hover moves from one node straight to another', async () => {
    const first = makeNode({ id: 'first', moduleId: 'base.container' })
    const second = makeNode({ id: 'second', moduleId: 'base.container' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [first.id, second.id] })
    const page = makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [first.id]: first, [second.id]: second } })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id } as Parameters<typeof useEditorStore.setState>[0])

    render(<BreakpointFrame page={page} breakpoint={BREAKPOINT} isActive onActivate={() => {}} showBreakpointChrome={false} />)

    const frameDoc = await waitFor(() => {
      const iframe = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
      const doc = iframe?.contentDocument
      expect(doc?.getElementById(SELECTION_OVERLAY_ROOT_ID)).toBeTruthy()
      expect(doc?.querySelector('[data-node-id="first"]')).toBeTruthy()
      expect(doc?.querySelector('[data-node-id="second"]')).toBeTruthy()
      return doc!
    })
    for (const [id, box] of Object.entries(BOXES)) stubRect(frameDoc.querySelector(`[data-node-id="${id}"]`)!, box)

    const hoverRing = await waitFor(() => {
      const ring = frameDoc.querySelector('[data-canvas-hover-ring]') as HTMLElement | null
      expect(ring).not.toBeNull()
      return ring!
    })

    act(() => {
      setCanvasHover('first', BREAKPOINT.id)
    })
    await waitFor(() => expect(hoverRing.style.width).toBe('300px'))

    // No `null` in between: the pointer crossed straight into the next node.
    act(() => {
      setCanvasHover('second', BREAKPOINT.id)
    })
    await settle()

    expect(hoverRing.getAttribute('data-canvas-overlay-node-id')).toBe('second')
    expect(hoverRing.style.transform).toBe('translate(40px, 260px)')
    expect(hoverRing.style.width).toBe('48px')
    expect(hoverRing.style.height).toBe('48px')

    act(() => {
      setCanvasHover(null)
    })
  })
})
