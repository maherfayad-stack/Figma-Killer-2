/**
 * useEmptyBoardDeselect — a CLICK on the empty board clears every selection;
 * a press that became a pan or a sweep does not.
 *
 * The owner: "when clicking on empty place in the canvas, deselect
 * everything." The old handler was a plain `onClick` on the canvas root, so a
 * Space-drag pan across the board — which the browser still ends with a
 * `click` — threw the selection away. Layout-free by design: the rule is about
 * the press and release, and `press-drag-depth.e2e.ts` covers it in a browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useEmptyBoardDeselect } from '@site/canvas/useEmptyBoardDeselect'
import { enterVectorEdit, getVectorEditTarget } from '@site/canvas/BoardVectorLayer/vectorEditState'
import { setCanvasSpacePanActive } from '@site/canvas/canvasPanInput'

let root: HTMLDivElement
let closed = 0

function press(target: Element, x: number, y: number, button = 0) {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(event, { button, clientX: x, clientY: y, pointerId: 1 })
  target.dispatchEvent(event)
}

function click(target: Element, x: number, y: number) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  target.dispatchEvent(event)
}

function selectSomething() {
  useEditorStore.setState({ selectedNodeId: 'a', selectedNodeIds: ['a'] } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  root = document.createElement('div')
  root.dataset.studioCanvasRoot = 'true'
  document.body.appendChild(root)
  closed = 0
  useEditorStore.setState({
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    selectedAnnotations: [],
    selectedCanvasLayerIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
  renderHook(() => useEmptyBoardDeselect({ canvasRootRef: { current: root }, enabled: true, onDeselect: () => (closed += 1) }))
})

afterEach(() => {
  cleanup()
  setCanvasSpacePanActive(document, 'parentDocument', false)
  document.body.innerHTML = ''
})

describe('useEmptyBoardDeselect', () => {
  it('a click on the empty board clears the selection, closes the menu and leaves vector edit', () => {
    selectSomething()
    enterVectorEdit({ hostNodeId: 'svg', pageId: 'p', frameId: null })
    press(root, 100, 100)
    click(root, 101, 100)
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
    expect(closed).toBe(1)
    expect(getVectorEditTarget()).toBeNull()
  })

  it('a Space-pan that ends on the board is not a click', () => {
    selectSomething()
    setCanvasSpacePanActive(document, 'parentDocument', true)
    press(root, 100, 100)
    click(root, 100, 100)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a'])
  })

  it('a press that travelled (a sweep) is not a click', () => {
    selectSomething()
    press(root, 100, 100)
    click(root, 160, 140)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a'])
  })

  it('a click that ends on anything but the empty board (a frame header, a note) is not a deselect', () => {
    selectSomething()
    const header = document.createElement('div')
    root.appendChild(header)
    press(header, 100, 100)
    click(header, 100, 100)
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['a'])
  })
})
