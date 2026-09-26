/**
 * PERF-13 — a selection or hover made without a frame (a Layers-panel row)
 * arms selection chrome only in the frames whose page contains the node.
 *
 * `selectedNodeFrameId === null` used to mean "every mounted frame": each one
 * mounted rings, an in-place inspector wrapper and a measure scheduler
 * (ResizeObserver + MutationObserver + scroll listener) for a node its
 * document does not contain, and re-queried for it on every pass. On a board
 * with twelve frames mounted that multiplied every other overlay cost by
 * twelve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { CanvasPageContext } from '@site/canvas/CanvasContexts'
import {
  idsRenderedByFramePage,
  useBreakpointOverlaySelectionState,
} from '@site/canvas/useBreakpointOverlaySelectionState'
import { setCanvasHover } from '@site/canvas/canvasHover'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const seen: Record<string, { selected: readonly string[]; hovered: string | null }> = {}

function Probe({ frameId }: { frameId: string }) {
  const { selectedNodeIds, hoveredNodeId } = useBreakpointOverlaySelectionState('studio', frameId)
  useEffect(() => {
    seen[frameId] = { selected: selectedNodeIds, hovered: hoveredNodeId }
  }, [frameId, selectedNodeIds, hoveredNodeId])
  return null
}

function Board() {
  return (
    <>
      <CanvasPageContext value="page-a">
        <Probe frameId="frame-a" />
      </CanvasPageContext>
      <CanvasPageContext value="page-b">
        <Probe frameId="frame-b" />
      </CanvasPageContext>
    </>
  )
}

beforeEach(() => {
  const pageA = makePage({
    id: 'page-a',
    rootNodeId: 'a-root',
    nodes: {
      'a-root': makeNode({ id: 'a-root', moduleId: 'base.body', children: ['a-text'] }),
      'a-text': makeNode({ id: 'a-text', moduleId: 'base.text', parentId: 'a-root' }),
    },
  })
  const pageB = makePage({
    id: 'page-b',
    slug: 'b',
    rootNodeId: 'b-root',
    nodes: { 'b-root': makeNode({ id: 'b-root', moduleId: 'base.body', children: [] }) },
  })
  useEditorStore.getState().loadSite(makeSite({ pages: [pageA, pageB] }))
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ selectedNodeIds: [], selectedNodeId: null, selectedNodeFrameId: null })
  setCanvasHover(null)
})

describe('selection chrome is scoped to the frames that can render the node (PERF-13)', () => {
  it('a Layers-panel selection (no frame) rings only the frame whose page holds the node', () => {
    useEditorStore.setState({ selectedNodeIds: ['a-text'], selectedNodeId: 'a-text', selectedNodeFrameId: null })
    render(<Board />)
    expect(seen['frame-a']!.selected).toEqual(['a-text'])
    expect(seen['frame-b']!.selected).toEqual([])
  })

  it('a Layers-panel hover (no frame, no breakpoint) lights only the owning frame', () => {
    setCanvasHover('a-text')
    render(<Board />)
    expect(seen['frame-a']!.hovered).toBe('a-text')
    expect(seen['frame-b']!.hovered).toBeNull()
  })

  it('a frame-scoped selection is unchanged: only its own frame', () => {
    useEditorStore.setState({ selectedNodeIds: ['a-text'], selectedNodeId: 'a-text', selectedNodeFrameId: 'frame-a' })
    render(<Board />)
    expect(seen['frame-a']!.selected).toEqual(['a-text'])
    expect(seen['frame-b']!.selected).toEqual([])
  })
})

describe('idsRenderedByFramePage', () => {
  const index = new Map<string, readonly string[]>([
    ['a-text', ['page-a']],
    ['shared-layout-node', ['page-a', 'page-b']],
  ])

  it('keeps ids the index does not know (a Visual Component tree) — scoping only ever removes provable misses', () => {
    expect(idsRenderedByFramePage(index, ['vc-node'], 'page-b')).toEqual(['vc-node'])
  })

  it('keeps a node composed into several pages (a shared layout) in each of them', () => {
    expect(idsRenderedByFramePage(index, ['shared-layout-node'], 'page-b')).toEqual(['shared-layout-node'])
  })

  it('is unscoped outside a board (the CMS/VC canvas mirrors one document across breakpoints)', () => {
    expect(idsRenderedByFramePage(index, ['a-text'], null)).toEqual(['a-text'])
  })

  it('returns the same array when nothing is removed', () => {
    const ids = ['a-text']
    expect(idsRenderedByFramePage(index, ids, 'page-a')).toBe(ids)
  })
})
