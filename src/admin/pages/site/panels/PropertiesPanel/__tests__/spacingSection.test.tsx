/**
 * SpacingSection — G4 (docs/features/inspector-disclosure.md).
 *
 * Covers:
 *   1. The margin cluster is independent of the Layout section's padding
 *      cluster — same `ExpandableFieldCluster` shape, distinct `id`, distinct
 *      stored properties, and distinct sticky expand/collapse state.
 *   2. Collapsed shows 2 fields, expanded shows 4, and expanding never calls
 *      `onChange` on its own.
 *   3. `SpacingBoxControl` survives, reachable via the "Box model" ⚙, and
 *      still edits all 8 properties (padding AND margin) from inside the
 *      popover.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { SpacingSection } from '../SpacingBoxControl/SpacingSection'
import { PaddingCluster } from '../LayoutSection/PaddingCluster'

afterEach(cleanup)

function noop() {}

type SpacingProps = ComponentProps<typeof SpacingSection>

function renderSpacing(overrides: Partial<SpacingProps> = {}) {
  return render(
    <SpacingSection storedStyles={{}} currentStyles={{}} onChange={noop} onRemove={noop} {...overrides} />,
  )
}

function setMarginExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-margin-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

// ---------------------------------------------------------------------------
// 1 + 2. Margin cluster shape
// ---------------------------------------------------------------------------

describe('SpacingSection — margin cluster', () => {
  it('collapsed shows 2 fields', () => {
    renderSpacing({ storedStyles: { marginTop: '8px', marginBottom: '8px' } })
    setMarginExpanded(false)

    const fields = screen.getByTestId('expandable-field-cluster-margin-fields')
    expect(within(fields).getAllByRole('textbox').length).toBe(2)
  })

  it('expanded shows 4 fields, and toggling never calls onChange', () => {
    const onChange = mock(() => {})
    renderSpacing({
      storedStyles: {
        marginLeft: '4px',
        marginTop: '8px',
        marginRight: '4px',
        marginBottom: '8px',
      },
      onChange,
    })

    setMarginExpanded(true)
    const fields = screen.getByTestId('expandable-field-cluster-margin-fields')
    expect(within(fields).getAllByRole('textbox').length).toBe(4)

    setMarginExpanded(false)
    setMarginExpanded(true)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('editing the collapsed horizontal field writes both marginLeft and marginRight', () => {
    const calls: Array<[string, unknown]> = []
    renderSpacing({ onChange: (p, v) => calls.push([String(p), v]) })
    setMarginExpanded(false)

    const horizontal = screen.getByTestId('css-margin-horizontal') as HTMLInputElement
    fireEvent.change(horizontal, { target: { value: '16px' } })
    fireEvent.blur(horizontal)

    expect(calls).toContainEqual(['marginLeft', '16px'])
    expect(calls).toContainEqual(['marginRight', '16px'])
  })

  it("margin's cluster state is independent of the Layout padding cluster's", () => {
    // Distinct sticky-state ids ('margin' vs 'padding') — expanding one must
    // never expand or collapse the other. `ExpandableFieldCluster`'s expand
    // state is a module-level Map keyed by id (deliberately sticky across
    // remounts — see that component's doc), so this test pins BOTH clusters'
    // starting state explicitly rather than assuming a fresh default; a
    // sibling test file may have already toggled 'padding' in this same
    // process.
    render(
      <div>
        <PaddingCluster storedStyles={{}} currentStyles={{}} tokens={[]} onChange={noop} />
        <SpacingSection storedStyles={{}} currentStyles={{}} onChange={noop} onRemove={noop} />
      </div>,
    )

    const paddingToggle = screen.getByTestId('expandable-field-cluster-padding-toggle')
    if (paddingToggle.getAttribute('aria-expanded') === 'true') fireEvent.click(paddingToggle)

    setMarginExpanded(true)

    expect(paddingToggle.getAttribute('aria-expanded')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// 3. SpacingBoxControl survives behind the "Box model" ⚙
// ---------------------------------------------------------------------------

describe('SpacingSection — Box model popover', () => {
  it('is reachable via the settings trigger and edits all 8 sides', () => {
    const calls: Array<[string, unknown]> = []
    renderSpacing({
      storedStyles: { paddingTop: '4px', marginTop: '8px' },
      currentStyles: { paddingTop: '4px', marginTop: '8px' },
      onChange: (p, v) => calls.push([String(p), v]),
    })

    expect(screen.queryByLabelText('padding top')).toBeNull()

    fireEvent.click(screen.getByTestId('spacing-box-model-trigger'))

    const paddingTopInput = screen.getByLabelText('padding top') as HTMLInputElement
    expect(paddingTopInput.value).toBe('4px')
    fireEvent.change(paddingTopInput, { target: { value: '10px' } })
    fireEvent.blur(paddingTopInput)
    expect(calls).toContainEqual(['paddingTop', '10px'])

    const marginTopInput = screen.getByLabelText('margin top') as HTMLInputElement
    expect(marginTopInput.value).toBe('8px')
  })
})
