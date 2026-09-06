import { describe, expect, it, mock } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MIXED } from '@ui/components/MixedValue'
import { AlignGrid } from './AlignGrid'
import {
  resolveAlignGridCellState,
  resolveAlignGridCellValues,
  type AlignGridPropertyValue,
  type AlignGridValues,
} from './alignGridCells'

const START = 'flex-start'
const CENTER = 'center'
const END = 'flex-end'

const unset: AlignGridPropertyValue = { value: undefined, isSet: false }

function set(value: string): AlignGridPropertyValue {
  return { value, isSet: true }
}

// ---------------------------------------------------------------------------
// resolveAlignGridCellValues — exhaustive: every flexDirection × every cell.
// Tables derived by hand from CSS Flexbox semantics (main axis flips with
// `*-reverse`, cross axis never does) — see AlignGrid.tsx's module doc for
// the derivation this mirrors.
// ---------------------------------------------------------------------------

type CellTable = ReadonlyArray<readonly [row: number, col: number, expected: AlignGridValues]>

const ROW_TABLE: CellTable = [
  [0, 0, { align: START, justify: START }],
  [0, 1, { align: START, justify: CENTER }],
  [0, 2, { align: START, justify: END }],
  [1, 0, { align: CENTER, justify: START }],
  [1, 1, { align: CENTER, justify: CENTER }],
  [1, 2, { align: CENTER, justify: END }],
  [2, 0, { align: END, justify: START }],
  [2, 1, { align: END, justify: CENTER }],
  [2, 2, { align: END, justify: END }],
]

const ROW_REVERSE_TABLE: CellTable = [
  [0, 0, { align: START, justify: END }],
  [0, 1, { align: START, justify: CENTER }],
  [0, 2, { align: START, justify: START }],
  [1, 0, { align: CENTER, justify: END }],
  [1, 1, { align: CENTER, justify: CENTER }],
  [1, 2, { align: CENTER, justify: START }],
  [2, 0, { align: END, justify: END }],
  [2, 1, { align: END, justify: CENTER }],
  [2, 2, { align: END, justify: START }],
]

const COLUMN_TABLE: CellTable = [
  [0, 0, { align: START, justify: START }],
  [0, 1, { align: CENTER, justify: START }],
  [0, 2, { align: END, justify: START }],
  [1, 0, { align: START, justify: CENTER }],
  [1, 1, { align: CENTER, justify: CENTER }],
  [1, 2, { align: END, justify: CENTER }],
  [2, 0, { align: START, justify: END }],
  [2, 1, { align: CENTER, justify: END }],
  [2, 2, { align: END, justify: END }],
]

const COLUMN_REVERSE_TABLE: CellTable = [
  [0, 0, { align: START, justify: END }],
  [0, 1, { align: CENTER, justify: END }],
  [0, 2, { align: END, justify: END }],
  [1, 0, { align: START, justify: CENTER }],
  [1, 1, { align: CENTER, justify: CENTER }],
  [1, 2, { align: END, justify: CENTER }],
  [2, 0, { align: START, justify: START }],
  [2, 1, { align: CENTER, justify: START }],
  [2, 2, { align: END, justify: START }],
]

describe('resolveAlignGridCellValues — flex mode, exhaustive', () => {
  it.each(ROW_TABLE)('row: cell(%i,%i) -> %o', (row, col, expected) => {
    expect(resolveAlignGridCellValues(row, col, 'flex', 'row')).toEqual(expected)
  })

  it.each(ROW_REVERSE_TABLE)('row-reverse: cell(%i,%i) -> %o', (row, col, expected) => {
    expect(resolveAlignGridCellValues(row, col, 'flex', 'row-reverse')).toEqual(expected)
  })

  it.each(COLUMN_TABLE)('column: cell(%i,%i) -> %o', (row, col, expected) => {
    expect(resolveAlignGridCellValues(row, col, 'flex', 'column')).toEqual(expected)
  })

  it.each(COLUMN_REVERSE_TABLE)('column-reverse: cell(%i,%i) -> %o', (row, col, expected) => {
    expect(resolveAlignGridCellValues(row, col, 'flex', 'column-reverse')).toEqual(expected)
  })
})

