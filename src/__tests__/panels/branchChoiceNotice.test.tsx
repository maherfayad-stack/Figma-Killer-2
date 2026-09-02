/**
 * BranchChoiceNotice — R6's switcher, scoped honestly (see the component's
 * own doc comment): each alternative is expandable and offers a real
 * jump-to-source action; nothing here swaps which branch RENDERS on the
 * canvas (that remains a separate, cross-cutting, deferred change).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BranchChoiceNotice } from '@site/panels/PropertiesPanel/BranchChoiceNotice'

afterEach(cleanup)

const ALTERNATIVES = [
  { label: 'loading', loc: { file: 'src/screens/Home.jsx', line: 40, col: 5 } },
  { label: 'error', loc: { file: 'src/screens/Home.jsx', line: 52, col: 5 } },
]

describe('BranchChoiceNotice', () => {
  it('names every alternative and the total state count', () => {
    render(<BranchChoiceNotice alternatives={ALTERNATIVES} />)
    const notice = screen.getByTestId('branch-choice-notice')
    expect(notice.textContent).toContain('one of 3 states')
    expect(notice.textContent).toContain('loading')
    expect(notice.textContent).toContain('error')
  })

  it('is collapsed by default — no jump-to-source button visible', () => {
    render(<BranchChoiceNotice alternatives={ALTERNATIVES} />)
    expect(screen.queryByText(/Open src\/screens\/Home\.jsx/)).toBeNull()
  })

  it('expands an alternative on click, revealing its jump-to-source action', () => {
    render(<BranchChoiceNotice alternatives={ALTERNATIVES} />)
    fireEvent.click(screen.getByRole('button', { name: /loading/i }))
    expect(screen.getByText(/Open src\/screens\/Home\.jsx \(line 40\)/)).toBeTruthy()
  })

  it('collapses again on a second click of the same alternative', () => {
    render(<BranchChoiceNotice alternatives={ALTERNATIVES} />)
    const trigger = screen.getByRole('button', { name: /loading/i })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByText(/Open src\/screens\/Home\.jsx/)).toBeNull()
  })

  it('only one alternative is expanded at a time', () => {
    render(<BranchChoiceNotice alternatives={ALTERNATIVES} />)
    fireEvent.click(screen.getByRole('button', { name: /loading/i }))
    fireEvent.click(screen.getByRole('button', { name: /error/i }))
    expect(screen.queryByText(/line 40/)).toBeNull()
    expect(screen.getByText(/line 52/)).toBeTruthy()
  })
})
