/**
 * AddablePropertyField — the "Add min width…" primitive (STUDIO-INSPECTOR-
 * DISCLOSURE-PLAN.md §3.4). Covers: the three menu groups + checkmark/quoted
 * active mode; that "Add …" reveals without writing; the reveal/remove pair
 * a `RevealedField` provides; mode-word display + typing back to numeric;
 * and focus returning to the chevron on close.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddablePropertyField, RevealedField, type AddablePropertyFieldMode } from './AddablePropertyField'

afterEach(() => {
  cleanup()
})

const SIZING_MODES: AddablePropertyFieldMode[] = [
  {
    value: 'fixed',
    label: 'Fixed width',
    activeLabel: (value) => `Fixed width (${String(value)})`,
  },
  { value: 'hug', label: 'Hug contents', word: 'Hug' },
]

function openMenu(chevronTestId: string) {
  fireEvent.click(screen.getByTestId(chevronTestId))
}

describe('AddablePropertyField — menu groups', () => {
  it('renders the modes, additions, and actions groups, checking the active mode with its value quoted', async () => {
    const onModeChange = mock(() => {})
    const onAdd = mock(() => {})
    const onSelectAction = mock(() => {})

    render(
      <AddablePropertyField
        name="Width"
        label="W"
        aria-label="Width"
        value="54px"
        onChange={() => {}}
        modes={SIZING_MODES}
        mode="fixed"
        onModeChange={onModeChange}
        numericMode="fixed"
        additions={[{ key: 'minWidth', label: 'Add minimum width…' }]}
        onAdd={onAdd}
        actions={[{ key: 'apply-variable', label: 'Apply variable…', onSelect: onSelectAction }]}
        data-testid="w"
      />,
    )

    openMenu('w-chevron')

    await waitFor(() => {
      expect(screen.getByRole('menu', { name: 'Width options' })).toBeDefined()
    })

    const activeItem = screen.getByRole('menuitemradio', { name: 'Fixed width (54px)' })
    expect(activeItem.getAttribute('aria-checked')).toBe('true')

    const inactiveItem = screen.getByRole('menuitemradio', { name: 'Hug contents' })
    expect(inactiveItem.getAttribute('aria-checked')).toBe('false')

    expect(screen.getByRole('menuitem', { name: 'Add minimum width…' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Apply variable…' })).toBeDefined()

    fireEvent.click(inactiveItem)
    expect(onModeChange).toHaveBeenCalledWith('hug')
  })

  it('calls onAdd and writes nothing to the value when an addition is chosen', async () => {
    const onChange = mock(() => {})
    const onAdd = mock(() => {})

    render(
      <AddablePropertyField
        name="Width"
        label="W"
        aria-label="Width"
        value="54px"
        onChange={onChange}
        additions={[{ key: 'minWidth', label: 'Add minimum width…' }]}
        onAdd={onAdd}
        data-testid="w"
      />,
    )

    openMenu('w-chevron')

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Add minimum width…' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add minimum width…' }))

    expect(onAdd).toHaveBeenCalledWith('minWidth')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('returns focus to the chevron when the menu closes', async () => {
    render(
      <AddablePropertyField
        name="Width"
        label="W"
        aria-label="Width"
        value="54px"
        onChange={() => {}}
        modes={SIZING_MODES}
        mode="fixed"
        onModeChange={() => {}}
        numericMode="fixed"
        data-testid="w"
      />,
    )

    openMenu('w-chevron')

    await waitFor(() => {
      expect(screen.getByRole('menu', { name: 'Width options' })).toBeDefined()
    })

    fireEvent.keyDown(screen.getByRole('menu', { name: 'Width options' }), { key: 'Escape' })

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('w-chevron'))
    })
  })
})

describe('AddablePropertyField — mode-word display', () => {
  it('shows the mode word instead of a number, and typing a number switches back to the numeric mode', () => {
    const onChange = mock(() => {})
    const onModeChange = mock(() => {})

    render(
      <AddablePropertyField
        name="Height"
        label="H"
        aria-label="Height"
        value={undefined}
        onChange={onChange}
        modes={SIZING_MODES}
        mode="hug"
        onModeChange={onModeChange}
        numericMode="fixed"
        data-testid="h"
      />,
    )

    const input = screen.getByTestId('h-scrub-field') as HTMLInputElement
    expect(input.value).toBe('Hug')
    // The accessible name stays the spelled-out identity, not the displayed word.
    expect(input.getAttribute('aria-label')).toBe('Height')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '300px' } })
    fireEvent.blur(input)

    expect(onModeChange).toHaveBeenCalledWith('fixed')
    expect(onChange).toHaveBeenCalledWith('300px')
  })

  it('does not switch modes when the committed value is still the mode word', () => {
    const onChange = mock(() => {})
    const onModeChange = mock(() => {})

    render(
      <AddablePropertyField
        name="Height"
        label="H"
        aria-label="Height"
        value={undefined}
        onChange={onChange}
        modes={SIZING_MODES}
        mode="hug"
        onModeChange={onModeChange}
        numericMode="fixed"
        data-testid="h"
      />,
    )

    const input = screen.getByTestId('h-scrub-field') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.blur(input)

    expect(onModeChange).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * A minimal stand-in for what G2 wires up: the caller owns whether the
 * companion property is revealed, `onAdd` only flips that local flag (never
 * writes CSS), and `RevealedField`'s `onRemove` clears the value AND
 * re-hides the row in one prop — the pairing this primitive exists to keep
 * from drifting.
 */
