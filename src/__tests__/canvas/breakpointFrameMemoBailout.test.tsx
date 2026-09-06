/**
 * `memo()` bailout gate for `BreakpointFrame` — the other half of
 * `boardFurnitureMemoBailout.test.tsx`.
 *
 * That file proves an unaffected `BoardFrameView` bails out. This one proves
 * that when a `BoardFrameView` DOES re-render (its own frame moved, it was
 * selected, one of its store subscriptions fired), it does not drag the whole
 * frame subtree — `BreakpointFrame` → `IframeFrameSurface` → every injector →
 * `CanvasComposedTree` — along with it.
 *
 * Two things have to hold for that, and this file pins both:
 *   1. `BreakpointFrame` is `memo()`'d (React Compiler exception #2).
 *   2. `BoardFrameView`'s `buildStudioBreakpoint(width)` INTERNS its result.
 *      A fresh `{ ...base, width }` literal per render is a new prop identity
 *      every time, which defeats (1) completely — the memo would never bail.
 *
 * Instrument: `useResolvedFrameAxes`, which `BreakpointFrame` calls
 * unconditionally at the top of its own body. Call count, not commit count —
 * see `boardFurnitureMemoBailout.test.tsx`'s note on why `Profiler.onRender`
 * cannot distinguish "ran" from "bailed" here.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { BoardFrame } from '@core/studio-board'
import * as axesMod from '@site/canvas/previewAxesFrameEffect'
import { BoardFrameView } from '@site/canvas/BoardFramesLayer/BoardFrameView'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
    selectedAnnotations: [],
    frameDefaults: {},
    zoom: 1,
    panX: 0,
    panY: 0,
    boardSnapGuides: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

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

describe('BreakpointFrame memo() bailout inside a board frame', () => {
  it('a re-rendering BoardFrameView does not re-execute its BreakpointFrame body', async () => {
    const spy = spyOn(axesMod, 'useResolvedFrameAxes')

    const page = makePage({
      id: 'page-a',
      nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) },
    })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id } as Parameters<
      typeof useEditorStore.setState
    >[0])

    function Harness() {
      const [frame, setFrame] = useState<BoardFrame>({ id: 'frame-a', pageId: page.id, x: 0, y: 0 })
      return (
        <>
          <button data-testid="move" onClick={() => setFrame((f) => ({ ...f, x: f.x + 10 }))} />
          <BoardFrameView
            frame={frame}
            page={page}
            x={frame.x}
            y={frame.y}
            width={390}
            height={800}
            hasManualHeight={false}
            isActive={false}
            isSelected={false}
            isOnScreen
          />
        </>
      )
    }

    const { getByTestId } = render(<Harness />)
    const afterMount = spy.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    // The frame object changed, so `BoardFrameView`'s own memo does NOT bail —
    // it re-renders, and re-calls `buildStudioBreakpoint(390)`. Because that
    // result is interned and `BreakpointFrame` is memo()'d, the frame's whole
    // subtree stays put.
    await act(async () => {
      getByTestId('move').click()
    })
    expect(spy.mock.calls.length).toBe(afterMount)

    // Twice more, to rule out a one-off.
    await act(async () => {
      getByTestId('move').click()
    })
    await act(async () => {
      getByTestId('move').click()
    })
    expect(spy.mock.calls.length).toBe(afterMount)
  })

  it('a width change DOES rebuild — the intern cache is keyed on width, not shared blindly', async () => {
    const spy = spyOn(axesMod, 'useResolvedFrameAxes')

    const page = makePage({
      id: 'page-b',
      nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) },
    })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id } as Parameters<
      typeof useEditorStore.setState
    >[0])

    const frame: BoardFrame = { id: 'frame-b', pageId: page.id, x: 0, y: 0 }

    function Harness() {
      const [width, setWidth] = useState(390)
      return (
        <>
          <button data-testid="widen" onClick={() => setWidth(744)} />
          <BoardFrameView
            frame={frame}
            page={page}
            x={0}
            y={0}
            width={width}
            height={800}
            hasManualHeight={false}
            isActive={false}
            isSelected={false}
            isOnScreen
          />
        </>
      )
    }

    const { getByTestId } = render(<Harness />)
    const afterMount = spy.mock.calls.length

    await act(async () => {
      getByTestId('widen').click()
    })
    expect(spy.mock.calls.length).toBeGreaterThan(afterMount)
  })
})
