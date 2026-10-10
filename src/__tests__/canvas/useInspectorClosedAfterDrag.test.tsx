import { describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useInspectorClosedAfterDrag } from '@site/canvas/useInspectorClosedAfterDrag'

interface Props {
  dragging: boolean
  signature: string
}

function render(initial: Props) {
  return renderHook(({ dragging, signature }: Props) => useInspectorClosedAfterDrag(dragging, signature, signature !== ''), {
    initialProps: initial,
  })
}

describe('useInspectorClosedAfterDrag', () => {
  it('is open while idle and while a drag is in flight', () => {
    const { result, rerender } = render({ dragging: false, signature: 'tab' })
    expect(result.current).toBe(false)
    rerender({ dragging: true, signature: 'tab' })
    expect(result.current).toBe(false)
  })

  it('closes when a drag ends — a refused drag included — for that selection', () => {
    const { result, rerender } = render({ dragging: false, signature: 'tab' })
    rerender({ dragging: true, signature: 'tab' })
    rerender({ dragging: false, signature: 'tab' })
    expect(result.current).toBe(true)
  })

  it('comes back for another selection, and after the selection clears', () => {
    const { result, rerender } = render({ dragging: false, signature: 'tab' })
    rerender({ dragging: true, signature: 'tab' })
    rerender({ dragging: false, signature: 'tab' })
    rerender({ dragging: false, signature: 'card' })
    expect(result.current).toBe(false)
    rerender({ dragging: false, signature: 'tab' })
    expect(result.current).toBe(true)
    rerender({ dragging: false, signature: '' })
    rerender({ dragging: false, signature: 'tab' })
    expect(result.current).toBe(false)
  })
})
