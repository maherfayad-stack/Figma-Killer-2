/**
 * P5-F / IX-13 — B, the board tool.
 *
 *   - B arms it (a toggle, like R / O / T / F);
 *   - a draw on the EMPTY board opens the add-page picker at the release
 *     point with the drawn placement, and never reaches the loose-layer
 *     handler P5-G registers;
 *   - the placement: a click is a point, a drag is a size floored at the
 *     minimum frame size, and a near-preset width becomes the preset's.
 *
 * The server half (the frame lands at the placement) is
 * `server/handlers/studio/__tests__/pageScaffold.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasToolShortcuts } from '@site/canvas/useCanvasToolShortcuts'
import { boardDrawPlacement, snapFrameWidthToPreset } from '@site/canvas/boardDrawTool'
import { registerBoardDrawHandler } from '@site/canvas/canvasDrawTool'
import { CanvasDrawToolLayer } from '@site/canvas/CanvasDrawToolLayer'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

beforeEach(() => {
  useEditorStore.setState({
    site: makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })] }),
    activePageId: 'page-1',
    selectedNodeId: null,
    selectedNodeIds: [],
    canvasTool: 'move',
    boardDrawRequest: null,
    activeInlineEdit: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ canvasTool: 'move', boardDrawRequest: null } as Parameters<typeof useEditorStore.setState>[0])
})

describe('B arms the board tool', () => {
  it('toggles on its own key', () => {
    renderHook(() => {
      useEditorKeyDispatcher()
      useCanvasToolShortcuts(true, false)
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    expect(useEditorStore.getState().canvasTool).toBe('board')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })
})

describe('the placement', () => {
  it('a click is a point; the board default size applies', () => {
    expect(boardDrawPlacement({ x: 100.4, y: -20.6, width: 0, height: 0 }, false)).toEqual({ x: 100, y: -21 })
  })

  it('a drag carries its size, floored at the minimum frame size', () => {
    expect(boardDrawPlacement({ x: 0, y: 0, width: 640, height: 120 }, true)).toEqual({ x: 0, y: 0, width: 640, height: 200 })
  })

  it('a width within a few units of a device preset becomes the preset', () => {
    expect(snapFrameWidthToPreset(1436)).toBe(1440)
    expect(snapFrameWidthToPreset(1446)).toBe(1440)
    expect(snapFrameWidthToPreset(640)).toBe(640)
    expect(snapFrameWidthToPreset(1460)).toBe(1460)
  })
})

describe('a draw on the empty board', () => {
  it('opens the page picker with the drawn placement, and never reaches the loose-layer handler', () => {
    const offered: unknown[] = []
    const unregister = registerBoardDrawHandler((draw) => {
      offered.push(draw)
      return true
    })
    useEditorStore.setState({ canvasTool: 'board' } as Parameters<typeof useEditorStore.setState>[0])
    const transformLayerRef = createRef<HTMLDivElement>()
    const layer = document.createElement('div')
    // Board (0, 0) on screen at (100, 50), zoom 1 (no transform to read).
    layer.getBoundingClientRect = () => ({ left: 100, top: 50, width: 0, height: 0, right: 100, bottom: 50, x: 100, y: 50 }) as DOMRect
    ;(transformLayerRef as { current: HTMLDivElement | null }).current = layer
    const { container } = render(<CanvasDrawToolLayer tool="board" transformLayerRef={transformLayerRef} />)
    const surface = container.querySelector<HTMLElement>('[data-canvas-draw-layer="board"]')!
    act(() => {
      fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 300, clientY: 150 })
      fireEvent.pointerUp(surface, { button: 0, pointerId: 1, clientX: 900, clientY: 1050 })
    })
    unregister()
    expect(offered).toEqual([])
    expect(useEditorStore.getState().boardDrawRequest).toEqual({
      placement: { x: 200, y: 100, width: 600, height: 900 },
      clientX: 900,
      clientY: 1050,
    })
    expect(useEditorStore.getState().canvasTool).toBe('move')
  })
})
