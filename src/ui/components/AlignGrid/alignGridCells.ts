/**
 * alignGridCells — the pure cell math behind `AlignGrid`.
 *
 * Split out of `AlignGrid.tsx` (react-refresh/only-export-components) so the
 * component file exports nothing but the component. See `AlignGrid.tsx`'s
 * module doc for the full design rationale; this file is the part that is
 * exhaustively unit-tested in `AlignGrid.test.tsx`.
 */
import { type Mixed } from '@ui/components/MixedValue'

export type AlignGridMode = 'flex' | 'grid'

const START = 'flex-start'
const CENTER = 'center'
const END = 'flex-end'

export interface AlignGridPropertyValue {
  /** Current resolved value, or the `MIXED` sentinel for a disagreeing multi-selection. */
  value: string | Mixed | undefined
  /** Whether this CSS property has an explicit value (vs. inherited/default). */
  isSet: boolean
}

/** The pair AlignGrid writes in one gesture. */
export interface AlignGridValues {
  /** Writes to `alignItems`. */
  align: string
  /** Writes to `justifyContent` (flex mode) or `justifyItems` (grid mode). */
  justify: string
}

export type AlignGridCellState = 'active' | 'align-only' | 'justify-only' | 'inactive'

function isColumnDirection(flexDirection: string): boolean {
  return flexDirection.startsWith('column')
}

function isReversedDirection(flexDirection: string): boolean {
  return flexDirection.endsWith('reverse')
}

/** Whether the *main* axis (the one `justify` writes) runs left-right on screen. */
function isMainAxisHorizontal(mode: AlignGridMode, flexDirection: string): boolean {
  // Grid's justify-items is always the inline (horizontal) axis —
  // GridAxisControl has no direction input at all, so grid mode mirrors that
  // fixed assignment instead of reading flexDirection.
  if (mode === 'grid') return true
  return !isColumnDirection(flexDirection)
}

/** Whether the main axis is reversed — its start edge is on the opposite screen side. */
function isMainAxisReversed(mode: AlignGridMode, flexDirection: string): boolean {
  if (mode === 'grid') return false
  return isReversedDirection(flexDirection)
}

function indexToValue(index: number, reversed: boolean): string {
  const effective = reversed ? 2 - index : index
  return effective === 0 ? START : effective === 1 ? CENTER : END
}

function valueToIndex(value: string | Mixed | undefined, reversed: boolean): number | null {
  if (typeof value !== 'string') return null
  const forward = value === START ? 0 : value === CENTER ? 1 : value === END ? 2 : null
  if (forward === null) return null
  return reversed ? 2 - forward : forward
}

/**
 * Cell (row, col) → the `{ align, justify }` pair a click on that cell would
 * write. Row 0 / col 0 is top-left. Pure — exhaustively tested for all four
 * `flexDirection` values × all nine cells in AlignGrid.test.tsx.
 */
export function resolveAlignGridCellValues(
  row: number,
  col: number,
  mode: AlignGridMode,
  flexDirection: string,
): AlignGridValues {
  const mainHorizontal = isMainAxisHorizontal(mode, flexDirection)
  const reversed = isMainAxisReversed(mode, flexDirection)
  const mainIndex = mainHorizontal ? col : row
  const crossIndex = mainHorizontal ? row : col
  return {
    align: indexToValue(crossIndex, false),
    justify: indexToValue(mainIndex, reversed),
  }
}

/**
 * The highlight state of cell (row, col) given the current align/justify
 * values. `'active'` only when BOTH properties are set and both resolve to
 * this exact cell. When only one is set, every cell along the row or column
 * that property's value maps to is `'align-only'` / `'justify-only'` —
 * never a single invented cell.
 */
export function resolveAlignGridCellState(
  row: number,
  col: number,
  mode: AlignGridMode,
  flexDirection: string,
  align: AlignGridPropertyValue,
  justify: AlignGridPropertyValue,
): AlignGridCellState {
  const mainHorizontal = isMainAxisHorizontal(mode, flexDirection)
  const reversed = isMainAxisReversed(mode, flexDirection)
  const mainIndex = mainHorizontal ? col : row
  const crossIndex = mainHorizontal ? row : col

  const alignIndex = align.isSet ? valueToIndex(align.value, false) : null
  const justifyIndex = justify.isSet ? valueToIndex(justify.value, reversed) : null

  const alignHere = alignIndex !== null && alignIndex === crossIndex
  const justifyHere = justifyIndex !== null && justifyIndex === mainIndex

  if (alignIndex !== null && justifyIndex !== null) {
    return alignHere && justifyHere ? 'active' : 'inactive'
  }
  if (alignIndex !== null) return alignHere ? 'align-only' : 'inactive'
  if (justifyIndex !== null) return justifyHere ? 'justify-only' : 'inactive'
  return 'inactive'
}

const VERTICAL_WORDS = ['top', 'center', 'bottom'] as const
const HORIZONTAL_WORDS = ['left', 'center', 'right'] as const

/**
 * Accessible name for a cell — states both writes a click on it would
 * perform, in screen-position words (top/bottom/left/right) rather than raw
 * CSS keywords, so it reads the same fact the picture shows regardless of
 * `flexDirection` reversal.
 */
export function cellAccessibleName(row: number, col: number, mode: AlignGridMode, flexDirection: string): string {
  const mainHorizontal = isMainAxisHorizontal(mode, flexDirection)
  const alignWord = mainHorizontal ? VERTICAL_WORDS[row] : HORIZONTAL_WORDS[col]
  const justifyWord = mainHorizontal ? HORIZONTAL_WORDS[col] : VERTICAL_WORDS[row]
  return `Align ${alignWord}, justify ${justifyWord}`
}

export function findActiveCell(
  mode: AlignGridMode,
  flexDirection: string,
  align: AlignGridPropertyValue,
  justify: AlignGridPropertyValue,
): { row: number; col: number } {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (resolveAlignGridCellState(row, col, mode, flexDirection, align, justify) === 'active') {
        return { row, col }
      }
    }
  }
  return { row: 1, col: 1 }
}
