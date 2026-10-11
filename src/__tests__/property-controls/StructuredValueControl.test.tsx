/**
 * StructuredValueControl - the literals inside an inline list or object prop,
 * one row each. Pins what the Navbar of the built-in design system needs:
 * `segmentedControl={{ items, value }}` is a select of the item labels, a chip
 * `selected` is a switch, a key the component documents but the source lacks is
 * offered unset, and every write names its path.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import type { PropPathWrite } from '@site/property-controls/StructuredValueControl'

afterEach(cleanup)

function mount(value: unknown, writes: PropPathWrite[], example?: unknown, propKey = 'segmentedControl') {
  return render(
    <PropertyControlRenderer
      propKey={propKey}
      control={{ type: 'code', label: propKey, ...(example === undefined ? {} : { example }) }}
      value={value}
      onChange={() => undefined}
      onChangePath={(_key, write) => writes.push(write)}
    />,
  )
}

describe('StructuredValueControl', () => {
  it('draws a number next to its list as a select of the list entries, and writes the index at its path', () => {
    const writes: PropPathWrite[] = []
    mount({ items: ['Flights', 'Stays'], value: 0 }, writes)

    const row = screen.getByTestId('property-control-segmentedControl.value')
    const select = row.querySelector('select') ?? row.querySelector('[role="combobox"]')
    expect(select).not.toBeNull()
    expect(row.textContent).toContain('Flights')
  })

  it('writes a switch flip with its path and the value it replaced', () => {
    const writes: PropPathWrite[] = []
    mount([{ label: 'Dates', selected: false }], writes, undefined, 'chips')

    const row = screen.getByTestId('property-control-chips.0.selected')
    fireEvent.click(row.querySelector('[role="switch"]') ?? row.querySelector('input')!)
    expect(writes).toEqual([{ path: [0, 'selected'], value: true, previous: false }])
  })

  it('offers a documented key the source does not write yet, unset', () => {
    const writes: PropPathWrite[] = []
    mount([{ label: 'Dates' }], writes, [{ label: 'Dates', selected: false }], 'chips')

    const row = screen.getByTestId('property-control-chips.0.selected')
    fireEvent.click(row.querySelector('[role="switch"]') ?? row.querySelector('input')!)
    expect(writes).toEqual([{ path: [0, 'selected'], value: true, previous: undefined }])
  })

  it('is the read-only code row, with no nested rows, when nothing can be written', () => {
    render(
      <PropertyControlRenderer
        propKey="chips"
        control={{ type: 'code', label: 'chips' }}
        value={[{ label: 'Dates' }]}
        onChange={() => undefined}
      />,
    )
    expect(screen.getByTestId('code-value-chips').textContent).toContain('1 item')
    expect(screen.queryByTestId('property-control-chips.0.label')).toBeNull()
  })
})
