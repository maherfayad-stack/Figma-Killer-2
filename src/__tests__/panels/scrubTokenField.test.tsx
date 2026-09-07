/**
 * ScrubTokenField — the token-aware half of the ONE scrub engine.
 *
 * `ScrubTokenField` used to carry its own copy of the drag gesture. It now
 * calls `useScrubDrag`, the same hook `ScrubInput` calls, so these tests are
 * asserting a shared contract rather than a second implementation of it: the
 * keyword/token refusal, the 1/10/0.1 ladder, min/max clamping, the click-to-
 * focus fallthrough, and the rAF-coalesced preview channel the old copy did
 * not have at all.
 *
 * Real `PointerEvent`s are dispatched against the rendered mark (happy-dom
 * implements `PointerEvent` + `set/has/releasePointerCapture` natively), the
 * same approach `ScrubInput`'s own suite takes — not a mock of the handler.
 */
import { describe, expect, it, mock, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ScrubTokenField } from '@site/panels/PropertiesPanel/LayoutSection/ScrubTokenField'
import type { Token } from '@site/property-controls/tokenUtils'

afterEach(cleanup)

const TOKENS: ReadonlyArray<Token> = [
  { step: 'md', varName: '--space-md', valueExpr: 'var(--space-md)', groupName: 'Spacing', prefix: 'space' },
]

function pointerDown(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX, ...extra })
}
function pointerMove(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX, ...extra })
}
function pointerUp(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerUp(el, { pointerId: 1, clientX, ...extra })
}

interface HarnessProps {
  value?: string
  min?: number
  max?: number
  unit?: string
  onCommit?: (v: string | undefined) => void
  onPreview?: (v: string | undefined) => void
}

function renderField({ value = '16px', min, max, unit, onCommit = () => {}, onPreview }: HarnessProps) {
  const result = render(
    <ScrubTokenField
      aria-label="Padding left"
      value={value}
      tokens={TOKENS}
      prefix="L"
      unit={unit}
      min={min}
      max={max}
      onCommit={onCommit}
      onPreview={onPreview}
      data-testid="pad-l"
    />,
  )
  // The mark is `aria-hidden` decoration, so it is reached by test id rather
  // than an accessible query — it is a pointer-only affordance by design (the
  // field itself is the keyboard-accessible control).
  return { ...result, handle: screen.getByTestId('pad-l-handle') }
}

describe('ScrubTokenField — the scrub gesture', () => {
  it('drags the mark to change the value, committing once on release', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '16px', onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 8)
    pointerMove(handle, 24)
    pointerUp(handle, 24)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith('40px')
  })

  it('drags 10x faster with Shift and 0.1x with Alt — the one ladder', () => {
    const shiftCommit = mock((_v: string | undefined) => {})
    const shift = renderField({ value: '10px', onCommit: shiftCommit })
    pointerDown(shift.handle, 0, { shiftKey: true })
    pointerMove(shift.handle, 4, { shiftKey: true })
    pointerUp(shift.handle, 4, { shiftKey: true })
    expect(shiftCommit).toHaveBeenLastCalledWith('50px')

    cleanup()

    const altCommit = mock((_v: string | undefined) => {})
    const alt = renderField({ value: '10px', onCommit: altCommit })
    pointerDown(alt.handle, 0, { altKey: true })
    pointerMove(alt.handle, 20, { altKey: true })
    pointerUp(alt.handle, 20, { altKey: true })
    expect(altCommit).toHaveBeenLastCalledWith('12px')
  })

  it('Alt beats Shift when both are held (the more specific request wins)', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '10px', onCommit })

    pointerDown(handle, 0, { altKey: true, shiftKey: true })
    pointerMove(handle, 20, { altKey: true, shiftKey: true })
    pointerUp(handle, 20, { altKey: true, shiftKey: true })

    expect(onCommit).toHaveBeenLastCalledWith('12px')
  })

  it('clamps to min — a drag below zero stops at zero rather than emitting a negative length', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '4px', min: 0, onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, -40)
    pointerUp(handle, -40)

    expect(onCommit).toHaveBeenLastCalledWith('0px')
  })

  it('clamps to max', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '0.5', unit: '', max: 1, onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 40)
    pointerUp(handle, 40)

    expect(onCommit).toHaveBeenLastCalledWith('1')
  })

  it('starts a drag from an empty field in the field’s own unit', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '', unit: 'rem', onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 3)
    pointerUp(handle, 3)

    expect(onCommit).toHaveBeenLastCalledWith('3rem')
  })

  it('refuses to drag a token expression — there is no numeric baseline', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: 'var(--space-md)', onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 24)
    pointerUp(handle, 24)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a click with no movement focuses the field for typing instead of committing', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '16px', onCommit })

    pointerDown(handle, 12)
    pointerUp(handle, 12)

    expect(onCommit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByLabelText('Padding left'))
  })

  it('does not re-commit a drag that landed back on the value it started from', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '16px', onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 10)
    pointerUp(handle, 0)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('shows the live value while dragging, without committing per move', () => {
    const onCommit = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '16px', onCommit })

    pointerDown(handle, 0)
    pointerMove(handle, 9)

    expect((screen.getByLabelText('Padding left') as HTMLInputElement).value).toBe('25px')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('coalesces a burst of pointermoves into one onPreview per frame', async () => {
    const onPreview = mock((_v: string | undefined) => {})
    const { handle } = renderField({ value: '0px', onPreview })

    pointerDown(handle, 0)
    for (let x = 1; x <= 12; x++) pointerMove(handle, x)

    // Nothing has been flushed yet — the frame has not run.
    expect(onPreview).not.toHaveBeenCalled()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith('12px')
  })
})
