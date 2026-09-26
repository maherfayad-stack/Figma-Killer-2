/**
 * P5-E (IX-17) — the padding / gap handles' rules: where the bands are, and
 * what a drag on one writes (⇧ the axis pair, ⌥ all four, gaps per axis).
 * Pure; the gesture and a real browser's layout are the e2e's
 * (`tests/e2e/canvas-tools-and-handles.e2e.ts`).
 */
import { describe, expect, it } from 'bun:test'
import {
  bandDelta,
  isSpacingLayout,
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
  it('puts each padding band inside the border, as thick as the padding', () => {
    const bands = spacingBands(row())
    expect(padding(bands, 'top').rect).toEqual({ x: 1, y: 1, width: 298, height: 12 })
    expect(padding(bands, 'bottom').rect).toEqual({ x: 1, y: 91, width: 298, height: 8 })
    // The side bands run between the top and bottom ones.
    expect(padding(bands, 'left').rect).toEqual({ x: 1, y: 13, width: MIN_BAND_THICKNESS, height: 78 })
    expect(padding(bands, 'right').rect).toEqual({ x: 283, y: 13, width: 16, height: 78 })
  })

  it('a zero padding still gets a grabbable band', () => {
    const bands = spacingBands(row({ padding: { top: 0, right: 0, bottom: 0, left: 0 } }))
    expect(padding(bands, 'top').rect.height).toBe(MIN_BAND_THICKNESS)
    expect(padding(bands, 'top').value).toBe(0)
  })

  it('one COLUMN gap band between each pair of side-by-side children, centred on the gap', () => {
    const gaps = spacingBands(row()).filter((band) => band.kind === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps.every((band) => band.kind === 'gap' && band.axis === 'column' && band.value === 10)).toBe(true)
    // Between x 55 and 65 in the frame → 45..55 relative to the container.
    expect(gaps[0]!.rect).toEqual({ x: 45, y: 13, width: 10, height: 50 })
  })

  it('stacked children get ROW gap bands', () => {
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
    expect(gap!.rect).toEqual({ x: 5, y: 33, width: 200, height: MIN_BAND_THICKNESS })
  })

  it('only flex and grid get handles', () => {
    expect(isSpacingLayout('flex')).toBe(true)
    expect(isSpacingLayout('inline-grid')).toBe(true)
    expect(isSpacingLayout('block')).toBe(false)
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
