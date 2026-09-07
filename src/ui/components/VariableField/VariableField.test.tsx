/**
 * The "Apply variable" affordance, exercised through `ScrubInput` — the
 * field primitive that carries both halves (leading chip, trailing button).
 *
 * ── What this can and cannot assert ─────────────────────────────────────
 * The hover REVEAL itself is pure CSS (`opacity: 0` until
 * `[data-variable-host]:hover`), and CSS Modules resolve to `""` under
 * `bun test` on happy-dom, which lays nothing out. So what is asserted here
 * is the part that can be wrong in JS: that the button EXISTS and is
 * labelled once a catalog is available, that it is absent when there is
 * nothing to offer, that picking a row writes `var(--x)` through the field's
 * own `onChange`, and that a bound field shows a chip instead of its value.
 * The reveal rule itself is a one-line static fact in the CSS module.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ScrubInput } from '@ui/components/ScrubInput'
import { VariableSourceContext } from './VariableSourceContext'
import type { VariableOption } from './variableKind'

afterEach(cleanup)

const CATALOG: VariableOption[] = [
  { name: '--space-4', resolvedValue: '16px', kind: 'length', source: 'project' },
  { name: '--space-8', resolvedValue: '32px', kind: 'length', source: 'project' },
  { name: '--color-primary', resolvedValue: '#ef4550', kind: 'color', source: 'project' },
]

function withCatalog(children: ReactNode, catalog: readonly VariableOption[] = CATALOG) {
  return <VariableSourceContext.Provider value={catalog}>{children}</VariableSourceContext.Provider>
}

function renderWidth(props: { value?: string; onChange?: (next: string) => void } = {}) {
  const onChange = props.onChange ?? mock(() => {})
  render(
    withCatalog(
      <ScrubInput
        value={props.value ?? '12px'}
        onChange={onChange}
        label="W"
        aria-label="Width"
        data-testid="width"
      />,
    ),
  )
  return { onChange }
}

describe('the trailing "Apply variable" button', () => {
  it('is rendered, labelled, and focusable once a catalog is available', () => {
    renderWidth()
    const trigger = screen.getByRole('button', { name: 'Apply variable to Width' })
    expect(trigger).toBeTruthy()
    // Present in the DOM (so hover/focus can reveal it) rather than mounted
    // on hover — a button that only exists while hovered is not reachable by
    // keyboard, and `:focus-visible` is half of the reveal rule.
    expect(trigger.closest('[data-variable-host]')).toBeTruthy()
  })

  it('is NOT rendered when the project declares no compatible variable', () => {
    // A colour-only catalog has nothing a width field can take. An icon that
    // opens an empty list is exactly the control-that-lies this panel refuses.
    render(
      withCatalog(
        <ScrubInput value="12px" onChange={() => {}} label="W" aria-label="Width" />,
        [CATALOG[2]],
      ),
    )
    expect(screen.queryByRole('button', { name: /variable/i })).toBeNull()
  })

  it('is NOT rendered outside a provider — a bare field stays a bare field', () => {
    render(<ScrubInput value="12px" onChange={() => {}} label="W" aria-label="Width" />)
    expect(screen.queryByRole('button', { name: /variable/i })).toBeNull()
  })

  it('offers only the kinds the field accepts', () => {
    renderWidth()
    fireEvent.click(screen.getByRole('button', { name: 'Apply variable to Width' }))
    expect(screen.getByRole('button', { name: /space-4/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /color-primary/ })).toBeNull()
  })

  it('picking a variable writes `var(--x)` through the field\'s own onChange', () => {
    const { onChange } = renderWidth()
    fireEvent.click(screen.getByRole('button', { name: 'Apply variable to Width' }))
    fireEvent.click(screen.getByRole('button', { name: /space-8/ }))
    expect(onChange).toHaveBeenCalledWith('var(--space-8)')
  })

  it('filters the list by search', () => {
    renderWidth()
    fireEvent.click(screen.getByRole('button', { name: 'Apply variable to Width' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search variables' }), {
      target: { value: 'space-8' },
    })
    expect(screen.queryByRole('button', { name: /space-4/ })).toBeNull()
    expect(screen.getByRole('button', { name: /space-8/ })).toBeTruthy()
  })
})

describe('a bound field', () => {
  it('shows the variable NAME as a chip and empties the input', () => {
    renderWidth({ value: 'var(--space-4)' })
    const chip = screen.getByTestId('variable-chip')
    expect(chip.textContent).toContain('space-4')
    // Name only — the resolved value is the tooltip, not chip text (Figma).
    expect(chip.textContent).not.toContain('16px')
    expect(chip.getAttribute('title')).toBe('16px')
    expect(screen.getByTestId('width-field').getAttribute('value')).toBe('')
  })

  it('relabels the trigger as "Change variable"', () => {
    renderWidth({ value: 'var(--space-4)' })
    expect(screen.getByRole('button', { name: 'Change variable for Width' })).toBeTruthy()
  })

  it('detach writes the RESOLVED LITERAL back, not an empty value', () => {
    const { onChange } = renderWidth({ value: 'var(--space-4)' })
    fireEvent.click(screen.getByRole('button', { name: 'Detach variable space-4' }))
    expect(onChange).toHaveBeenCalledWith('16px')
  })

  it('typing a literal replaces the binding', () => {
    const { onChange } = renderWidth({ value: 'var(--space-4)' })
    const field = screen.getByTestId('width-field')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '24' } })
    fireEvent.blur(field, { target: { value: '24' } })
    expect(onChange).toHaveBeenCalledWith('24px')
  })

  it('blurring a bound field without typing keeps the binding', () => {
    // The regression this guards: the input is empty while bound, so a naive
    // blur-commits-the-textbox path would write "" and silently detach.
    const { onChange } = renderWidth({ value: 'var(--space-4)' })
    const field = screen.getByTestId('width-field')
    fireEvent.focus(field)
    fireEvent.blur(field, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows no chip for a multi-selection whose values disagree', async () => {
    const { MIXED } = await import('@ui/components/MixedValue')
    render(
      withCatalog(
        <ScrubInput value={MIXED} onChange={() => {}} label="W" aria-label="Width" />,
      ),
    )
    expect(screen.queryByTestId('variable-chip')).toBeNull()
    // The picker is still offered — applying one writes to the whole
    // selection through the caller's own multi-node onChange.
    expect(screen.getByRole('button', { name: 'Apply variable to Width' })).toBeTruthy()
  })
})
