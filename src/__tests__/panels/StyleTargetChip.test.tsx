import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StyleTargetChip } from '@site/panels/PropertiesPanel/StyleTargetChip'

describe('StyleTargetChip', () => {
  it('shows the class selector and marks it pressed when target is class', () => {
    render(<StyleTargetChip target="class" classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.textContent).toContain('.card')
    expect(classChip.getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('style-target-chip-element').getAttribute('aria-pressed')).toBe('false')
  })

  it('shows "No class" and neither chip pressed when target is none', () => {
    render(<StyleTargetChip target="none" />)
    expect(screen.getByTestId('style-target-chip-class').textContent).toContain('No class')
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('false')
    expect(screen.getByTestId('style-target-chip-element').getAttribute('aria-pressed')).toBe('false')
  })

  it('marks the element chip pressed when target is element', () => {
    render(<StyleTargetChip target="element" onSelectElement={() => {}} />)
    expect(screen.getByTestId('style-target-chip-element').getAttribute('aria-pressed')).toBe('true')
  })

  it('the class chip carries the CSS write-back warning icon when no editability tier was resolved (the pre-panel-02 default)', () => {
    render(<StyleTargetChip target="class" classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).not.toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('the class chip carries the warning icon and a specific reason for an unmapped class', () => {
    render(<StyleTargetChip target="class" classSelector=".card" classCssEditability={{ kind: 'unmapped' }} />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).not.toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('the class chip carries the warning icon and the classifier reason for a compiled stylesheet', () => {
    render(
      <StyleTargetChip
        target="class"
        classSelector=".card"
        classCssEditability={{ kind: 'compiled', reason: 'This file lives in a build/output directory, not the project’s own source.' }}
      />,
    )
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).not.toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('panel-02 — the class chip drops the warning icon for a plain-css class that genuinely writes back', () => {
    render(
      <StyleTargetChip
        target="class"
        classSelector=".card"
        classCssEditability={{ kind: 'plain-css', file: 'src/screens/Home.css' }}
      />,
    )
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('true')
  })

  it('clicking Element calls onSelectElement when it is reachable', async () => {
    const user = userEvent.setup()
    const onSelectElement = mock(() => {})
    render(<StyleTargetChip target="none" onSelectElement={onSelectElement} />)
    await user.click(screen.getByTestId('style-target-chip-element'))
    expect(onSelectElement).toHaveBeenCalled()
  })

  it('the Element chip is disabled (unreachable) when onSelectElement is omitted — e.g. a class is already active', () => {
    render(<StyleTargetChip target="class" classSelector=".card" />)
    const elementChip = screen.getByTestId('style-target-chip-element') as HTMLButtonElement
    // Button converts disabled+tooltip to aria-disabled (see AlignBar's test note).
    expect(elementChip.getAttribute('aria-disabled')).toBe('true')
  })

  it('the class chip is not a focusable button — it has no click action today, so it must not be a dead tab stop', () => {
    render(<StyleTargetChip target="class" classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.tagName).toBe('SPAN')
  })
})
