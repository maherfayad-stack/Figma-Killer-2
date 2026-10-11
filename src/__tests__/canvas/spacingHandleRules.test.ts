/**
 * P5-E (IX-17) — the padding / gap handles' rules: where the bands are, and
 * what a drag on one writes (⇧ the axis pair, ⌥ all four, gaps per axis).
 * Pure; the gesture and a real browser's layout are the e2e's
 * (`tests/e2e/canvas-tools-and-handles.e2e.ts`).
 */
import { describe, expect, it } from 'bun:test'
import {
  HANDLE_LENGTH,
  bandDelta,
  MIN_BAND_THICKNESS,
  spacingBands,
  spacingPatch,
  type SpacingBand,
  type SpacingGeometry,
} from '@site/canvas/spacingHandleRules'

/** A 300 × 100 flex row at (10, 20): padding 12 / 16 / 8 / 4, border 1, three 40-wide children 10 apart. */
function row(overrides: Partial<SpacingGeometry> = {}): SpacingGeometry {
  return {
    rect: { x: 10, y: 20, width: 300, height: 100 },
    padding: { top: 12, right: 16, bottom: 8, left: 4 },
    border: { top: 1, right: 1, bottom: 1, left: 1 },
    rowGap: 0,
    columnGap: 10,
    children: [
      { x: 15, y: 33, width: 40, height: 50 },
      { x: 65, y: 33, width: 40, height: 50 },
      { x: 115, y: 33, width: 40, height: 50 },
    ],
    ...overrides,
  }
}

function padding(bands: SpacingBand[], side: string) {
  return bands.find((band) => band.kind === 'padding' && band.side === side)!
}

describe('spacingBands', () => {
  it('puts each padding handle inside the border: a short pill centred in its padding side, not the whole side', () => {
    const bands = spacingBands(row())
    // Top padding region is x 1..299, y 1..13 (12 thick): a 32 x 6 pill centred in it.
    expect(padding(bands, 'top').rect).toEqual({ x: 134, y: 4, width: HANDLE_LENGTH, height: MIN_BAND_THICKNESS })
    // Bottom region y 91..99 (8 thick).
    expect(padding(bands, 'bottom').rect).toEqual({ x: 134, y: 92, width: HANDLE_LENGTH, height: MIN_BAND_THICKNESS })
    // The side regions run between the top and bottom ones (y 13..91).
    expect(padding(bands, 'left').rect).toEqual({ x: 1, y: 36, width: MIN_BAND_THICKNESS, height: HANDLE_LENGTH })
    expect(padding(bands, 'right').rect).toEqual({ x: 288, y: 36, width: MIN_BAND_THICKNESS, height: HANDLE_LENGTH })
  })

  it('a handle never covers the middle of its region, where a press means "move the container"', () => {
    const bands = spacingBands(row())
    const top = padding(bands, 'top').rect
    // The padding side is 298 wide; its pointer-hit area is one pill of it.
    expect(top.width).toBeLessThan(298 / 4)
    const gap = bands.find((band) => band.kind === 'gap')!.rect
    expect(gap.height).toBeLessThan(50)
  })

  it('a zero padding still gets a grabbable handle', () => {
    const bands = spacingBands(row({ padding: { top: 0, right: 0, bottom: 0, left: 0 } }))
    expect(padding(bands, 'top').rect.height).toBe(MIN_BAND_THICKNESS)
    expect(padding(bands, 'top').value).toBe(0)
  })

  it('one COLUMN gap handle between each pair of side-by-side children, centred on the gap', () => {
    const gaps = spacingBands(row()).filter((band) => band.kind === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps.every((band) => band.kind === 'gap' && band.axis === 'column' && band.value === 10)).toBe(true)
    // Between x 55 and 65 in the frame -> 45..55 relative to the container; shared height 50, so a 32-long pill centred in it.
    expect(gaps[0]!.rect).toEqual({ x: 47, y: 22, width: MIN_BAND_THICKNESS, height: HANDLE_LENGTH })
  })

  it('a wide gap is still only a thin pill in its middle (a 31px row gap is not a 31px handle)', () => {
    const column = row({
      rowGap: 31,
      columnGap: 0,
      children: [
        { x: 15, y: 33, width: 200, height: 20 },
        { x: 15, y: 84, width: 200, height: 20 },
      ],
    })
    const [gap] = spacingBands(column).filter((band) => band.kind === 'gap')
    expect(gap!.rect.height).toBe(MIN_BAND_THICKNESS)
    expect(gap!.rect.width).toBe(HANDLE_LENGTH)
  })

  it('stacked children get ROW gap handles', () => {
    const column = row({
      rowGap: 6,
      columnGap: 0,
      children: [
        { x: 15, y: 33, width: 200, height: 20 },
        { x: 15, y: 59, width: 200, height: 20 },
      ],
    })
    const [gap] = spacingBands(column).filter((band) => band.kind === 'gap')
    expect(gap).toMatchObject({ kind: 'gap', axis: 'row', value: 6 })
    expect(gap!.rect).toEqual({ x: 89, y: 33, width: HANDLE_LENGTH, height: MIN_BAND_THICKNESS })
  })
})

describe('spacingPatch — what a drag writes', () => {
  const geometry = row()
  const bands = spacingBands(geometry)

  it('pulling a band INTO the box grows its padding; never below 0', () => {
    expect(bandDelta(padding(bands, 'top'), 0, 5)).toBe(5)
    expect(bandDelta(padding(bands, 'right'), -5, 0)).toBe(5)
    expect(spacingPatch(padding(bands, 'top'), geometry, 0, 5, { axisPair: false, allSides: false })).toEqual({ paddingTop: '17px' })
    expect(spacingPatch(padding(bands, 'left'), geometry, -20, 0, { axisPair: false, allSides: false })).toEqual({ paddingLeft: '0px' })
  })

  it('⇧ writes the axis pair, each from its own start', () => {
    expect(spacingPatch(padding(bands, 'top'), geometry, 0, 4, { axisPair: true, allSides: false })).toEqual({
      paddingTop: '16px',
      paddingBottom: '12px',
    })
  })

  it('⌥ writes all four', () => {
    expect(spacingPatch(padding(bands, 'left'), geometry, 2, 0, { axisPair: false, allSides: true })).toEqual({
      paddingTop: '14px',
      paddingRight: '18px',
      paddingBottom: '10px',
      paddingLeft: '6px',
    })
  })

  it('a column gap band writes columnGap, rounded', () => {
    const gap = bands.find((band) => band.kind === 'gap')!
    expect(spacingPatch(gap, geometry, 7.6, 30, { axisPair: false, allSides: false })).toEqual({ columnGap: '18px' })
  })
})
