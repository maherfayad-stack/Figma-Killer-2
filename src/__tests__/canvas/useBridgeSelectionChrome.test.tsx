/**
 * `live-13` — a Tier 2 bridge frame's selection chrome is the frame's own,
 * driven through the adapter: rings, hover, the resize target, the ring
 * tokens, and one `measure` per selection for the parent-side anchor. A fake
 * adapter records every call; a real `PortalFrameAdapter` proves the hook
 * leaves a portal frame to the overlay.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { FrameDocumentAdapter, FrameRuntimeEvent, NodeMeasurement, NodeRef, ResizeTargetOptions } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { SELECTION_CHROME_TOKENS_OVERLAY_ID, useBridgeSelectionChrome } from '@site/canvas/useBridgeSelectionChrome'
import '@modules/base/index'

function makeFakeAdapter() {
  const calls: Array<[string, ...unknown[]]> = []
  const adapter = {
    applyOverlay: (id: string, css: string) => calls.push(['applyOverlay', id, css]),
    select: (refs: NodeRef[]) => calls.push(['select', refs]),
    hover: (ref: NodeRef | null) => calls.push(['hover', ref]),
    setResizeTarget: (ref: NodeRef | null, options: ResizeTargetOptions) => calls.push(['setResizeTarget', ref, options]),
    measure: (refs: NodeRef[]) => {
      calls.push(['measure', refs])
      return Promise.resolve<NodeMeasurement[]>(refs.map(({ nodeId }) => ({ nodeId, rect: { x: 10, y: 20, width: 100, height: 50 }, computedStyle: {} })))
    },
    on: (_event: FrameRuntimeEvent['type'], _handler: unknown) => () => {},
  } as unknown as FrameDocumentAdapter
  return { adapter, calls }
}

/** Module-level so its identity is stable across renders, as the real follower's is. */
const noopRecordAnchor = () => {}

function Harness({ adapter, selected, hover = null, showToolbar = true }: { adapter: FrameDocumentAdapter | null; selected: readonly string[]; hover?: string | null; showToolbar?: boolean }) {
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const inspectorRef = useRef<HTMLDivElement | null>(null)
  // State, not a ref: an element read during render must be render state.
  const [iframeElement] = useState<HTMLIFrameElement | null>(null)
  useBridgeSelectionChrome(adapter, {
    iframeElement,
    canvasRoot: null,
    selectedNodeIds: selected,
    hoverNodeId: hover,
    showToolbar,
    inspectorNodeId: selected.length === 1 ? (selected[0] ?? null) : null,
    toolbarRef,
    inspectorRef,
    committedTransform: [1, 0, 0],
    recordAnchor: noopRecordAnchor,
  })
  return <div ref={toolbarRef} />
}

let textId = ''

beforeEach(() => {
  useEditorStore.setState({ site: null, selectedNodeIds: [], canvasTool: 'select' } as Parameters<typeof useEditorStore.setState>[0])
  const site = useEditorStore.getState().createSite('Bridge chrome')
  textId = useEditorStore.getState().insertNode('base.text', { text: 'hello', tag: 'p' }, site.pages[0].rootNodeId)
})

afterEach(() => {
  cleanup()
})

describe('useBridgeSelectionChrome', () => {
  it('sends the ring tokens once, then the selection, the hover and the resize target through the adapter', () => {
    const { adapter, calls } = makeFakeAdapter()
    render(<Harness adapter={adapter} selected={[textId]} hover="pages/Home.tsx:9:9" />)
    const overlay = calls.find(([name]) => name === 'applyOverlay')
    expect(overlay?.[1]).toBe(SELECTION_CHROME_TOKENS_OVERLAY_ID)
    expect(calls.filter(([name]) => name === 'applyOverlay')).toHaveLength(1)
    expect(calls.find(([name]) => name === 'select')?.[1]).toEqual([{ nodeId: textId }])
    expect(calls.find(([name]) => name === 'hover')?.[1]).toEqual({ nodeId: 'pages/Home.tsx:9:9' })
    // A base module owns its own `style=""`, so the single selection gets handles.
    const rootId = useEditorStore.getState().site!.pages[0]!.rootNodeId
    expect(calls.find(([name]) => name === 'setResizeTarget')?.slice(1)).toEqual([
      { nodeId: textId },
      // canvas-23/26 — what the frame cannot read itself rides along.
      { proportional: false, sizing: {}, snap: { siblings: [], parent: { nodeId: rootId }, zoom: 1 } },
    ])
  })

  it('clears the resize target for a multi-selection, and re-sends it when the scale tool is armed', () => {
    const { adapter, calls } = makeFakeAdapter()
    const view = render(<Harness adapter={adapter} selected={[textId, 'other']} />)
    expect(calls.find(([name]) => name === 'setResizeTarget')?.slice(1)).toEqual([null, expect.objectContaining({ proportional: false })])
    calls.length = 0
    useEditorStore.setState({ canvasTool: 'scale' } as Parameters<typeof useEditorStore.setState>[0])
    view.rerender(<Harness adapter={adapter} selected={[textId]} />)
    expect(calls.filter(([name]) => name === 'setResizeTarget').at(-1)?.slice(1)).toEqual([{ nodeId: textId }, expect.objectContaining({ proportional: true })])
  })

  // canvas-23 — the stored Fill marker is what lets the frame's resize drop it.
  it('sends the stored sizing markers with the target, and re-sends them when they change', () => {
    const { adapter, calls } = makeFakeAdapter()
    render(<Harness adapter={adapter} selected={[textId]} />)
    calls.length = 0
    act(() => useEditorStore.getState().setNodeInlineStyles(textId, { flex: '1', alignSelf: 'stretch' }))
    const last = calls.filter(([name]) => name === 'setResizeTarget').at(-1)?.slice(1)
    expect(last?.[1]).toEqual(expect.objectContaining({ sizing: { flex: '1', alignSelf: 'stretch' } }))
  })

  it('asks the frame to measure the selection for the toolbar anchor only when there is an element to anchor', () => {
    const { adapter, calls } = makeFakeAdapter()
    render(<Harness adapter={adapter} selected={[textId]} />)
    // No iframe element in this harness — nothing to project onto, so no round trip.
    expect(calls.filter(([name]) => name === 'measure')).toHaveLength(0)
  })

  it('does nothing for a portal frame — its chrome is the overlay\'s', () => {
    const portal = new PortalFrameAdapter(document)
    const calls: string[] = []
    portal.select = (() => calls.push('select')) as typeof portal.select
    portal.hover = (() => calls.push('hover')) as typeof portal.hover
    render(<Harness adapter={portal} selected={[textId]} hover="x" />)
    expect(calls).toEqual([])
    portal.dispose()
  })
})
