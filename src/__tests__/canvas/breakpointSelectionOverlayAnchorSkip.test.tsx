/**
 * `speed-04` (STATE.md) — `BreakpointSelectionOverlay`'s `tickOnce` skips
 * the expensive parent-doc anchor session (`createCanvasOverlayMeasureSession`
 * — two forced `getBoundingClientRect()` reads) when this frame's own ring
 * placements already say it doesn't render ANY of the selected nodes at all.
 * That is the O(frames) cost `STUDIO-SPEED-PLAN.md`'s speed-04 names: on a
 * board where the selection is mirrored across several real breakpoint
 * frames (the CMS/Visual-Component canvas — a "board" frame's OWN selection
 * is already scoped away via `selectedNodeFrameId`, see
 * `boardFrameVariantSelection.test.tsx`), only the frame that actually
 * renders the node should pay for the anchor measure; the rest would only
 * ever measure `null` for every id, which the early return below already
 * produces without the session.
 *
 * Selecting a node id that exists nowhere in the tree is the simplest way to
 * reproduce "this frame doesn't own the selection" without standing up a
 * second breakpoint frame: `elementCache.resolve` returns `null` for it
 * (no DOM element, and the zero-DOM fragment fallback finds nothing in the
 * page tree either), which is exactly the same signal a real, unmatched
 * frame produces.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import * as overlayGeometryMod from '@site/canvas/canvasOverlayGeometry'
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
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeBreakpointId: BREAKPOINT.id,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
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

describe('BreakpointSelectionOverlay — skips the anchor session for a frame that owns none of the selection', () => {
  it('a selection this frame does not render never creates a measure session; a real one does', async () => {
    const button = makeNode({ id: 'cta-button', moduleId: 'base.button' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [button.id] })
    const page = makePage({ id: 'checkout', rootNodeId: root.id, nodes: { [root.id]: root, [button.id]: button } })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <BreakpointFrame page={page} breakpoint={BREAKPOINT} isActive onActivate={() => {}} showBreakpointChrome={false} />,
    )

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
      expect(el?.contentDocument?.body).toBeTruthy()
      return el!
    })

    const sessionSpy = spyOn(overlayGeometryMod, 'createCanvasOverlayMeasureSession')

    // Select a node id that exists NOWHERE in the tree — the same "this
    // frame doesn't own it" signal an unmatched real breakpoint frame
    // produces. `showToolbar`/`inspectorNodeId` still both fire (they only
    // check `selectedNodeIds`, not tree membership), so the anchor branch is
    // reached; ownership is what decides whether it pays for the session.
    act(() => {
      useEditorStore.setState({
        selectedNodeIds: ['ghost-node'],
        selectedNodeId: 'ghost-node',
      } as Parameters<typeof useEditorStore.setState>[0])
    })

    // Proof the tick actually ran (the ring-write phase runs BEFORE the
    // anchor-skip check): the ring div for `ghost-node` exists, just hidden.
    await waitFor(() => {
      expect(
        iframe.contentDocument!.querySelector('[data-canvas-overlay-node-id="ghost-node"]'),
      ).not.toBeNull()
    })
    // Give the scheduler's rAF-coalesced pass a moment past that first
    // observable write, so a session created slightly later would still be
    // caught before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sessionSpy).not.toHaveBeenCalled()

    // Now select the REAL node — a frame that DOES own the selection must
    // still pay for the session (this is the case the optimization must not
    // break: the union rect the toolbar/inspector actually need). happy-dom
    // has no layout engine (`standing-02`) — every element's real
    // `getBoundingClientRect()` is a zero-size rect, which `nodeVisualRect`
    // treats identically to "not rendered here" (the same signal an
    // unmatched frame produces), so ownership couldn't be told apart from
    // absence without a stubbed, non-zero rect on the actual button element.
    const buttonElement = iframe.contentDocument!.querySelector(
      `[data-node-id="${button.id}"]`,
    ) as HTMLElement
    expect(buttonElement).not.toBeNull()
    buttonElement.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect

    act(() => {
      useEditorStore.setState({
        selectedNodeIds: [button.id],
        selectedNodeId: button.id,
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await waitFor(() => {
      expect(sessionSpy).toHaveBeenCalled()
    })
  })
})
