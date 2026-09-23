/**
 * PERF-2 — a hover starting or ending is a style write on a ring that stays
 * mounted, never a `childList` mutation under the frame's observed `<body>`.
 *
 * The hover ring used to be conditionally mounted, so every hover crossing
 * added or removed a node inside the frame document. Two frame observers
 * (the auto-height refit and the scroll unroll) treated that as "the page
 * changed" and re-ran a full-document forced layout each. Those observers now
 * ignore chrome (`isSelectionChromeMutation`); this pins the other half — the
 * chrome itself no longer churns the DOM for hover.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { SELECTION_OVERLAY_ROOT_ID, isSelectionChromeMutation } from '@core/studio-runtime'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
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
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    hoveredFrameId: null,
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
      expect(doc?.getElementById(SELECTION_OVERLAY_ROOT_ID)).toBeTruthy()
      return doc!
    })
    const hoverRing = await waitFor(() => {
      const ring = frameDoc.querySelector('[data-canvas-hover-ring]') as HTMLElement | null
      expect(ring).not.toBeNull()
      return ring!
    })
    expect(hoverRing.style.display).toBe('none')

    // Only the CHROME's own tree mutations count. (A `base.text` module
    // re-rendering on hover replaces its own text node — that is the
    // per-node hover subscription P2-I deletes, not selection chrome.)
    let chromeChildListRecords = 0
    const count = (records: MutationRecord[]) => {
      chromeChildListRecords += records.filter((r) => r.type === 'childList' && isSelectionChromeMutation(r)).length
    }
    const observer = new (frameDoc.defaultView as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(count)
    observer.observe(frameDoc.body, { childList: true, subtree: true })
    try {
      for (const hovered of ['heading', null, 'copy', null, 'heading']) {
        act(() => {
          useEditorStore.setState({ hoveredNodeId: hovered, hoveredBreakpointId: BREAKPOINT.id } as Parameters<typeof useEditorStore.setState>[0])
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      act(() => {
        useEditorStore.setState({ hoveredNodeId: null } as Parameters<typeof useEditorStore.setState>[0])
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      count(observer.takeRecords())

      expect(chromeChildListRecords).toBe(0)
      expect(frameDoc.querySelector('[data-canvas-hover-ring]')).toBe(hoverRing)
      expect(hoverRing.style.display).toBe('none')
    } finally {
      observer.disconnect()
    }
  })
})