describe('resolveAlignGridCellValues — grid mode', () => {
  it.each(ROW_TABLE)('grid mode matches the row table: cell(%i,%i) -> %o', (row, col, expected) => {
    expect(resolveAlignGridCellValues(row, col, 'grid', 'row')).toEqual(expected)
  })

  it('grid mode ignores flexDirection entirely — reverse variants produce the same table', () => {
    for (const [row, col, expected] of ROW_TABLE) {
      expect(resolveAlignGridCellValues(row, col, 'grid', 'row-reverse')).toEqual(expected)
      expect(resolveAlignGridCellValues(row, col, 'grid', 'column')).toEqual(expected)
      expect(resolveAlignGridCellValues(row, col, 'grid', 'column-reverse')).toEqual(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// resolveAlignGridCellState — active / partial / inactive
// ---------------------------------------------------------------------------

describe('resolveAlignGridCellState', () => {
  it('marks exactly one cell active when both properties are set and agree', () => {
    const align = set(CENTER)
    const justify = set(CENTER)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const state = resolveAlignGridCellState(row, col, 'flex', 'row', align, justify)
        if (row === 1 && col === 1) {
          expect(state).toBe('active')
        } else {
          expect(state).toBe('inactive')
        }
      }
    }
  })

  it('highlights the whole row when only align (cross axis) is set, in row-family mode', () => {
    const align = set(START) // row family: align -> row index 0
    const justify = unset
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const state = resolveAlignGridCellState(row, col, 'flex', 'row', align, justify)
        expect(state).toBe(row === 0 ? 'align-only' : 'inactive')
      }
    }
  })

  it('highlights the whole column when only justify (main axis) is set, in row-family mode', () => {
    const align = unset
    const justify = set(END) // row family: justify -> col index 2
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const state = resolveAlignGridCellState(row, col, 'flex', 'row', align, justify)
        expect(state).toBe(col === 2 ? 'justify-only' : 'inactive')
      }
    }
  })

  it('never lights any cell when neither property is set', () => {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(resolveAlignGridCellState(row, col, 'flex', 'row', unset, unset)).toBe('inactive')
      }
    }
  })

  it('does not invent a cell for a value the pad cannot represent (e.g. stretch)', () => {
    const align = set('stretch')
    const justify = set(CENTER)
    // align is unmappable -> treated as unset; justify=center -> col 1 highlighted.
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(resolveAlignGridCellState(row, col, 'flex', 'row', align, justify)).toBe(
          col === 1 ? 'justify-only' : 'inactive',
        )
      }
    }
  })

  it('treats a MIXED multi-selection value the same as unset — nothing invented', () => {
    const align: AlignGridPropertyValue = { value: MIXED, isSet: true }
    const justify = unset
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(resolveAlignGridCellState(row, col, 'flex', 'row', align, justify)).toBe('inactive')
      }
    }
  })

  it('flips which column is highlighted for justify under row-reverse', () => {
    const align = unset
    const justify = set(START) // row-reverse: flex-start is screen-right -> col 2
    for (let col = 0; col < 3; col++) {
      const state = resolveAlignGridCellState(0, col, 'flex', 'row-reverse', align, justify)
      expect(state).toBe(col === 2 ? 'justify-only' : 'inactive')
    }
  })
})

// ---------------------------------------------------------------------------
// Component — partial-state rendering
// ---------------------------------------------------------------------------

