import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlignBar } from '../AlignBar'

// The shared Button primitive renders `disabled` as `aria-disabled` (not the
// native `disabled` attribute) whenever a tooltip is also present — a
// disabled+tooltip button still needs mouseenter to fire so the tooltip can
// explain WHY it's disabled. AlignBar's buttons always carry a tooltip, so
// this is the correct disabled check for them, matching Button's own
// documented behaviour (`Button.tsx`'s `useAriaDisabled`).
function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true'
}

describe('AlignBar', () => {
  it('fires onAlign with the clicked edge', async () => {
    const user = userEvent.setup()
    const onAlign = mock(() => {})
    render(<AlignBar count={2} onAlign={onAlign} />)

    await user.click(screen.getByTestId('align-bar-left'))
    expect(onAlign).toHaveBeenCalledWith('left')

    await user.click(screen.getByTestId('align-bar-middle'))
    expect(onAlign).toHaveBeenCalledWith('middle')
  })

  it('disables align buttons below minAlign (default 2)', () => {
    render(<AlignBar count={1} onAlign={() => {}} />)
    expect(isDisabled(screen.getByTestId('align-bar-left'))).toBe(true)
  })

  it('enables align buttons at minAlign', () => {
    render(<AlignBar count={2} onAlign={() => {}} />)
    expect(isDisabled(screen.getByTestId('align-bar-left'))).toBe(false)
  })

  it('hides the distribute row when onDistribute and onTidy are both omitted', () => {
    render(<AlignBar count={5} onAlign={() => {}} />)
    expect(screen.queryByRole('group', { name: 'Distribute selection' })).toBeNull()
  })

  it('disables distribute buttons below minDistribute (default 3)', () => {
    render(<AlignBar count={2} onAlign={() => {}} onDistribute={() => {}} />)
    expect(isDisabled(screen.getByTestId('align-bar-distribute-horizontal'))).toBe(true)
  })

  it('fires onDistribute with the clicked axis once minDistribute is met', async () => {
    const user = userEvent.setup()
    const onDistribute = mock(() => {})
    render(<AlignBar count={3} onAlign={() => {}} onDistribute={onDistribute} />)

    await user.click(screen.getByTestId('align-bar-distribute-vertical'))
    expect(onDistribute).toHaveBeenCalledWith('vertical')
  })

  it('fires onTidy regardless of count', async () => {
    const user = userEvent.setup()
    const onTidy = mock(() => {})
    render(<AlignBar count={1} onAlign={() => {}} onTidy={onTidy} />)

    await user.click(screen.getByTestId('align-bar-tidy'))
    expect(onTidy).toHaveBeenCalled()
  })

  it('disabled prop overrides count thresholds entirely', () => {
    render(<AlignBar count={10} onAlign={() => {}} onDistribute={() => {}} disabled />)
    expect(isDisabled(screen.getByTestId('align-bar-left'))).toBe(true)
    expect(isDisabled(screen.getByTestId('align-bar-distribute-horizontal'))).toBe(true)
  })
})
