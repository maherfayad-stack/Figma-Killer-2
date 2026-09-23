/**
 * ERR-12 — ruler guide drags recover from a release they never heard.
 *
 * Both guide gestures (moving a guide, dragging a new one out of a ruler)
 * listened on the parent `document` with no pointer capture and no
 * cross-iframe relay. The board is mostly iframes, so a release over a frame
 * went to THAT document: the line kept following the cursor with the button
 * up, and a new-guide preview never went away. They now hold capture, arm the
 * relay, and run under `guardDragSession`.
 */
import type { PointerEvent as ReactPointerEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { RulerGuidesLayer } from '@site/canvas/RulerGuidesLayer/RulerGuidesLayer'
import { useRulerGuideCreation } from '@site/canvas/CanvasRulers/useRulerGuideCreation'
import { CanvasViewportActionsContext } from '@site/canvas/CanvasContexts'
import { readCanvasPointerRelay } from '@site/canvas/canvasPointerRelay'
import { useEditorStore } from '@site/store/store'
import { screenToBoard } from '@site/canvas/CanvasRulers/rulerGeometry'

/** Board position of a client x at zoom 1, pan 0 — the transform layer sits offset inside the canvas root. */
const board = (clientX: number) => screenToBoard(clientX, 1, 0)

function nativeMove(buttons: number, clientX: number, clientY = 0) {
  const event = new Event('pointermove', { bubbles: true, cancelable: true })
  Object.assign(event, { buttons, clientX, clientY, pointerId: 3 })
  document.body.dispatchEvent(event)
}

function canvasRoot(): HTMLElement {
  const root = document.createElement('div')
  root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect
  document.body.appendChild(root)
  return root
}

const transformRef = { current: { zoom: 1, panX: 0, panY: 0 } }

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  mock.restore()
})

describe('moving a guide', () => {
  function seedGuide(moves: Array<[string, number]>) {
    const guideBoard = createBoard('board-1', 'Board 1')
    guideBoard.guides = [{ id: 'g1', axis: 'x', position: 100 }]
    const file: BoardsFile = { version: 1, boards: [guideBoard] }
    useEditorStore.getState().loadBoards(file)
    useEditorStore.setState({
      activeBoardId: guideBoard.id,
      moveGuide: (id: string, position: number) => moves.push([id, position]),
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('captures the pointer, arms the relay, and drops at the last point when the release was lost', () => {
    const moves: Array<[string, number]> = []
    seedGuide(moves)
    const root = canvasRoot()
    const { getByTestId } = render(
      <CanvasViewportActionsContext.Provider value={{ canvasRootRef: { current: root }, panBy: () => {}, transformRef }}>
        <RulerGuidesLayer />
      </CanvasViewportActionsContext.Provider>,
    )
    const line = getByTestId('ruler-guide-line')
    const capture = mock(() => {})
    line.setPointerCapture = capture

    act(() => {
      fireEvent.pointerDown(line, { button: 0, pointerId: 3, clientX: 100 })
    })
    expect(capture).toHaveBeenCalledWith(3)
    expect(readCanvasPointerRelay(document)).toEqual({ pointerId: 3 })

    act(() => nativeMove(1, 180))
    // The button came up over a frame this document never heard from.
    act(() => nativeMove(0, 400))
    expect(moves).toEqual([['g1', board(180)]])
    expect(readCanvasPointerRelay(document)).toBeNull()
    // Over: later moves do nothing.
    act(() => nativeMove(1, 500))
    expect(moves).toHaveLength(1)
  })

  it('a window blur puts the line back and moves nothing', async () => {
    const moves: Array<[string, number]> = []
    seedGuide(moves)
    const root = canvasRoot()
    const { getByTestId } = render(
      <CanvasViewportActionsContext.Provider value={{ canvasRootRef: { current: root }, panBy: () => {}, transformRef }}>
        <RulerGuidesLayer />
      </CanvasViewportActionsContext.Provider>,
    )
    const line = getByTestId('ruler-guide-line')
    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => {
      fireEvent.pointerDown(line, { button: 0, pointerId: 3, clientX: 100 })
    })
    act(() => nativeMove(1, 180))
    expect(line.style.getPropertyValue('--guide-position')).toBe(`${board(180)}px`)
    window.dispatchEvent(new Event('blur'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(moves).toEqual([])
    expect(line.style.getPropertyValue('--guide-position')).toBe('100px')
    hasFocus.mockRestore()
  })
})

describe('dragging a new guide out of a ruler', () => {
  it('creates the guide at the last point when the release was lost, and hides the preview', () => {
    const created: Array<[string, number]> = []
    const root = canvasRoot()
    const { result } = renderHook(() =>
      useRulerGuideCreation({
        axis: 'x',
        canvasRootRef: { current: root },
        transformRef,
        onCreate: (axis, position) => created.push([axis, position]),
      }),
    )
    const preview = document.createElement('div')
    result.current.previewElRef.current = preview
    const ruler = document.createElement('div')
    const capture = mock(() => {})
    ruler.setPointerCapture = capture

    act(() => {
      result.current.onPointerDown!({
        currentTarget: ruler,
        pointerId: 3,
        clientX: 10,
        clientY: 0,
        preventDefault: () => {},
      } as unknown as ReactPointerEvent<HTMLElement>)
    })
    expect(capture).toHaveBeenCalledWith(3)
    expect(preview.style.display).toBe('block')

    act(() => nativeMove(1, 250))
    act(() => nativeMove(0, 600))
    expect(created).toEqual([['x', board(250)]])
    expect(preview.style.display).toBe('none')
    expect(readCanvasPointerRelay(document)).toBeNull()
  })
})
