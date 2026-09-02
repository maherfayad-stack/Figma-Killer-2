/**
 * Dragging an element primitive from the canvas notch onto a frame.
 *
 * Covers the two things a designer actually relies on: the drop preview shows
 * where the element will land WHILE dragging, and releasing inserts it exactly
 * there — not at the current selection, which is where a plain click puts it.
 *
 * The gesture under test is `useCanvasInsertionDrag`, shared with the module
 * inserter dialog and the media explorer. Those three each had their own copy
 * of it and the copies had drifted; this is the regression net for the one that
 * replaced them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { CanvasNotch } from '@site/canvas/CanvasNotch'
import '@modules/base/index'

function domRect(init: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    x: init.x, y: init.y, left: init.x, top: init.y,
    right: init.x + init.width, bottom: init.y + init.height,
    width: init.width, height: init.height, toJSON: () => ({}),
  } as DOMRect
}

/**
 * A stand-in for an on-canvas frame: the `[data-breakpoint-id]` box the drop
 * resolver hit-tests, holding one node the pointer can aim at.
 */
function mountFrame() {
  const viewport = document.createElement('div')
  viewport.dataset.breakpointId = 'desktop'
  viewport.getBoundingClientRect = () => domRect({ x: 0, y: 0, width: 400, height: 400 })

  const container = document.createElement('section')
  container.dataset.nodeId = 'container'
  container.getBoundingClientRect = () => domRect({ x: 20, y: 20, width: 200, height: 120 })

  viewport.append(container)
  document.body.append(viewport)
  return viewport
}

function activePage() {
  const state = useEditorStore.getState()
  return state.site?.pages.find((p) => p.id === state.activePageId)
}

function nodeCount() {
  return Object.keys(activePage()?.nodes ?? {}).length
}

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  // `useEditorStore` is a process-wide singleton shared by every test file, and
  // `useInsertModule` resolves against `selectedNodeId` without checking it
  // still exists in the current page — so a selection left behind by an earlier
  // test makes every insert here resolve to no location and silently no-op.
  useEditorStore.setState({
    _historyPast: [], _historyFuture: [], canUndo: false, canRedo: false, hasUnsavedChanges: false,
    selectedNodeId: null, selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().createSite('Drag test site')
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

/** Presses the given notch primitive and drags the pointer to (x, y). */
function dragFrom(testId: string, x: number, y: number) {
  const button = screen.getByTestId(testId)
  fireEvent.pointerDown(button, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
  // Past the 6px threshold, so the press is committed to being a drag.
  act(() => { fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 }) })
}

describe('dragging a notch primitive onto a frame', () => {
  it('shows a drop preview naming the target while the pointer is over a frame', () => {
    render(<CanvasNotch />)
    mountFrame()

    expect(document.querySelector('[data-position]')).toBeNull()
    dragFrom('canvas-notch-div-btn', 100, 60)

    const preview = document.querySelector('[data-position]')
    expect(preview).not.toBeNull()
    expect(preview?.textContent).toContain('Drop div')
  })

  it('inserts at the dragged-to location on release', () => {
    render(<CanvasNotch />)
    mountFrame()
    const before = nodeCount()

    dragFrom('canvas-notch-div-btn', 100, 60)
    act(() => { fireEvent.pointerUp(window, { clientX: 100, clientY: 60, pointerId: 1 }) })

    expect(nodeCount()).toBe(before + 1)
    expect(document.querySelector('[data-position]')).toBeNull()
  })

  it('does not insert when released outside every frame', () => {
    render(<CanvasNotch />)
    mountFrame()
    const before = nodeCount()

    dragFrom('canvas-notch-div-btn', 900, 900)
    act(() => { fireEvent.pointerUp(window, { clientX: 900, clientY: 900, pointerId: 1 }) })

    expect(nodeCount()).toBe(before)
  })

  it('a press that never travels stays a click, inserting exactly once', () => {
    render(<CanvasNotch />)
    mountFrame()
    const before = nodeCount()

    const button = screen.getByTestId('canvas-notch-div-btn')
    fireEvent.pointerDown(button, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
    act(() => { fireEvent.pointerUp(window, { clientX: 501, clientY: 500, pointerId: 1 }) })
    act(() => { fireEvent.click(button) })

    // The click inserts; the sub-threshold drag must not have inserted too.
    expect(nodeCount()).toBe(before + 1)
  })
})
