/**
 * PositionSection — G10 (docs/features/inspector-disclosure.md).
 *
 * Covers:
 *   1. F29's constraint side-picker — switching Left/Right MOVES the value
 *      (clears the old property, writes the new one) rather than leaving
 *      both set — plus the crosshair diagram that sits beside it, which
 *      stays disabled-with-a-reason while no canvas frame can confirm the
 *      element's containing block.
 *   2. The z-index settings affordance — collapsed by default (Law 2),
 *      opens on demand.
 *
 * The align row (`resolveAlignWrite`/`SingleNodeAlignRow`) that used to be
 * covered here moved out with the row itself — see
 * `inspector/sections/__tests__/alignSection.test.tsx` (`STATE.md`
 * `panel-25`, P3 item 2).
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PositionSection } from '@site/panels/PropertiesPanel/PositionSection'

afterEach(cleanup)

const noop = () => {}

function renderPositionSection(overrides: Partial<React.ComponentProps<typeof PositionSection>> = {}) {
  return render(
    <PositionSection
      currentStyles={{}}
      storedStyles={{}}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      onClearProperty={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. Constraint side-picker (F29) — switching sides moves, not duplicates
// ---------------------------------------------------------------------------

describe('PositionSection — absolute-mode constraints', () => {
  it('shows the side pickers only in absolute/fixed position, not relative', () => {
    renderPositionSection({ currentStyles: { position: 'relative' }, storedStyles: { position: 'relative' } })
    expect(screen.queryByLabelText('X anchor side')).toBeNull()
    expect(screen.getByTestId('css-direction-input-left')).toBeTruthy()
  })

  it('switching the horizontal side moves a set value instead of duplicating it', () => {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    renderPositionSection({
      currentStyles: { position: 'absolute', left: '10px' },
      storedStyles: { position: 'absolute', left: '10px' },
      onChange: (...args) => calls.push({ fn: 'onChange', args }),
      onClearProperty: (...args) => calls.push({ fn: 'onClearProperty', args }),
    })

    const combobox = screen.getByRole('combobox', { name: 'X anchor side' })
    fireEvent.click(combobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'Right' }))

    // The value moved: `right` gets it, `left` is cleared. Never both set.
    expect(calls).toContainEqual({ fn: 'onChange', args: ['right', '10px'] })
    expect(calls).toContainEqual({ fn: 'onClearProperty', args: ['left'] })
    expect(calls.some((c) => c.fn === 'onChange' && c.args[0] === 'left')).toBe(false)
  })

  it('switching sides before any value is set writes nothing — it only changes where the NEXT value lands', () => {
    const calls: unknown[] = []
    renderPositionSection({
      currentStyles: { position: 'absolute' },
      storedStyles: { position: 'absolute' },
      onChange: (...args) => calls.push(args),
      onClearProperty: (...args) => calls.push(args),
    })

    const combobox = screen.getByRole('combobox', { name: 'X anchor side' })
    fireEvent.click(combobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'Right' }))

    expect(calls).toHaveLength(0)
  })

  it('mounts the crosshair beside the pickers, disabled with a reason when no frame can confirm the containing block', () => {
    renderPositionSection({
      currentStyles: { position: 'absolute' },
      storedStyles: { position: 'absolute' },
    })

    // Both surfaces are present — the diagram is presentation ON TOP of the
    // pickers, never a replacement for them.
    expect(screen.getByLabelText('X anchor side')).toBeTruthy()
    const diagram = screen.getByTestId('css-constraints-diagram')
    expect(diagram.getAttribute('data-disabled')).toBe('true')

    // No live canvas frame in this environment, so the parent's containing
    // block is unverifiable — every control refuses rather than assuming.
    for (const testId of [
      'constraint-edge-left',
      'constraint-edge-right',
      'constraint-edge-top',
      'constraint-edge-bottom',
      'constraint-centre-x',
      'constraint-centre-y',
    ]) {
      expect(screen.getByTestId(testId).getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('reads the declared insets back into the crosshair', () => {
    renderPositionSection({
      currentStyles: { position: 'absolute', left: '8px', right: '8px' },
      storedStyles: { position: 'absolute', left: '8px', right: '8px' },
    })

    expect(screen.getByLabelText(/Horizontal: Left and right/)).toBeTruthy()
    expect(screen.getByLabelText(/Vertical: not set/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Z-index settings affordance (Law 2)
// ---------------------------------------------------------------------------

describe('PositionSection — z-index settings affordance', () => {
  it('keeps the z-index row collapsed behind the settings trigger until opened', () => {
    renderPositionSection({ storedStyles: { zIndex: 5 }, currentStyles: { zIndex: 5 } })

    expect(screen.queryByTestId('css-property-row-zIndex')).toBeNull()
    expect(screen.getByText('z 5')).toBeTruthy()

    fireEvent.click(screen.getByTestId('position-settings-trigger'))

    expect(screen.getByTestId('css-property-row-zIndex')).toBeTruthy()
  })

  it('shows no badge when z-index is unset', () => {
    renderPositionSection()
    expect(screen.queryByText(/^z /)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Rotation — F1's third row (G10 follow-up)
// ---------------------------------------------------------------------------

describe('PositionSection — rotation field', () => {
  it('renders a resident rotation field with a 0deg placeholder when unset', () => {
    renderPositionSection()
    const field = screen.getByRole('textbox', { name: 'Rotation' })
    expect(field.getAttribute('placeholder')).toBe('0deg')
  })

  it('commits a typed rotation value on blur, writing the standalone `rotate` property', () => {
    let changed: [string, unknown] | null = null
    renderPositionSection({
      onChange: (p, v) => {
        changed = [String(p), v]
      },
    })

    const field = screen.getByRole('textbox', { name: 'Rotation' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '45deg' } })
    fireEvent.blur(field)

    expect(changed).toEqual(['rotate', '45deg'])
  })

  it('shows a clear button once rotation is set, and clears the `rotate` property', () => {
    let cleared: string | null = null
    renderPositionSection({
      storedStyles: { rotate: '45deg' },
      currentStyles: { rotate: '45deg' },
      onClearProperty: (p) => {
        cleared = String(p)
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear rotation' }))
    expect(cleared).toBe('rotate')
  })

  it('preserves a pre-existing `transform` function — writing a rotation never touches `transform`', () => {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    renderPositionSection({
      storedStyles: { transform: 'translateX(10px)' },
      currentStyles: { transform: 'translateX(10px)' },
      onChange: (...args) => calls.push({ fn: 'onChange', args }),
      onClearProperty: (...args) => calls.push({ fn: 'onClearProperty', args }),
    })

    const field = screen.getByRole('textbox', { name: 'Rotation' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '30deg' } })
    fireEvent.blur(field)

    expect(calls).toContainEqual({ fn: 'onChange', args: ['rotate', '30deg'] })
    // `translateX(10px)` was never touched — no call named `transform` at all.
    expect(calls.some((c) => c.args[0] === 'transform')).toBe(false)
  })
})

describe('PositionSection — rotation refuses when `transform` already has a rotate function', () => {
  it('falls back to the raw `transform` row instead of the rotate field, with a reason', () => {
    renderPositionSection({
      storedStyles: { transform: 'rotate(30deg) translateX(10px)' },
      currentStyles: { transform: 'rotate(30deg) translateX(10px)' },
    })

    expect(screen.queryByRole('textbox', { name: 'Rotation' })).toBeNull()
    expect(screen.getByTestId('css-property-row-transform')).toBeTruthy()
    expect(screen.getByText(/already set inside/i)).toBeTruthy()
  })

  it('recognizes every rotate-family transform function (rotateX/Y/Z, rotate3d)', () => {
    for (const fn of ['rotateX(10deg)', 'rotateY(10deg)', 'rotateZ(10deg)', 'rotate3d(1,0,0,10deg)']) {
      cleanup()
      renderPositionSection({ storedStyles: { transform: fn }, currentStyles: { transform: fn } })
      expect(screen.queryByRole('textbox', { name: 'Rotation' })).toBeNull()
    }
  })

  it('does NOT refuse for translate/scale/skew/matrix — only an actual rotate function', () => {
    renderPositionSection({
      storedStyles: { transform: 'translateX(10px) scale(1.2)' },
      currentStyles: { transform: 'translateX(10px) scale(1.2)' },
    })

    expect(screen.getByRole('textbox', { name: 'Rotation' })).toBeTruthy()
    expect(screen.queryByTestId('css-property-row-transform')).toBeNull()
  })
})
