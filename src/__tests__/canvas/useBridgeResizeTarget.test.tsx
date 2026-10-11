/**
 * `live-13` — what a Tier 2 bridge frame still needs from the parent for its
 * resize handles: the resize target and the facts the frame cannot read itself.
 * (SB-4: its rings, hover and toolbar anchor are the parent's, placed from the
 * frame's rect index like any other frame's.) A fake adapter records every
 * call; a real `PortalFrameAdapter` proves the hook leaves a portal frame to
 * the overlay.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import type { FrameDocumentAdapter, NodeRef, ResizeTargetOptions } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { useBridgeResizeTarget } from '@site/canvas/useBridgeResizeTarget'
import '@modules/base/index'

function makeFakeAdapter() {
  const calls: Array<[string, ...unknown[]]> = []
  const adapter = {
    setResizeTarget: (ref: NodeRef | null, options: ResizeTargetOptions) => calls.push(['setResizeTarget', ref, options]),
  } as unknown as FrameDocumentAdapter
  return { adapter, calls }
}

function Harness({ adapter, selected }: { adapter: FrameDocumentAdapter | null; selected: readonly string[] }) {
  useBridgeResizeTarget(adapter, { selectedNodeIds: selected, committedTransform: [1, 0, 0] })
  return null
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

describe('useBridgeResizeTarget', () => {
  it('sends the resize target through the adapter, with what the frame cannot read itself', () => {
    const { adapter, calls } = makeFakeAdapter()
    render(<Harness adapter={adapter} selected={[textId]} />)
    // A base module owns its own `style=""`, so the single selection gets handles.
    const rootId = useEditorStore.getState().site!.pages[0]!.rootNodeId
    expect(calls.find(([name]) => name === 'setResizeTarget')?.slice(1)).toEqual([
      { nodeId: textId },
      // canvas-23/26 — what the frame cannot read itself rides along.
      expect.objectContaining({ proportional: false, sizing: {}, snap: { siblings: [], parent: { nodeId: rootId }, zoom: 1 } }),
    ])
    // Rings, hover and the ring tokens are not the frame's any more.
    expect(calls.map(([name]) => name)).toEqual(['setResizeTarget'])
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

  it("does nothing for a portal frame — its handles are the overlay's", () => {
    const portal = new PortalFrameAdapter(document)
    const calls: string[] = []
    portal.setResizeTarget = (() => calls.push('setResizeTarget')) as typeof portal.setResizeTarget
    render(<Harness adapter={portal} selected={[textId]} />)
    expect(calls).toEqual([])
    portal.dispose()
  })
})
