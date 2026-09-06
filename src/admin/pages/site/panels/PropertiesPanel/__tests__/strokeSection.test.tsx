/**
 * StrokeSection — the Stroke `PropertyList` (STUDIO-INSPECTOR-DISCLOSURE-PLAN
 * §4 G7, F16-F19), replacing the deleted `BorderControl`.
 *
 * Covers:
 *   1. Law 1 — nothing set renders exactly one line: no colour entry, only
 *      the resident position/weight/settings/sides controls.
 *   2. The colour entry appears once any border longhand is set.
 *   3. The sides menu's "All sides" item is a real write, fanning the
 *      current weight out to all four side-width longhands.
 *   4. The sides menu's "Custom" item reveals the four independent weight
 *      fields (F19) without writing anything on its own.
 *   5. The ⚙ settings popover reaches `borderStyle` (fanned to all sides),
 *      `outline`, and `outlineOffset`.
 *   6. Stroke position ships only the two CSS-honest values (`Inside` /
 *      `Outside`) — no `Center` option — and each writes a real `boxSizing`
 *      declaration.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { StrokeSection } from '../StrokeSection'

afterEach(cleanup)

function noop() {}

type Props = ComponentProps<typeof StrokeSection>

function renderStroke(overrides: Partial<Props> = {}) {
  return render(
    <StrokeSection
      activeTab="base"
      storedStyles={{}}
      currentStyles={{}}
      onChange={noop}
      onRemove={noop}
      onClearProperty={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1 + 2. Law 1 — empty renders one line
// ---------------------------------------------------------------------------

describe('StrokeSection — Law 1', () => {
  it('renders no colour entry and only the resident controls row when nothing is set', () => {
    renderStroke()

    expect(screen.queryByLabelText('Stroke color')).toBeNull()

    // The resident "one line": position, weight, settings, sides.
    expect(screen.getByTestId('stroke-position')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-all')).toBeTruthy()
    expect(screen.getByTestId('stroke-settings-trigger')).toBeTruthy()
    expect(screen.getByTestId('stroke-sides-trigger')).toBeTruthy()
  })

  it('shows the colour entry once any border longhand is set', () => {
    renderStroke({
      storedStyles: {
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: '#ff0000',
      },
    })

    expect(screen.getByLabelText('Stroke color')).toBeTruthy()
  })

  it('the colour entry\'s remove button clears every side\'s width/style/color', () => {
    const cleared: string[] = []
    renderStroke({
      storedStyles: {
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: '#ff0000',
      },
      onClearProperty: (p) => cleared.push(String(p)),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Stroke' }))

    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      for (const field of ['Width', 'Style', 'Color']) {
        expect(cleared).toContain(`border${side}${field}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3 + 4. Sides menu (F18) → Custom (F19)
// ---------------------------------------------------------------------------

describe('StrokeSection — sides menu', () => {
  it('"All sides" writes the current weight to all four side-width longhands', () => {
    const calls: Array<[string, unknown]> = []
    renderStroke({
      storedStyles: { borderTopWidth: '3px' },
      onChange: (p, v) => calls.push([String(p), v]),
    })

    fireEvent.click(screen.getByTestId('stroke-sides-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All sides' }))

    expect(calls).toContainEqual(['borderTopWidth', '3px'])
    expect(calls).toContainEqual(['borderRightWidth', '3px'])
    expect(calls).toContainEqual(['borderBottomWidth', '3px'])
    expect(calls).toContainEqual(['borderLeftWidth', '3px'])
  })

  it('"Custom" reveals four independent weight fields and writes nothing on its own', () => {
    const onChange = mock(() => {})
    renderStroke({ onChange })

    expect(screen.queryByTestId('stroke-weight-top')).toBeNull()

    fireEvent.click(screen.getByTestId('stroke-sides-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Custom' }))

    expect(screen.getByTestId('stroke-weight-top')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-right')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-bottom')).toBeTruthy()
    expect(screen.getByTestId('stroke-weight-left')).toBeTruthy()
    expect(screen.queryByTestId('stroke-weight-all')).toBeNull()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('editing one of the four Custom fields writes only that side', () => {
    const calls: Array<[string, unknown]> = []
    renderStroke({
      storedStyles: { borderTopWidth: '2px', borderRightWidth: '4px' },
      onChange: (p, v) => calls.push([String(p), v]),
    })

    // Sides already disagree, so the Custom view is showing without any menu
    // interaction — the honest default, matching ExpandableFieldCluster's
    // "never hide real divergence behind a collapsed field" behaviour.
    const bottomField = screen.getByLabelText('Stroke weight, bottom')
    fireEvent.change(bottomField, { target: { value: '6px' } })
    fireEvent.blur(bottomField)

    expect(calls).toEqual([['borderBottomWidth', '6px']])
  })
})

// ---------------------------------------------------------------------------
// 5. Settings popover (F17) — Style + Outline
// ---------------------------------------------------------------------------

describe('StrokeSection — settings popover', () => {
  it('reaches Style (fanned to all sides), outline and outlineOffset', () => {
    const calls: Array<[string, unknown]> = []
    renderStroke({ onChange: (p, v) => calls.push([String(p), v]) })

    fireEvent.click(screen.getByTestId('stroke-settings-trigger'))

    expect(screen.getByTestId('css-property-row-outline')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-outlineOffset')).toBeTruthy()

    fireEvent.click(screen.getByTestId('stroke-style'))
    fireEvent.click(screen.getByRole('option', { name: 'dashed' }))

    expect(calls).toContainEqual(['borderTopStyle', 'dashed'])
    expect(calls).toContainEqual(['borderRightStyle', 'dashed'])
    expect(calls).toContainEqual(['borderBottomStyle', 'dashed'])
    expect(calls).toContainEqual(['borderLeftStyle', 'dashed'])
  })
})

// ---------------------------------------------------------------------------
// 6. Stroke position — honest values only
// ---------------------------------------------------------------------------

describe('StrokeSection — position honesty', () => {
  it('ships only Inside and Outside — no Center, which has no CSS equivalent', () => {
    renderStroke()

    fireEvent.click(screen.getByTestId('stroke-position'))

    expect(screen.getByRole('option', { name: 'Inside' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Outside' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /center/i })).toBeNull()
  })

  it('"Inside" writes a real box-sizing: border-box declaration', () => {
    const calls: Array<[string, unknown]> = []
    renderStroke({ onChange: (p, v) => calls.push([String(p), v]) })

    fireEvent.click(screen.getByTestId('stroke-position'))
    fireEvent.click(screen.getByRole('option', { name: 'Inside' }))

    expect(calls).toEqual([['boxSizing', 'border-box']])
  })

  it('"Outside" writes a real box-sizing: content-box declaration', () => {
    const calls: Array<[string, unknown]> = []
    renderStroke({ onChange: (p, v) => calls.push([String(p), v]) })

    fireEvent.click(screen.getByTestId('stroke-position'))
    fireEvent.click(screen.getByRole('option', { name: 'Outside' }))

    expect(calls).toEqual([['boxSizing', 'content-box']])
  })
})
