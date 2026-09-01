import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { SegmentedControl } from '@ui/components/SegmentedControl'

afterEach(cleanup)

describe('SegmentedControl editor chrome variants', () => {
  it('exposes a recessed active surface for dark panel tab strips', () => {
    render(
      <SegmentedControl
        value="layers"
        options={[
          { value: 'layers', label: 'Layers' },
          { value: 'site', label: 'Site' },
        ]}
        onChange={() => {}}
        activeSurface="recessed"
        data-testid="segmented-control"
      />,
    )

    const group = screen.getByTestId('segmented-control')
    expect(group.getAttribute('data-active-surface')).toBe('recessed')
    expect(screen.getByRole('button', { name: 'Layers' }).getAttribute('aria-pressed')).toBe('true')
  })
})
