/**
 * OD-15 (owner, 2026-09-24) — arrows after a Layers pick, like Figma.
 *
 *   - A POINTER click on a Layers row selects the layer and hands the keyboard
 *     to the canvas: → then moves the layer (P2-C's `canvas.moveSelection`),
 *     one source write.
 *   - KEYBOARD entry into the tree (Tab, focus on a row) keeps the tree's own
 *     arrows: ↓ selects the next row, and nothing is written.
 *
 * Driven through the real `DomPanel`, the one editor key dispatcher and the
 * node arrow scope, with real `KeyboardEvent`s. happy-dom does not move focus
 * on a synthetic click, so each pointer case focuses the row first, as the
 * browser's own pointerdown would. The browser half is
 * `tests/e2e/snapping-and-measuring.e2e.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DomPanel } from '@site/panels/DomPanel/DomPanel'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasNodeShortcuts } from '@site/canvas/useCanvasNodeShortcuts'
import { useCanvasNodeArrowKeys } from '@site/canvas/useCanvasNodeArrowKeys'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter, NodeMeasurement } from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import { EDITOR_SAVE_REQUEST_EVENT } from '@admin/state/adminEvents'
import { makeNode, makePage, makeSite } from '../fixtures'

const COLUMN = { display: 'block', 'flex-direction': 'row', 'grid-auto-flow': 'row', direction: 'ltr', position: 'relative' }
const ABSOLUTE = { position: 'absolute', direction: 'ltr', left: '100px', right: '180px', top: '40px', bottom: '60px' }
const STATIC = { position: 'static', direction: 'ltr', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto' }

function tableAdapter(table: Record<string, Record<string, string>>): FrameDocumentAdapter {
  return {
    measure: async (refs: { nodeId: string }[]): Promise<NodeMeasurement[]> =>
      refs.map(({ nodeId }) =>
        table[nodeId]
          ? { nodeId, rect: { x: 0, y: 0, width: 10, height: 10 }, computedStyle: table[nodeId] }
          : { nodeId, rect: null, computedStyle: {} },
      ),
  } as unknown as FrameDocumentAdapter
}

function seed() {
  localStorage.clear()
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['abs', 'b'] }),
      abs: makeNode({ id: 'abs', moduleId: 'base.container', parentId: 'root', inlineStyles: { position: 'absolute', left: '100px', top: '40px' } }),
      b: makeNode({ id: 'b', moduleId: 'base.container', parentId: 'root' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    hoveredNodeId: null,
    activeInlineEdit: null,
    previewNodeStyles: null,
    focusedPanel: 'canvas',
    hasUnsavedChanges: false,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function Editor() {
  useEditorKeyDispatcher()
  useCanvasNodeShortcuts({ editable: true, isLive: false, requestDeleteNode: () => {} })
  useCanvasNodeArrowKeys(true, false)
  return (
    <>
      <div data-studio-canvas-root="true" data-testid="canvas-root" tabIndex={0} />
      <DomPanel />
    </>
  )
}

function node(id: string) {
  return useEditorStore.getState().site!.pages[0]!.nodes[id]!
}

function historyLength(): number {
  return (useEditorStore.getState() as unknown as { _historyPast: unknown[] })._historyPast.length
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit) {
  const target = document.activeElement ?? document.body
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
  })
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

let frame: HTMLIFrameElement
let saveRequests = 0
const countSave = () => {
  saveRequests += 1
}

beforeEach(() => {
  seed()
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  registerFrameAdapter(frame, tableAdapter({ root: COLUMN, abs: ABSOLUTE, b: STATIC }), 'desktop')
  saveRequests = 0
  window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, countSave)
})

afterEach(() => {
  cleanup()
  unregisterFrameAdapter(frame)
  window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, countSave)
  document.body.innerHTML = ''
})

describe('OD-15 — a pointer pick in Layers hands the arrows to the canvas', () => {
  it('click a row, press →: the layer nudges, one source write', async () => {
    render(<Editor />)
    const row = screen.getByTestId('dom-tree-item-abs')
    // The browser's pointerdown focuses the row (tabIndex 0) before the click.
    act(() => row.focus())
    act(() => {
      fireEvent.click(row, { detail: 1 })
    })
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['abs'])
    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'))

    key('keydown', { key: 'ArrowRight' })
    await settle()
    key('keyup', { key: 'ArrowRight' })
    expect(node('abs').inlineStyles?.left).toBe('101px')
    expect(historyLength()).toBe(1)
    expect(saveRequests).toBe(1)
  })

  it('a click the KEYBOARD produced (Enter on a focused control, detail 0) keeps focus in the tree', () => {
    render(<Editor />)
    const row = screen.getByTestId('dom-tree-item-abs')
    act(() => row.focus())
    act(() => {
      fireEvent.click(row, { detail: 0 })
    })
    expect(document.activeElement).toBe(row)
  })
})

describe('OD-15 — keyboard entry keeps the tree its own arrows', () => {
  it('Tab into the tree, press ↓: the next row is selected and focused, nothing is written', () => {
    useEditorStore.setState({ selectedNodeId: 'abs', selectedNodeIds: ['abs'] } as Parameters<typeof useEditorStore.setState>[0])
    render(<Editor />)
    const row = screen.getByTestId('dom-tree-item-abs')
    act(() => row.focus())

    key('keydown', { key: 'ArrowDown' })
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['b'])
    expect(document.activeElement).toBe(screen.getByTestId('dom-tree-item-b'))
    key('keydown', { key: 'ArrowUp' })
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['abs'])

    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(historyLength()).toBe(0)
    expect(saveRequests).toBe(0)
  })

  it('→ on a focused row is the tree’s (expand), never a nudge', async () => {
    useEditorStore.setState({ selectedNodeId: 'abs', selectedNodeIds: ['abs'] } as Parameters<typeof useEditorStore.setState>[0])
    render(<Editor />)
    act(() => screen.getByTestId('dom-tree-item-abs').focus())
    key('keydown', { key: 'ArrowRight' })
    await settle()
    key('keyup', { key: 'ArrowRight' })
    expect(node('abs').inlineStyles?.left).toBe('100px')
    expect(historyLength()).toBe(0)
  })
})
