/**
 * PERF-3 — the selection toolbar and in-place inspector follow a pan/zoom on
 * every transform write, from a board-space anchor, with no measurement.
 *
 * Before, they were re-anchored only on the debounced pan/zoom COMMIT (100 ms
 * after the gesture), so they froze while the rings moved and then jumped.
 * The e2e budget (`canvas-feel-budgets.e2e.ts`, "pan with a selection")
 * measures that in a real browser; this pins the arithmetic and the wiring.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { CANVAS_VIEWPORT_IDLE_MS, markCanvasViewportActivity } from '@site/canvas/canvasViewportActivity'
import { beginCanvasGesture, endCanvasGesture } from '@site/canvas/canvasGesture'
import {
  projectCanvasRect,
  useSelectionChromeViewportFollow,
  type RecordSelectionChromeAnchor,
} from '@site/canvas/selectionChromeViewportFollow'

const CANVAS_RECT = { left: 0, top: 0, width: 2000, height: 1200, right: 2000, bottom: 1200, x: 0, y: 0 } as DOMRect
/** `positionToolbar` sits the toolbar this far above the selection. */
const TOOLBAR_VERTICAL_OFFSET = 30

afterEach(async () => {
  cleanup()
  await Bun.sleep(CANVAS_VIEWPORT_IDLE_MS + 20)
})

describe('projectCanvasRect', () => {
  it('a pan moves the rect by the pan delta', () => {
    const rect = { x: 300, y: 200, width: 100, height: 40 }
    expect(projectCanvasRect(rect, { zoom: 1, panX: 0, panY: 0 }, { zoom: 1, panX: -50, panY: 25 })).toEqual({
      x: 250,
      y: 225,
      width: 100,
      height: 40,
    })
  })

  it('a zoom scales about the transform layer origin (80 px into `.canvas`), not about 0,0', () => {
    const rect = { x: 180, y: 80, width: 100, height: 40 }
    // Board point (100, 0) at zoom 1 → at zoom 2 it is 200 board-px scaled from the layer origin.
    expect(projectCanvasRect(rect, { zoom: 1, panX: 0, panY: 0 }, { zoom: 2, panX: 0, panY: 0 })).toEqual({
      x: 280,
      y: 80,
      width: 200,
      height: 80,
    })
  })
})

describe('useSelectionChromeViewportFollow', () => {
  function mount(transform: CanvasTransform) {
    let record: RecordSelectionChromeAnchor = () => {}
    let toolbar: HTMLDivElement | null = null
    const expose = (next: RecordSelectionChromeAnchor) => {
      record = next
    }
    function Harness({ onRecord }: { onRecord: (next: RecordSelectionChromeAnchor) => void }) {
      const transformRef = useRef<CanvasTransform>(transform)
      const toolbarRef = useRef<HTMLDivElement | null>(null)
      const inspectorRef = useRef<HTMLDivElement | null>(null)
      const recordAnchor = useSelectionChromeViewportFollow({ transformRef, toolbarRef, inspectorRef })
      useEffect(() => onRecord(recordAnchor), [onRecord, recordAnchor])
      return (
        <>
          <div ref={toolbarRef} data-testid="toolbar" />
          <div ref={inspectorRef} />
        </>
      )
    }
    const view = render(<Harness onRecord={expose} />)
    toolbar = view.getByTestId('toolbar') as HTMLDivElement
    return { record: (...args: Parameters<RecordSelectionChromeAnchor>) => record(...args), toolbar: toolbar! }
  }

  it('re-positions the toolbar on every transform write, in the same task', () => {
    const transform: CanvasTransform = { zoom: 1, panX: 0, panY: 0 }
    const { record, toolbar } = mount(transform)
    record({ toolbar: { x: 400, y: 300, width: 120, height: 40 }, inspector: null, canvasRect: CANVAS_RECT })

    transform.panX = -120
    transform.panY = 40
    markCanvasViewportActivity()
    expect(toolbar.style.left).toBe('280px')
    expect(toolbar.style.top).toBe(`${340 - TOOLBAR_VERTICAL_OFFSET}px`)

    transform.panX = -200
    markCanvasViewportActivity()
    expect(toolbar.style.left).toBe('200px')
  })

  it('holds still during a page-mutating gesture, and follows nothing once the anchor is cleared', () => {
    const transform: CanvasTransform = { zoom: 1, panX: 0, panY: 0 }
    const { record, toolbar } = mount(transform)
    record({ toolbar: { x: 400, y: 300, width: 120, height: 40 }, inspector: null, canvasRect: CANVAS_RECT })

    const gesture = beginCanvasGesture()
    transform.panX = -50
    markCanvasViewportActivity()
    expect(toolbar.style.left).toBe('')
    endCanvasGesture(gesture)

    record(null)
    transform.panX = -90
    markCanvasViewportActivity()
    expect(toolbar.style.left).toBe('')
  })
})
