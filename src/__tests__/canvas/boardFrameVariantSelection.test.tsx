/**
 * boardFrameVariantSelection.test.tsx — WS-10 Phase 2. The proof the
 * coordinator asked for by name: selecting/hovering a node in one
 * "duplicate as variant" frame must NOT also ring it in a sibling frame of
 * the SAME page — the two frames share every node id (trap #2), so without
 * `selectedNodeFrameId`/`hoveredFrameId` scoping (`CanvasFrameContext`,
 * `NodeRenderer.tsx`, `BreakpointSelectionOverlay.tsx`) a click in either
 * frame would ring both.
 *
 * Real render, real board state, two real iframes of the same page —
 * nothing about this is a store-level approximation.
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

/** Frame-scoped lookup — board frames share one synthetic breakpoint id ('studio'), so `iframeCanvasQuery.ts`'s breakpoint-keyed helpers can't tell two board frames apart. Queries the PARENT DOM for `[data-frame-id]` (BoardFramesLayer.tsx) and returns that frame's own iframe document. */
async function waitForFrameDocument(frameId: string): Promise<Document> {
  let doc: Document | null = null
  await waitFor(() => {
    const frameEl = document.querySelector(`[data-frame-id="${frameId}"]`)
    const iframe = frameEl?.querySelector('iframe') as HTMLIFrameElement | null
    doc = iframe?.contentDocument ?? null
    expect(doc?.body).toBeTruthy()
  })
  return doc!
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

describe('selection does not leak between two board frames of the same page', () => {
  it('rings the clicked node in its OWN frame only — the sibling variant stays unselected', async () => {
    const button = makeNode({ id: 'cta-button', moduleId: 'base.button' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [button.id] })
    const page = makePage({ id: 'checkout', rootNodeId: root.id, nodes: { [root.id]: root, [button.id]: button } })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    // A board with TWO frames of the SAME page — the "duplicate as variant"
    // shape: same `pageId`, different `id`, different `axes`. Written
    // directly (not through `duplicateFrameAsVariant`) so this test pins the
    // RENDER/SELECTION behavior independently of the action that creates it.
    const board = createBoard('board-1', 'Board 1')
    board.frames = [
      { id: 'frame-source', pageId: page.id, x: 0, y: 0 },
      { id: 'frame-variant', pageId: page.id, x: 600, y: 0, axes: { direction: 'rtl' } },
    ]
    const file: BoardsFile = { version: 1, boards: [board] }
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({ activeBoardId: board.id })

    renderCanvas()

    const sourceDoc = await waitForFrameDocument('frame-source')
    const variantDoc = await waitForFrameDocument('frame-variant')

    const sourceButton = sourceDoc.querySelector('[data-node-id="cta-button"]') as HTMLElement
    const variantButton = variantDoc.querySelector('[data-node-id="cta-button"]') as HTMLElement
    expect(sourceButton).toBeTruthy()
    expect(variantButton).toBeTruthy()

    // Click the button inside the SOURCE frame.
    act(() => {
      sourceButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => {
      expect(useEditorStore.getState().selectedNodeIds).toEqual(['cta-button'])
    })
    // The selection is frame-scoped to the frame that originated it.
    expect(useEditorStore.getState().selectedNodeFrameId).toBe('frame-source')

    // Both frames' DOM carry the SAME node id (trap #2 — one write target),
    // but only the SOURCE frame's `NodeRenderer` instance computes
    // `isSelected: true` and paints the selection state.
    expect(sourceButton.getAttribute('data-canvas-selected')).toBe('true')
    expect(variantButton.getAttribute('data-canvas-selected')).not.toBe('true')

    // Clicking the SAME node id in the VARIANT frame moves the ring there —
    // proving this isn't a one-way "first frame always wins" artifact.
    act(() => {
      variantButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => {
      expect(useEditorStore.getState().selectedNodeFrameId).toBe('frame-variant')
    })
    expect(variantButton.getAttribute('data-canvas-selected')).toBe('true')
    expect(sourceButton.getAttribute('data-canvas-selected')).not.toBe('true')
  })

  it('hover is frame-scoped the same way selection is', async () => {
    const text = makeNode({ id: 'headline', moduleId: 'base.text' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [text.id] })
    const page = makePage({ id: 'checkout', rootNodeId: root.id, nodes: { [root.id]: root, [text.id]: text } })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    const board = createBoard('board-1', 'Board 1')
    board.frames = [
      { id: 'frame-source', pageId: page.id, x: 0, y: 0 },
      { id: 'frame-variant', pageId: page.id, x: 600, y: 0, axes: { colorScheme: 'dark' } },
    ]
    useEditorStore.getState().loadBoards({ version: 1, boards: [board] })
    useEditorStore.setState({ activeBoardId: board.id })

    renderCanvas()

    const sourceDoc = await waitForFrameDocument('frame-source')
    await waitForFrameDocument('frame-variant')

    const sourceText = sourceDoc.querySelector('[data-node-id="headline"]') as HTMLElement
    act(() => {
      sourceText.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })

    await waitFor(() => {
      expect(useEditorStore.getState().hoveredNodeId).toBe('headline')
    })
    expect(useEditorStore.getState().hoveredFrameId).toBe('frame-source')
  })
})
