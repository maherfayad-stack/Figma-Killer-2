/**
 * A prefilled inspector field must not write on a bare focus/blur.
 *
 * Since WS `#73` (`styleFieldDisplay.ts`) a property the active target does
 * NOT declare is displayed with the value the element actually renders. That
 * module's own doc states the safety rule it depends on:
 *
 *   "Committing the SAME value writes nothing — every field's commit path
 *    compares against what it was displaying — so merely focusing and
 *    blurring a prefilled field can never silently add a declaration to
 *    someone's stylesheet."
 *
 * `ScrubInput` did compare. `TokenAwareInput` — the input behind every
 * `ScrubTokenField` (Position insets, Layout gap, per-side spacing) and
 * behind `SpacingBoxControl`'s four sides — did not: its `commit()` called
 * `onCommit` unconditionally from `onBlur`. With prefill in place, clicking
 * into a padding side and clicking away wrote `paddingTop: 16px` into the
 * user's source for real AND pushed an undo entry that changes nothing
 * visible. A panel click-through therefore buried the user's real edits under
 * a stack of phantom entries, and Ctrl+Z "did nothing".
 *
 * These are the guard's regression tests.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import type { Token } from '@site/property-controls/tokenUtils'

afterEach(cleanup)

const TOKENS: ReadonlyArray<Token> = [
  {
    step: 'md',
    varName: '--space-md',
    valueExpr: 'var(--space-md)',
    groupName: 'Spacing',
    prefix: 'space',
  },
]

describe('TokenAwareInput — commit guard', () => {
  it('does not commit when a prefilled field is focused and blurred untouched', () => {
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Padding top"
        value="16px"
        tokens={[]}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Padding top')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not commit when Enter is pressed on an untouched prefilled field', () => {
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Gap"
        value="24px"
        tokens={[]}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Gap')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not commit when an empty (unset) field is focused and blurred', () => {
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Left"
        value={undefined}
        tokens={[]}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Left')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('still commits a value the user actually changed', () => {
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Padding top"
        value="16px"
        tokens={[]}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Padding top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '24px' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('24px')
  })

  it('still commits a clear (the user emptied a set field)', () => {
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Padding top"
        value="16px"
        tokens={[]}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Padding top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(undefined)
  })

  it('does not commit when a token value round-trips to its own short display', () => {
    // `var(--space-md)` displays as `md`; blurring must resolve `md` back to
    // `var(--space-md)`, see it is unchanged, and write nothing.
    const onCommit = mock(() => {})
    render(
      <TokenAwareInput
        aria-label="Gap"
        value="var(--space-md)"
        tokens={TOKENS}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Gap')
    expect((input as HTMLInputElement).value).toBe('md')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