describe('<AlignGrid /> partial-state rendering', () => {
  it('renders no cell as selected when nothing is set', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
        data-testid="ag"
      />,
    )
    for (const cell of screen.getAllByRole('gridcell')) {
      expect(cell.getAttribute('aria-selected')).toBe('false')
      expect(cell.getAttribute('data-cell-state')).toBe('inactive')
    }
  })

  it('highlights only the matching row when align alone is set, and marks no cell fully active', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={set(START)}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
        data-testid="ag"
      />,
    )
    for (let col = 0; col < 3; col++) {
      expect(screen.getByTestId(`ag-cell-0-${col}`).getAttribute('data-cell-state')).toBe('align-only')
    }
    for (let row = 1; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(screen.getByTestId(`ag-cell-${row}-${col}`).getAttribute('data-cell-state')).toBe('inactive')
      }
    }
    // The whole row reads as "selected" for a11y parity with the visual
    // highlight, but none of the three is the single, fully-active cell.
    const selected = screen.getAllByRole('gridcell', { selected: true })
    expect(selected).toHaveLength(3)
    expect(selected.every((cell) => cell.getAttribute('data-cell-state') === 'align-only')).toBe(true)
  })

  it('exposes both writes in the accessible name regardless of current value', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )
    expect(screen.getByRole('gridcell', { name: 'Align top, justify center' })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: 'Align bottom, justify left' })).toBeTruthy()
  })

  it('names cells with left/right words in column-family mode', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="column"
        align={unset}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )
    expect(screen.getByRole('gridcell', { name: 'Align left, justify top' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Component — commit / clear
// ---------------------------------------------------------------------------

describe('<AlignGrid /> commit and clear', () => {
  it('clicking a non-active cell commits both properties for that cell', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    const onClear = mock(() => {})
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={set(CENTER)}
        justify={set(CENTER)}
        onChange={onChange}
        onClear={onClear}
        data-testid="ag"
      />,
    )

    await user.click(screen.getByTestId('ag-cell-0-0'))

    expect(onChange).toHaveBeenCalledWith({ align: START, justify: START })
    expect(onClear).not.toHaveBeenCalled()
  })

  it('clicking the exact active cell clears both properties instead of re-committing', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    const onClear = mock(() => {})
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={set(CENTER)}
        justify={set(CENTER)}
        onChange={onChange}
        onClear={onClear}
        data-testid="ag"
      />,
    )

    await user.click(screen.getByTestId('ag-cell-1-1'))

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Component — keyboard model
// ---------------------------------------------------------------------------

describe('<AlignGrid /> keyboard navigation', () => {
  it('seeds the roving tabIndex on the center cell when nothing is active', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
        data-testid="ag"
      />,
    )
    expect(screen.getByTestId('ag-cell-1-1').getAttribute('tabindex')).toBe('0')
    expect(screen.getByTestId('ag-cell-0-0').getAttribute('tabindex')).toBe('-1')
  })

  it('seeds the roving tabIndex on the active cell when one exists', () => {
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={set(START)}
        justify={set(END)}
        onChange={() => {}}
        onClear={() => {}}
        data-testid="ag"
      />,
    )
    // row family: align=start -> row 0, justify=end -> col 2
    expect(screen.getByTestId('ag-cell-0-2').getAttribute('tabindex')).toBe('0')
  })

  it('arrow keys move focus between cells and Enter commits the focused cell', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={onChange}
        onClear={() => {}}
        data-testid="ag"
      />,
    )

    act(() => {
      screen.getByTestId('ag-cell-1-1').focus()
    })
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByTestId('ag-cell-0-1'))

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ align: START, justify: CENTER })
  })

  it('clamps arrow navigation at the grid edge instead of moving out of bounds', async () => {
    const user = userEvent.setup()
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={() => {}}
        onClear={() => {}}
        data-testid="ag"
      />,
    )

    act(() => {
      screen.getByTestId('ag-cell-1-1').focus()
    })
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByTestId('ag-cell-0-1'))
  })

  it('Space also commits the focused cell', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    render(
      <AlignGrid
        mode="flex"
        flexDirection="row"
        align={unset}
        justify={unset}
        onChange={onChange}
        onClear={() => {}}
        data-testid="ag"
      />,
    )

    act(() => {
      screen.getByTestId('ag-cell-2-2').focus()
    })
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith({ align: END, justify: END })
  })
})
