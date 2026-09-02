/**
 * Track C2 regression gate — `BoardFramesLayer` must not re-render for an
 * edit to a page NOT curated onto the active board, and must still
 * re-render for an edit to a page that IS on the board (whether or not that
 * page happens to be the currently ACTIVE one).
 *
 * Before the fix, `BoardFramesLayer` subscribed to the WHOLE `s.site?.pages`
 * array purely to hand `resolveFramesWithPages` something to `.find()`
 * against. `site.pages`'s top-level array reference changes on ANY
 * site-touching mutation anywhere in the document (Mutative mints a new
 * `pages` array on any page edit, even though sibling page objects keep
 * their own references), so this layer re-rendered on every keystroke on
 * every page of a multi-page project — not just the pages actually shown on
 * this board (STUDIO-FIGMA-PARITY-PLAN.md Track C, C2).
 *
 * This test mounts `BoardFramesLayer` directly, Profiler-wrapped. The Bun
 * test runtime does not run the app's Vite/Babel React Compiler transform,
 * so — unlike production — nothing here is auto-memoized: a re-render of
 * `BoardFramesLayer` itself happens if and only if one of ITS OWN zustand
 * subscriptions (`board`, `relevantPages`, `activePageId`, …) actually
 * changed. The Profiler wrapping it is therefore a direct, unconfounded
 * proxy for exactly the question this test asks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { BoardFramesLayer } from '@site/canvas/BoardFramesLayer'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

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
    frameDefaults: {},
    zoom: 1,
    panX: 0,
    panY: 0,
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
})

afterEach(() => {
  cleanup()
  resetStore()
})

function makeTextPage(id: string, text: string) {
  return makePage({
    id,
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [`${id}-text`] }),
      [`${id}-text`]: makeNode({ id: `${id}-text`, moduleId: 'base.text', props: { text } }),
    },
  })
}

/**
 * Mimics the top-level, node-content-only slice of what a real Mutative
 * `mutateActiveTree` commit produces: a fresh `site`/`pages` array reference
 * (copy-on-write), but every OTHER page keeps its EXACT original object
 * reference. This is the shape `patchPages` (agent/disk-reload merge) or a
 * Properties Panel edit on a DIFFERENT open frame would produce against a
 * page that is not the one under test's `activePageId`.
 */
function editPageText(pageId: string, nodeId: string, text: string) {
  const current = useEditorStore.getState().site!
  const target = current.pages.find((p) => p.id === pageId)!
  const edited = { ...target, nodes: { ...target.nodes, [nodeId]: { ...target.nodes[nodeId], props: { text } } } }
  useEditorStore.setState({
    site: { ...current, pages: current.pages.map((p) => (p.id === pageId ? edited : p)) },
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('BoardFramesLayer render scope (Track C2)', () => {
  it('does not re-render for an off-board page edit; does re-render for on-board page edits (active or not)', () => {
    const pageA = makeTextPage('page-a', 'A')
    const pageB = makeTextPage('page-b', 'B')
    const pageOffBoard = makeTextPage('page-off-board', 'OFF')
    const site = makeSite({ pages: [pageA, pageB, pageOffBoard] })

    const board = createBoard('board-1', 'Board 1')
    // Off-screen at zoom 1 / pan 0 — BoardFrameView still fully mounts
    // (header, drag handle, resize handles); only the body renders the
    // lightweight `FramePosterPlaceholder` instead of a live iframe. Keeps
    // this test fast and avoids iframe-load timing noise unrelated to the
    // subscription-scope question it exists to answer.
    board.frames = [
      { id: 'frame-a', pageId: pageA.id, x: 100000, y: 0 },
      { id: 'frame-b', pageId: pageB.id, x: 100000, y: 2000 },
    ]
    const file: BoardsFile = { version: 1, boards: [board] }

    useEditorStore.setState({ site, activePageId: pageA.id } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })

    let renderCount = 0
    const onRender: ProfilerOnRenderCallback = () => { renderCount += 1 }

    render(
      <Profiler id="board-frames" onRender={onRender}>
        <BoardFramesLayer />
      </Profiler>,
    )

    expect(renderCount).toBe(1)

    // NEGATIVE — off-board page edit. `activePageId` is untouched throughout
    // this step, isolating exactly the `relevantPages`/`site.pages`
    // subscription this fix narrows.
    act(() => { editPageText('page-off-board', 'page-off-board-text', 'OFF edited') })
    expect(renderCount).toBe(1)

    // POSITIVE (1) — an on-board page that is NOT the active document
    // (page-b) still must flow through: its `page` prop feeds `BoardFrameView`
    // → `BreakpointFrame` directly, so a stale reference here would freeze a
    // non-active frame's canvas mid-edit.
    act(() => { editPageText('page-b', 'page-b-text', 'B edited') })
    expect(renderCount).toBe(2)

    // POSITIVE (2) — a REAL store mutation (`updateNodeProps`, the exact
    // path a Properties Panel edit takes) on the active, on-board page.
    act(() => { useEditorStore.getState().updateNodeProps('page-a-text', { text: 'A edited' }) })
    expect(renderCount).toBe(3)
  })
})
