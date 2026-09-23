/**
 * `speed-04` (STATE.md) — `BreakpointFrame`'s new `overlayEnabled` prop.
 *
 * `LiveBoardFrame` mounts BOTH a Tier-0 fallback `BreakpointFrame` and a
 * hidden bridge `BreakpointFrame` while a Tier-2 board frame boots. Before
 * this change both ALWAYS mounted their own `BreakpointSelectionOverlay`
 * unconditionally — so a click that selected a node landed on the fallback's
 * real, working ring/toolbar/inspector AND on the bridge overlay's
 * `useBridgeSelectionChrome`, which opened a real `postMessage` round trip
 * into a still-loading cross-origin document and rendered a SECOND,
 * independently-positioned toolbar/inspector for the same selection.
 * `overlayEnabled={false}` is how `LiveBoardFrame` now defers the bridge
 * frame's overlay until its adapter reports `ready` — this file pins the
 * contract on `BreakpointFrame` directly, without the cross-origin adapter
 * machinery `liveBoardFrame.test.tsx` already covers for the render fork
 * itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
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
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    hoveredFrameId: null,
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

function selectButtonAndRenderFrame(overlayEnabled?: boolean) {
  const button = makeNode({ id: 'cta-button', moduleId: 'base.button' })
  const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [button.id] })
  const page = makePage({ id: 'checkout', rootNodeId: root.id, nodes: { [root.id]: root, [button.id]: button } })

  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
    // Selected BEFORE mount, same as a bridge `BreakpointFrame` that mounts
    // into an already-selected board frame (the click that selected it
    // landed on the SIBLING fallback frame, not this one).
    selectedNodeIds: [button.id],
    selectedNodeId: button.id,
  } as Parameters<typeof useEditorStore.setState>[0])

  return render(
    <BreakpointFrame
      page={page}
      breakpoint={BREAKPOINT}
      isActive
      onActivate={() => {}}
      showBreakpointChrome={false}
      overlayEnabled={overlayEnabled}
    />,
  )
}

describe('BreakpointFrame — overlayEnabled', () => {
  it('defaults to true: an already-selected node gets its ring, toolbar and inspector', async () => {
    selectButtonAndRenderFrame(undefined)

    // The ring is portaled INTO the iframe (WS-5.1, `overlayRoot`); the
    // toolbar/inspector are portaled to `document.body` (no canvas-viewport
    // context in this bare render — see `BreakpointSelectionOverlay`'s
    // `portalTarget` fallback). Neither lands inside RTL's own `container`.
    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe') as HTMLIFrameElement | null
      expect(el?.contentDocument?.body).toBeTruthy()
      return el!
    })
    await waitFor(() => {
      expect(iframe.contentDocument!.querySelector('[data-canvas-selection-ring]')).not.toBeNull()
    })
    expect(document.querySelector('[data-canvas-selection-toolbar]')).not.toBeNull()
    expect(document.querySelector('[data-canvas-in-place-inspector]')).not.toBeNull()
  })

  it('false: mounts the iframe (booting) but NOT the selection overlay at all', async () => {
    selectButtonAndRenderFrame(false)

    // The iframe itself still mounts — this is what keeps a hidden bridge
    // frame's cold boot concurrent with the visible fallback.
    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe') as HTMLIFrameElement | null
      expect(el?.contentDocument?.body).toBeTruthy()
      return el!
    })

    // No overlay chrome at all: no ring (inside the iframe), no toolbar, no
    // inspector (both would portal to `document.body`). Asserted after a
    // real render pass (not just on mount) so a scheduler tick that fired
    // late would still be caught.
    expect(iframe.contentDocument!.querySelector('[data-canvas-selection-ring]')).toBeNull()
    expect(document.querySelector('[data-canvas-selection-toolbar]')).toBeNull()
    expect(document.querySelector('[data-canvas-in-place-inspector]')).toBeNull()
  })
})
