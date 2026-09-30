/**
 * P2-I (PERF-1) — the `CanvasSelectionContext` value never changes identity.
 *
 * Every `NodeRenderer` consumes that context. `CanvasRoot` re-renders on every
 * selection, and `useCanvasNodeInteraction` used to hand back a fresh object
 * each time, so every click re-rendered every mounted node: measured, 2,799
 * `NodeRenderer` renders per click on the 40 × 300 corpus with nine frames
 * mounted (`canvas-feel-budgets.e2e.ts`'s warm click). The hook now returns a
 * facade created once that calls the latest handlers.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { getCanvasHover } from '@site/canvas/canvasHover'
import { useCanvasNodeInteraction, type CanvasNodeInteractionOptions } from '@site/canvas/useCanvasNodeInteraction'

afterEach(() => cleanup())

function options(overrides: Partial<CanvasNodeInteractionOptions> = {}): CanvasNodeInteractionOptions {
  return {
    editable: true,
    isLive: false,
    canEditContent: true,
    playMode: false,
    canvasPage: null,
    overlayPage: null,
    activeBreakpointId: 'desktop',
    preserveSelectionWhenActivatingBreakpoint: false,
    openContextMenu: () => {},
    ...overrides,
  }
}

describe('useCanvasNodeInteraction', () => {
  it('returns the same object across re-renders with new options', () => {
    const { result, rerender } = renderHook((props: CanvasNodeInteractionOptions) => useCanvasNodeInteraction(props), {
      initialProps: options(),
    })
    const first = result.current
    rerender(options({ activeBreakpointId: 'mobile', preserveSelectionWhenActivatingBreakpoint: true }))
    rerender(options({ openContextMenu: () => {} }))
    expect(result.current).toBe(first)
    expect(result.current.onNodeClick).toBe(first.onNodeClick)
  })

  it('the stable handlers act on the LATEST options', () => {
    const { result, rerender } = renderHook((props: CanvasNodeInteractionOptions) => useCanvasNodeInteraction(props), {
      initialProps: options({ playMode: false }),
    })
    act(() => result.current.onNodeHover('a', 'desktop', null))
    expect(getCanvasHover()?.nodeId).toBe('a')

    // Armed player: a hover is no longer an editing hover.
    rerender(options({ playMode: true }))
    act(() => result.current.onNodeHover('b', 'desktop', null))
    expect(getCanvasHover()?.nodeId).toBe('a')

    rerender(options({ playMode: false }))
    const event = { stopPropagation: () => {}, shiftKey: false, metaKey: false, ctrlKey: false } as unknown as ReactMouseEvent
    act(() => result.current.onNodeClick('c', event, 'desktop', null))
    expect(useEditorStore.getState().selectedNodeId).toBe('c')
  })
})
