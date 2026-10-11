/**
 * PERF-2 / SB-4 — a hover starting or ending touches NOTHING inside the frame
 * document.
 *
 * The hover ring used to be conditionally mounted inside the frame, so every
 * hover crossing added or removed a node there and two frame observers (the
 * auto-height refit and the scroll unroll) re-ran a full-document forced layout
 * for each. The ring then stayed mounted but was still written inside the
 * frame, which every observer had to learn to filter out as "chrome". Since
 * SB-4 the ring is parent-document DOM beside the iframe, so the pin is the
 * strong one: hover on, off and on again produces ZERO mutation records of any
 * kind in the frame's document, and the ring is the same element throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { setCanvasHover } from '@site/canvas/canvasHover'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const BREAKPOINT = { id: 'studio', label: 'Studio', mediaQuery: '(max-width: 1024px)', width: 800 }

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

describe('BreakpointSelectionOverlay — the hover ring stays mounted (PERF-2)', () => {
  it('hover on, off and on again adds and removes no node in the frame document', async () => {
    const heading = makeNode({ id: 'heading', moduleId: 'base.text' })
    const body = makeNode({ id: 'copy', moduleId: 'base.text' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [heading.id, body.id] })
    const page = makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [heading.id]: heading, [body.id]: body } })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id } as Parameters<typeof useEditorStore.setState>[0])

    render(<BreakpointFrame page={page} breakpoint={BREAKPOINT} isActive onActivate={() => {}} showBreakpointChrome={false} />)

    const frameDoc = await waitFor(() => {
      const iframe = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
      const doc = iframe?.contentDocument
      expect(doc?.querySelector('[data-node-id="heading"]')).toBeTruthy()
      return doc!
    })
    const hoverRing = await waitFor(() => {
      const ring = document.querySelector('[data-canvas-hover-ring]') as HTMLElement | null
      expect(ring).not.toBeNull()
      return ring!
    })
    expect(hoverRing.style.display).toBe('none')

    // EVERY mutation in the frame document counts: the chrome is not in it.
    let frameMutationRecords = 0
    const count = (records: MutationRecord[]) => {
      frameMutationRecords += records.length
    }
    const observer = new (frameDoc.defaultView as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(count)
    observer.observe(frameDoc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    try {
      for (const hovered of ['heading', null, 'copy', null, 'heading']) {
        act(() => {
          setCanvasHover(hovered, BREAKPOINT.id)
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      act(() => {
        setCanvasHover(null)
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      count(observer.takeRecords())

      expect(frameMutationRecords).toBe(0)
      expect(frameDoc.querySelector('[data-canvas-hover-ring]')).toBeNull()
      expect(document.querySelector('[data-canvas-hover-ring]')).toBe(hoverRing)
      expect(hoverRing.style.display).toBe('none')
    } finally {
      observer.disconnect()
    }
  })
})
