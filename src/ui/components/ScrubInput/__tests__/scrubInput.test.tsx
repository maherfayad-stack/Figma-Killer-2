/**
 * ScrubInput interaction tests.
 *
 * These dispatch REAL `PointerEvent`/`KeyboardEvent`s against the rendered
 * DOM through the component's own `onPointerDown/Move/Up`/`onKeyDown`
 * handlers — not a mock of the handler, and not a pure-geometry test of the
 * math in isolation (that's `scrubMath.test.ts`). This is the distinction
 * `STATE.md`'s standing authorization calls out: `board-01`'s marquee
 * selection shipped 11 green geometry tests while being unreachable by
 * mouse, because nothing ever drove a real pointer event against the actual
 * event-bound DOM. happy-dom (this repo's `bun test` environment) implements
 * `PointerEvent` and `set/has/releasePointerCapture` natively (verified
 * directly against the happy-dom package before writing this file — see the
 * handoff), so this file exercises the true browser-facing gesture, not a
 * jsdom-only approximation.
 *
 * What this file does NOT prove: layout-dependent behavior (getBoundingClientRect
 * positioning, visual drag-cursor rendering) — happy-dom has no layout engine
 * for that, same limitation `standing-02` documents for canvas geometry. The
 * drag math here is computed purely from event `clientX` deltas, which
 * happy-dom reports correctly regardless of layout, so that limitation
 * doesn't apply to what's being tested. No Playwright/real-browser pass was
 * run for this component — this is a happy-dom pointer-event integration
 * test, stated plainly per the work order's instruction.
 */
import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { ScrubInput } from '../ScrubInput'
import { MIXED } from '../../MixedValue'

function pointerDown(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX, ...extra })
}
function pointerMove(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX, ...extra })
}
function pointerUp(el: Element, clientX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerUp(el, { pointerId: 1, clientX, ...extra })
}

describe('ScrubInput — drag-on-label scrub', () => {
  it('drags the label to increase the value by the pixel delta (1:1 scale)', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="100px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    pointerMove(label, 24)
    pointerUp(label, 24)

    // Live preview during drag fires onChange on every move (no onPreview
    // wired here), and the final pointerup commits the same resolved value —
    // assert the LAST call, which is what actually lands.
    expect(onChange).toHaveBeenLastCalledWith('124px')
  })

  it('drags the label down (negative clientX delta) to decrease the value', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="100px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 100)
    pointerMove(label, 76)
    pointerUp(label, 76)

    expect(onChange).toHaveBeenLastCalledWith('76px')
  })

  it('drags 10x faster while Shift is held', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="100px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0, { shiftKey: true })
    pointerMove(label, 5, { shiftKey: true })
    pointerUp(label, 5, { shiftKey: true })

    expect(onChange).toHaveBeenLastCalledWith('150px')
  })

  it('a click with no movement focuses the text field instead of committing a value', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="100px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')
    const field = screen.getByTestId('w-field') as HTMLInputElement

    pointerDown(label, 50)
    pointerUp(label, 50)

    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
  })

  it('does not start a drag when the value is a non-numeric keyword', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="auto" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    pointerMove(label, 50)
    pointerUp(label, 50)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables dragging entirely for the MIXED sentinel', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value={MIXED} onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')
    const field = screen.getByTestId('w-field') as HTMLInputElement

    expect(field.placeholder).toBe('Mixed')
    pointerDown(label, 0)
    pointerMove(label, 50)
    pointerUp(label, 50)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ScrubInput — keyboard steps', () => {
  it('ArrowUp/ArrowDown step by 1', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="10px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field')

    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('11px')

    // The test doesn't feed the committed value back through the `value` prop
    // (no store round-trip here — see scrubMath.test.ts / the real SizeSection
    // integration for that), so the field's own draft is now '11px' and a
    // second ArrowDown steps from THAT, landing on '10px' — exactly what a
    // real user watching the field would expect from two opposite key presses.
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('10px')
  })

  it('Shift+ArrowUp steps by shiftStep (10)', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="10px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field')

    fireEvent.keyDown(field, { key: 'ArrowUp', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith('20px')
  })

  it('does not step a keyword value', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="auto" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field')

    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Escape reverts an in-progress typed edit and blurs', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="10px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field') as HTMLInputElement

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '999px' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(field.value).toBe('10px')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('ScrubInput — typing commits on blur', () => {
  it('commits a typed value on blur', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value="10px" onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field')

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '250px' } })
    fireEvent.blur(field)

    expect(onChange).toHaveBeenCalledWith('250px')
  })

  it('typing over a Mixed value replaces it (caller decides "on all")', () => {
    const onChange = mock(() => {})
    render(<ScrubInput value={MIXED} onChange={onChange} label="W" aria-label="Width" data-testid="w" />)
    const field = screen.getByTestId('w-field')

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '40px' } })
    fireEvent.blur(field)

    expect(onChange).toHaveBeenCalledWith('40px')
  })
})