function SizeFieldHarness({ onCommit }: { onCommit: (value: string | undefined) => void }) {
  const [minWidthRevealed, setMinWidthRevealed] = useState(false)
  const [minWidth, setMinWidth] = useState<string | undefined>(undefined)

  return (
    <div>
      <AddablePropertyField
        name="Width"
        label="W"
        aria-label="Width"
        value="54px"
        onChange={() => {}}
        additions={minWidthRevealed ? [] : [{ key: 'minWidth', label: 'Add minimum width…' }]}
        onAdd={(key) => {
          if (key === 'minWidth') setMinWidthRevealed(true)
        }}
        data-testid="w"
      />
      {minWidthRevealed && (
        <RevealedField
          label="Min W"
          ariaLabel="Minimum width"
          value={minWidth}
          placeholder="0px"
          onChange={(next) => {
            setMinWidth(next)
            onCommit(next)
          }}
          onRemove={() => {
            setMinWidth(undefined)
            setMinWidthRevealed(false)
            onCommit(undefined)
          }}
          data-testid="min-width"
        />
      )}
    </div>
  )
}

describe('RevealedField — reveal / remove pairing', () => {
  it('reveals an unset row on Add, and the − both clears and re-hides it, restoring the menu item', async () => {
    const onCommit = mock((_value: string | undefined) => {})
    render(<SizeFieldHarness onCommit={onCommit} />)

    openMenu('w-chevron')
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Add minimum width…' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add minimum width…' }))

    // Revealed, unset (placeholder only — nothing was written).
    const revealedInput = screen.getByTestId('min-width-scrub-field') as HTMLInputElement
    expect(revealedInput.value).toBe('')
    expect(revealedInput.placeholder).toBe('0px')
    expect(onCommit).not.toHaveBeenCalled()

    // Commit a real value into the revealed row.
    fireEvent.focus(revealedInput)
    fireEvent.change(revealedInput, { target: { value: '10px' } })
    fireEvent.blur(revealedInput)
    expect(onCommit).toHaveBeenLastCalledWith('10px')

    // "−" clears the value AND re-hides the row.
    fireEvent.click(screen.getByTestId('min-width-remove'))
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryByTestId('min-width-scrub-field')).toBeNull()

    // The "Add …" item is back in the menu.
    openMenu('w-chevron')
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Add minimum width…' })).toBeDefined()
    })
  })
})
