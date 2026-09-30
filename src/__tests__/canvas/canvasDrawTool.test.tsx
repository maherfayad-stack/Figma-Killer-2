/**
 * P5-E (IX-12, OD-5) — the armed draw tools.
 *
 *   - R / O (E) / T / F ARM a tool instead of inserting at once (the finding:
 *     "no pointer placement or draw gesture"), each a toggle on its own key,
 *     V / Escape put it away, and ⏎ with a tool armed still inserts at the
 *     selection (a keyboard-only user is never stranded);
 *   - the drawn rectangle (⇧ square, ⌥ from the centre) and the styles one
 *     draw inserts with;
 *   - the empty-board seam P5-G registers on.
 *
 * The pointer gesture over a real frame is the e2e's
 * (`tests/e2e/canvas-tools-and-handles.e2e.ts`): it needs layout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasToolShortcuts } from '@site/canvas/useCanvasToolShortcuts'
import { useCanvasSelectionKeyboard } from '@site/canvas/useCanvasSelectionKeyboard'
import {
  DRAW_TOOL_SPECS,
  acceptsBoardDraws,
  drawInsertStyles,
  drawnRect,
  isDrawDrag,
  isDrawTool,
  offerBoardDraw,
  registerBoardDrawHandler,
  setDrawGestureActive,
  type CanvasBoardDraw,
} from '@site/canvas/canvasDrawTool'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

function seed() {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['box'] }),
      box: makeNode({ id: 'box', moduleId: 'base.container' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: 'box',
    selectedNodeIds: ['box'],
    selectedFrameIds: [],
    selectedAnnotations: [],
    activeInlineEdit: null,
    canvasTool: 'move',
    commentToolActive: false,
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event.defaultPrevented
}

function mount() {
  return renderHook(() => {
    useEditorKeyDispatcher()
    useCanvasSelectionKeyboard(true, false, () => {})
    useCanvasToolShortcuts(true, false)
  })
}

function rootChildren(): string[] {
  return [...useEditorStore.getState().site!.pages[0]!.nodes.root!.children]
}

beforeEach(seed)
afterEach(() => {
  cleanup()
  useEditorStore.setState({ canvasTool: 'move' } as Parameters<typeof useEditorStore.setState>[0])
})

describe('R / O / E / T / F arm a draw tool (IX-12)', () => {
  it('R ARMS the rectangle tool — nothing is inserted until you click or drag in a frame', () => {
    mount()
    expect(press({ key: 'r' })).toBe(true)
    expect(useEditorStore.getState().canvasTool).toBe('rectangle')
    // The pre-P5-E R inserted a box beside the selection on the key press.
    expect(rootChildren()).toEqual(['box'])
  })

  it('each key arms its own tool; pressing it again, or V, or Escape puts it away', () => {
    mount()
    press({ key: 'o' })
    expect(useEditorStore.getState().canvasTool).toBe('ellipse')
    press({ key: 'e' })
    expect(useEditorStore.getState().canvasTool).toBe('move')
    press({ key: 't' })
    expect(useEditorStore.getState().canvasTool).toBe('text')
    press({ key: 'v' })
    expect(useEditorStore.getState().canvasTool).toBe('move')
    press({ key: 'f' })
    expect(useEditorStore.getState().canvasTool).toBe('frame')
    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    press({ key: 'Escape' })
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })

  it('⏎ with a tool armed inserts at the selection (the old immediate insert) and disarms', () => {
    mount()
    press({ key: 'r' })
    expect(press({ key: 'Enter' })).toBe(true)
    const children = rootChildren()
    expect(children).toHaveLength(2)
    const inserted = useEditorStore.getState().site!.pages[0]!.nodes[children[1]!]!
    expect(inserted.moduleId).toBe('base.container')
    expect(inserted.inlineStyles).toMatchObject({ width: '100px', height: '100px' })
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })

  it('Escape DURING a draw ends the draw and keeps the selection (the node rung stands down)', () => {
    mount()
    press({ key: 'r' })
    setDrawGestureActive(true)
    press({ key: 'Escape' })
    setDrawGestureActive(false)
    expect(useEditorStore.getState().canvasTool).toBe('move')
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['box'])
  })

  it('without a tool armed, ⏎ keeps its layer meaning (select the children)', () => {
    mount()
    useEditorStore.getState().selectNode('root')
    press({ key: 'Enter' })
    expect(useEditorStore.getState().selectedNodeIds).toEqual(['box'])
    expect(rootChildren()).toEqual(['box'])
  })
})

describe('the drawn rectangle', () => {
  it('spans the two points in either direction', () => {
    expect(drawnRect({ x: 50, y: 40 }, { x: 10, y: 100 }, { square: false, fromCenter: false })).toEqual({ x: 10, y: 40, width: 40, height: 60 })
  })

  it('⇧ makes it square on the longer side; ⌥ draws from the centre', () => {
    expect(drawnRect({ x: 0, y: 0 }, { x: 30, y: 10 }, { square: true, fromCenter: false })).toEqual({ x: 0, y: 0, width: 30, height: 30 })
    expect(drawnRect({ x: 100, y: 100 }, { x: 110, y: 120 }, { square: false, fromCenter: true })).toEqual({ x: 90, y: 80, width: 20, height: 40 })
  })

  it('a press that barely moves is a click', () => {
    expect(isDrawDrag({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false)
    expect(isDrawDrag({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true)
  })
})

describe('what one draw inserts with', () => {
  it('a drag writes the drawn size in the frame’s CSS px (screen px ÷ zoom)', () => {
    expect(drawInsertStyles(DRAW_TOOL_SPECS.rectangle, { x: 0, y: 0, width: 120, height: 60 }, 0.5)).toEqual({
      background: '#d9d9d9',
      width: '240px',
      height: '120px',
    })
  })

  it('a click gives a box 100 × 100, and text its natural size', () => {
    expect(drawInsertStyles(DRAW_TOOL_SPECS.ellipse, null, 1)).toMatchObject({ borderRadius: '50%', width: '100px', height: '100px' })
    expect(drawInsertStyles(DRAW_TOOL_SPECS.text, null, 1)).toEqual({})
  })

  it('knows its tools', () => {
    expect(isDrawTool('rectangle')).toBe(true)
    expect(isDrawTool('hand')).toBe(false)
  })
})

describe('the empty-board seam (for P5-G)', () => {
  it('offers a board draw to the one registered handler, and nothing without one', () => {
    const draw: CanvasBoardDraw = { tool: 'rectangle', spec: DRAW_TOOL_SPECS.rectangle, boardRect: { x: 5, y: 6, width: 7, height: 8 }, dragged: true }
    expect(acceptsBoardDraws()).toBe(false)
    expect(offerBoardDraw(draw)).toBe(false)
    const seen: CanvasBoardDraw[] = []
    const unregister = registerBoardDrawHandler((received) => {
      seen.push(received)
      return true
    })
    expect(acceptsBoardDraws()).toBe(true)
    expect(offerBoardDraw(draw)).toBe(true)
    expect(seen).toEqual([draw])
    unregister()
    expect(acceptsBoardDraws()).toBe(false)
  })
})