/**
 * `onPreview` rAF-coalescing (see the ScrubInput file docblock for the
 * defect: an uncoalesced `pointermove` → live-store-write path multiplied by
 * N mounted breakpoint iframes' `ClassStyleInjector`s). `fireEvent.pointerMove`
 * dispatches synchronously — a burst of them inside one JS task always lands
 * inside the SAME animation frame, exactly like a fast real-hardware drag
 * gesture whose `pointermove` events outrun the display refresh rate.
 */
describe('ScrubInput — onPreview rAF-coalescing', () => {
  it('collapses a burst of pointermoves within one frame into a single onPreview call', async () => {
    const onPreview = mock((_next: string) => {})
    render(<ScrubInput value="100px" onChange={mock(() => {})} onPreview={onPreview} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    // 20 pointermoves in one synchronous burst — no store write must land
    // per move.
    for (let dx = 1; dx <= 20; dx += 1) {
      pointerMove(label, dx)
    }
    expect(onPreview).not.toHaveBeenCalled()

    // Let the coalesced frame flush.
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(onPreview).toHaveBeenCalledTimes(1)
    // The coalesced call carries the LATEST value from the burst, not a
    // stale intermediate one.
    expect(onPreview).toHaveBeenLastCalledWith('120px')

    pointerUp(label, 20)
  })

  it('never drops the final value on release, even mid-coalesced-frame', () => {
    const onChange = mock((_next: string) => {})
    const onPreview = mock((_next: string) => {})
    render(<ScrubInput value="100px" onChange={onChange} onPreview={onPreview} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    pointerMove(label, 5)
    // Release happens before the coalesced preview frame has had a chance to
    // fire — the committed value must still be exactly correct, computed
    // fresh rather than riding the (now-cancelled) scheduled preview.
    pointerUp(label, 5)

    expect(onChange).toHaveBeenLastCalledWith('105px')
  })

  it('a completed drag eventually fires onPreview at least once during the gesture (liveness — the canvas never goes silent while scrubbing)', async () => {
    const onPreview = mock((_next: string) => {})
    render(<ScrubInput value="100px" onChange={mock(() => {})} onPreview={onPreview} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    pointerMove(label, 10)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    pointerMove(label, 25)
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(onPreview.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(onPreview).toHaveBeenLastCalledWith('125px')

    pointerUp(label, 25)
  })

  it('cancels a pending coalesced preview on unmount (no callback into a torn-down caller)', async () => {
    const onPreview = mock((_next: string) => {})
    const view = render(<ScrubInput value="100px" onChange={mock(() => {})} onPreview={onPreview} label="W" aria-label="Width" data-testid="w" />)
    const label = screen.getByTestId('w-label')

    pointerDown(label, 0)
    pointerMove(label, 10)
    view.unmount()

    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(onPreview).not.toHaveBeenCalled()
  })
})
