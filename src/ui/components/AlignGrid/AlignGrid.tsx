/**
 * AlignGrid — Figma-style 3×3 alignment pad.
 *
 * Replaces two stacked `SegmentedControl` rows (Align / Justify) with one
 * composite widget that writes BOTH the cross-axis and main-axis alignment
 * property in a single click — cell (row, col) maps to exactly one
 * `{ align, justify }` pair. The cell math lives in `alignGridCells.ts`
 * (kept in a separate file so this component file exports nothing but the
 * component — react-refresh/only-export-components) and is exhaustively
 * unit-tested there via `AlignGrid.test.tsx`.
 *
 *   - `mode: 'flex'` writes `alignItems` + `justifyContent`.
 *   - `mode: 'grid'` writes `alignItems` + `justifyItems` (mirrors
 *     `GridAxisControl`'s fixed block/inline axis assignment — grid has no
 *     `flexDirection` to reverse, so `flexDirection` is ignored in this mode).
 *
 * Axis resolution reuses the exact vocabulary
 * `LayoutSection/alignmentOptions.tsx` already uses for the linear controls
 * (`flex-start | center | flex-end`, keyed off `flexDirection`), so this pad
 * and the existing controls can never disagree about what "start" means in a
 * column.
 *
 * Partial state: if only one of `align` / `justify` is set (`isSet: true`),
 * no single cell is drawn "active" — the whole row or column that property's
 * value maps to is highlighted instead (`'align-only'` / `'justify-only'`).
 * A value that cannot be expressed on the pad (`stretch`, `baseline`,
 * `space-between`, the `MIXED` sentinel, …) is treated the same as "unset"
 * for highlighting purposes — the pad never invents a cell to light up.
 *
 * Keyboard model: a single composite `role="grid"` — arrow keys move the
 * roving `tabIndex` between cells, Enter/Space commits the focused cell
 * (or clears, if that cell is already the exact active pair — mirrors
 * `SegmentedControl`'s click-active-to-clear idiom). Every cell's accessible
 * name states both writes a click on it would perform, in screen-position
 * words ("Align top, justify center") so a screen-reader user gets the same
 * two facts the picture shows a sighted user.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import {
  cellAccessibleName,
  findActiveCell,
  resolveAlignGridCellState,
  resolveAlignGridCellValues,
  type AlignGridMode,
  type AlignGridPropertyValue,
  type AlignGridValues,
} from './alignGridCells'
import styles from './AlignGrid.module.css'

export interface AlignGridProps {
  mode: AlignGridMode
  /** Ignored when `mode === 'grid'` — grid has no direction to reverse. */
  flexDirection: string
  align: AlignGridPropertyValue
  justify: AlignGridPropertyValue
  /** Fires with both values on any cell activation that isn't a clear. */
  onChange: (patch: AlignGridValues) => void
  /** Fires when the user activates the cell that is already the exact active pair. */
  onClear: () => void
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}

function cellKey(row: number, col: number): string {
  return `${row}-${col}`
}

const ROWS = [0, 1, 2] as const
const COLS = [0, 1, 2] as const

export function AlignGrid({
  mode,
  flexDirection,
  align,
  justify,
  onChange,
  onClear,
  className,
  'aria-label': ariaLabel = 'Alignment',
  'data-testid': dataTestId,
}: AlignGridProps) {
  // Roving tabIndex — one cell is tabbable at a time. Seeded from whichever
  // cell is currently active (or the center cell when nothing is), then
  // owned by keyboard/mouse focus from that point on.
  const [focusCell, setFocusCell] = useState(() => findActiveCell(mode, flexDirection, align, justify))
  const cellRefs = useRef(new Map<string, HTMLButtonElement | null>())

  function commit(row: number, col: number) {
    const state = resolveAlignGridCellState(row, col, mode, flexDirection, align, justify)
    if (state === 'active') {
      onClear()
      return
    }
    onChange(resolveAlignGridCellValues(row, col, mode, flexDirection))
  }

  function moveFocus(row: number, col: number) {
    const clampedRow = Math.min(2, Math.max(0, row))
    const clampedCol = Math.min(2, Math.max(0, col))
    setFocusCell({ row: clampedRow, col: clampedCol })
    cellRefs.current.get(cellKey(clampedRow, clampedCol))?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, row: number, col: number) {
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(row - 1, col)
        break
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(row + 1, col)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(row, col - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(row, col + 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(row, col)
        break
      default:
        break
    }
  }

  return (
    <div role="grid" aria-label={ariaLabel} data-testid={dataTestId} className={cn(styles.grid, className)}>
      {ROWS.map((row) => (
        <div key={row} role="row" className={styles.row}>
          {COLS.map((col) => {
            const state = resolveAlignGridCellState(row, col, mode, flexDirection, align, justify)
            const name = cellAccessibleName(row, col, mode, flexDirection)
            const isTabbable = focusCell.row === row && focusCell.col === col
            return (
              <Button
                key={col}
                ref={(el) => {
                  cellRefs.current.set(cellKey(row, col), el)
                }}
                variant="ghost"
                size="micro"
                iconOnly
                role="gridcell"
                aria-selected={state !== 'inactive'}
                aria-label={name}
                tooltip={name}
                tabIndex={isTabbable ? 0 : -1}
                data-cell-state={state}
                data-testid={dataTestId ? `${dataTestId}-cell-${row}-${col}` : undefined}
                className={styles.cell}
                onClick={() => {
                  setFocusCell({ row, col })
                  commit(row, col)
                }}
                onFocus={() => setFocusCell({ row, col })}
                onKeyDown={(event) => handleKeyDown(event, row, col)}
              >
                <span aria-hidden="true" className={styles.mark} />
              </Button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
