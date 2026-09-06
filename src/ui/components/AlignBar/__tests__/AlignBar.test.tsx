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
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')
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

  it('hides the overflow trigger when onDistribute and onTidy are both omitted', () => {
    render(<AlignBar count={5} onAlign={() => {}} />)
    expect(screen.queryByTestId('align-bar-more')).toBeNull()
  })

  it('disabled prop overrides count thresholds entirely', () => {
    render(<AlignBar count={10} onAlign={() => {}} onDistribute={() => {}} disabled />)
    expect(isDisabled(screen.getByTestId('align-bar-left'))).toBe(true)
    expect(isDisabled(screen.getByTestId('align-bar-more'))).toBe(true)
  })

  describe('overflow menu (distribute + tidy)', () => {
    it('renders all three items with their shortcuts once opened', async () => {
      const user = userEvent.setup()
      render(<AlignBar count={5} onAlign={() => {}} onDistribute={() => {}} onTidy={() => {}} />)

      await user.click(screen.getByTestId('align-bar-more'))

      expect(screen.getByTestId('align-bar-tidy')).toBeTruthy()
      expect(screen.getByTestId('align-bar-distribute-horizontal')).toBeTruthy()
      expect(screen.getByTestId('align-bar-distribute-vertical')).toBeTruthy()
      expect(screen.getByText('Tidy up')).toBeTruthy()
      expect(screen.getByText('Distribute horizontal spacing')).toBeTruthy()
      expect(screen.getByText('Distribute vertical spacing')).toBeTruthy()
    })

    it('disables distribute items below minDistribute (default 3) but not tidy', async () => {
      const user = userEvent.setup()
      render(<AlignBar count={2} onAlign={() => {}} onDistribute={() => {}} onTidy={() => {}} />)

      await user.click(screen.getByTestId('align-bar-more'))

      expect(isDisabled(screen.getByTestId('align-bar-distribute-horizontal'))).toBe(true)
      expect(isDisabled(screen.getByTestId('align-bar-tidy'))).toBe(false)
    })

    it('fires onDistribute with the clicked axis once minDistribute is met', async () => {
      const user = userEvent.setup()
      const onDistribute = mock(() => {})
      render(<AlignBar count={3} onAlign={() => {}} onDistribute={onDistribute} />)

      await user.click(screen.getByTestId('align-bar-more'))
      await user.click(screen.getByTestId('align-bar-distribute-vertical'))
      expect(onDistribute).toHaveBeenCalledWith('vertical')
    })

    it('fires onTidy regardless of count', async () => {
      const user = userEvent.setup()
      const onTidy = mock(() => {})
      render(<AlignBar count={1} onAlign={() => {}} onTidy={onTidy} />)

      await user.click(screen.getByTestId('align-bar-more'))
      await user.click(screen.getByTestId('align-bar-tidy'))
      expect(onTidy).toHaveBeenCalled()
    })
  })

  describe('alignDisabledReasons (single-node mode)', () => {
    it('disables only the edges with a reason, independent of count', () => {
      render(
        <AlignBar
          count={1}
          onAlign={() => {}}
          minAlign={0}
          alignDisabledReasons={{ left: 'Align needs a flex or grid parent.' }}
        />,
      )
      expect(isDisabled(screen.getByTestId('align-bar-left'))).toBe(true)
      expect(isDisabled(screen.getByTestId('align-bar-top'))).toBe(false)
    })

    it('surfaces the reason as the button tooltip on hover', async () => {
      const user = userEvent.setup()
      render(
        <AlignBar
          count={1}
          onAlign={() => {}}
          minAlign={0}
          alignDisabledReasons={{ left: '2 siblings share this axis.' }}
        />,
      )
      await user.hover(screen.getByTestId('align-bar-left'))
      expect(await screen.findByText('2 siblings share this axis.')).toBeTruthy()
    })
  })
})
