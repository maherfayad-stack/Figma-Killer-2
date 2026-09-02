/**
 * D3 — `CanvasContextSelector` must not render on a Studio board: every board
 * frame renders under ONE hardcoded synthetic breakpoint id (`'studio'`,
 * `BoardFramesLayer.tsx`) that ignores `activeBreakpointId` entirely, so the
 * selector would render, take clicks, and change nothing any board frame
 * actually reads — a genuine no-op affordance rather than a real control.
 *
 * Real render, real board state — same harness as
 * `boardFrameVariantSelection.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

beforeEach(() => {
  cleanup()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
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
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    hoveredFrameId: null,
    rightSidebarExpanded: true,
    canvasView: 'design',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

function makeOnePageSite() {
  const text = makeNode({ id: 'headline', moduleId: 'base.text' })
  const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [text.id] })
  return makePage({ id: 'checkout', rootNodeId: root.id, nodes: { [root.id]: root, [text.id]: text } })
}

describe('D3 — CanvasContextSelector is hidden on a Studio board', () => {
  it('does not render while a board is active', async () => {
    const page = makeOnePageSite()
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    const board = createBoard('board-1', 'Board 1')
    board.frames = [{ id: 'frame-1', pageId: page.id, x: 0, y: 0 }]
    const file: BoardsFile = { version: 1, boards: [board] }
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })

    renderCanvas()

    // Give the board frame time to mount (same wait shape as
    // `boardFrameVariantSelection.test.tsx`) before asserting an absence —
    // otherwise "not rendered yet" and "correctly never rendered" look the
    // same.
    await waitFor(() => {
      expect(document.querySelector('[data-frame-id="frame-1"] iframe')).toBeTruthy()
    })

    expect(document.querySelector('[data-testid="canvas-context-selector"]')).toBeNull()
  })

  // A same-page, non-board control case ("does it render OUTSIDE board mode")
  // was tried and dropped: `CanvasContextSelector` did not render in this
  // bare test harness (`makeSite()` fixture with no `breakpoints`/`conditions`
  // populated) independent of the board gate — reverting the one-line
  // `!activeBoardId` fix under test and re-running left this control case
  // failing identically, so it was testing a fixture gap, not this change.
  // The board-mode case above is the one that matters and is confirmed
  // meaningful the same way (fails without the fix, passes with it).
})
