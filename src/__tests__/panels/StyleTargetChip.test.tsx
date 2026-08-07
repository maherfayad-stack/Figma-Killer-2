import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StyleTargetChip } from '@site/panels/PropertiesPanel/StyleTargetChip'

describe('StyleTargetChip', () => {
  it('shows the class selector and a warning icon when write-back tier is unknown (the pre-panel-02 default)', () => {
    render(<StyleTargetChip elementVisible={false} classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.textContent).toContain('.card')
    expect(classChip.getAttribute('data-active')).toBe('true')
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('shows "No class" when no class is assigned', () => {
    render(<StyleTargetChip elementVisible={false} />)
    expect(screen.getByTestId('style-target-chip-class').textContent).toContain('No class')
    expect(screen.getByTestId('style-target-chip-class').getAttribute('data-active')).toBe('false')
  })

  it('marks the Element chip pressed when the inline block is visible', () => {
    render(<StyleTargetChip elementVisible onToggleElement={() => {}} />)
    expect(screen.getByTestId('style-target-chip-element').getAttribute('aria-pressed')).toBe('true')
  })

  it('the class chip carries the CSS write-back warning icon when no editability tier was resolved', () => {
    render(<StyleTargetChip elementVisible={false} classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).not.toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('the class chip carries the warning icon and a specific reason for an unmapped class', () => {
    render(<StyleTargetChip elementVisible={false} classSelector=".card" classCssEditability={{ kind: 'unmapped' }} />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).not.toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('false')
  })

  it('the class chip carries the warning icon and the classifier reason for a compiled stylesheet', () => {
    render(
      <StyleTargetChip
        elementVisible={false}
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
        elementVisible={false}
        classSelector=".card"
        classCssEditability={{ kind: 'plain-css', file: 'src/screens/Home.css' }}
      />,
    )
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('true')
  })

  it('Track F1 — a class with no source yet but a resolvable insert destination reads as writable, not warned', () => {
    render(
      <StyleTargetChip
        elementVisible={false}
        classSelector=".card"
        classCssEditability={{ kind: 'will-create-existing', file: 'src/screens/Home.css' }}
      />,
    )
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('true')
  })

  it('Track F1 — a class that would create a brand-new stylesheet also reads as writable', () => {
    render(
      <StyleTargetChip
        elementVisible={false}
        classSelector=".card"
        classCssEditability={{ kind: 'will-create-new-stylesheet', pageFile: 'src/screens/Home.tsx' }}
      />,
    )
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.querySelector('svg')).toBeNull()
    expect(classChip.getAttribute('data-writable')).toBe('true')
  })

  it('clicking Element calls onToggleElement when it is reachable', async () => {
    const user = userEvent.setup()
    const onToggleElement = mock(() => {})
    render(<StyleTargetChip elementVisible={false} onToggleElement={onToggleElement} />)
    await user.click(screen.getByTestId('style-target-chip-element'))
    expect(onToggleElement).toHaveBeenCalled()
  })

  it('Track F1 / S6 — the Element chip stays reachable even when a class is also assigned (no more exclusivity)', () => {
    const onToggleElement = mock(() => {})
    render(<StyleTargetChip elementVisible={false} classSelector=".card" onToggleElement={onToggleElement} />)
    const elementChip = screen.getByTestId('style-target-chip-element') as HTMLButtonElement
    expect(elementChip.getAttribute('aria-disabled')).toBeNull()
  })

  it('the Element chip is disabled (unreachable) when the caller omits onToggleElement — e.g. a module owns its own style=""', () => {
    render(<StyleTargetChip elementVisible={false} elementDisabledReason="This component writes its own style." />)
    const elementChip = screen.getByTestId('style-target-chip-element') as HTMLButtonElement
    // Button converts disabled+tooltip to aria-disabled (see AlignBar's test note).
    expect(elementChip.getAttribute('aria-disabled')).toBe('true')
  })

  it('the class chip is not a focusable button — it has no click action today, so it must not be a dead tab stop', () => {
    render(<StyleTargetChip elementVisible={false} classSelector=".card" />)
    const classChip = screen.getByTestId('style-target-chip-class')
    expect(classChip.tagName).toBe('SPAN')
  })

  it('Track B2 — always shows an informational "Assign class" entry pointing at the class picker', () => {
    render(<StyleTargetChip elementVisible={false} />)
    const assignChip = screen.getByTestId('style-target-chip-assign')
    expect(assignChip.tagName).toBe('SPAN')
    expect(assignChip.textContent).toContain('Assign class')
  })
})
