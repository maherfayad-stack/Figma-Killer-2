/**
 * PA-7 — inferAutoLayout over a table of layouts. Every row states what the
 * children's rects mean; the property under all of them is that the answer
 * puts each child back where it was (`exact`) or says it could not.
 */
import { describe, expect, it } from 'bun:test'
import { inferAutoLayout, type LayoutRect } from '@core/studio-runtime'

const box = (x: number, y: number, width: number, height: number): LayoutRect => ({ x, y, width, height })
const inner = box(0, 0, 400, 300)

describe('inferAutoLayout', () => {
  it('no children: a column with nothing to write', () => {
    const result = inferAutoLayout([], inner)
    expect(result.direction).toBe('column')
    expect(result.gap).toBe(0)
    expect(result.order).toEqual([])
  })

  it('one child: a column, padding keeps it in place', () => {
    const result = inferAutoLayout([box(20, 30, 100, 40)], inner)
    expect(result.direction).toBe('column')
    expect(result.padding.left).toBe(20)
    expect(result.padding.top).toBe(30)
    expect(result.exact).toBe(true)
  })

  it('side by side with a uniform gap is a row, gap and padding read off', () => {
    const result = inferAutoLayout([box(16, 16, 80, 40), box(112, 16, 80, 40), box(208, 16, 80, 40)], inner)
    expect(result).toMatchObject({ direction: 'row', wrap: false, gap: 16, align: 'flex-start', exact: true })
    expect(result.padding).toMatchObject({ left: 16, top: 16 })
    expect(result.order).toEqual([0, 1, 2])
  })

  it('stacked with a uniform gap is a column', () => {
    const result = inferAutoLayout([box(10, 10, 200, 30), box(10, 50, 200, 30), box(10, 90, 200, 30)], inner)
    expect(result).toMatchObject({ direction: 'column', gap: 10, align: 'flex-start', exact: true })
    expect(result.padding).toMatchObject({ left: 10, top: 10 })
  })

  it('sub-pixel gaps within a pixel still count as uniform', () => {
    const result = inferAutoLayout([box(0, 0, 50, 20), box(58.4, 0, 50, 20), box(116.6, 0, 50, 20)], inner)
    expect(result.gap).toBe(8)
    expect(result.exact).toBe(true)
  })

  it('mixed gaps average and report inexact', () => {
    const result = inferAutoLayout([box(0, 0, 50, 20), box(60, 0, 50, 20), box(150, 0, 50, 20)], inner)
    expect(result.direction).toBe('row')
    expect(result.gap).toBe(25)
    expect(result.exact).toBe(false)
  })

  it('overlapping children cannot be a negative gap: clamped and inexact', () => {
    const result = inferAutoLayout([box(0, 0, 60, 20), box(40, 0, 60, 20)], inner)
    expect(result.gap).toBe(0)
    expect(result.exact).toBe(false)
  })

  it('a row with a shared centre line aligns center', () => {
    const result = inferAutoLayout([box(0, 10, 50, 40), box(60, 20, 50, 20), box(120, 15, 50, 30)], inner)
    expect(result.align).toBe('center')
    expect(result.exact).toBe(true)
  })

  it('a row with a shared bottom edge aligns flex-end and keeps the bottom padding', () => {
    const result = inferAutoLayout([box(0, 20, 50, 40), box(60, 40, 50, 20), box(120, 30, 50, 30)], box(0, 0, 400, 100))
    expect(result.align).toBe('flex-end')
    expect(result.padding.bottom).toBe(40)
  })

  it('a column with a shared right edge aligns flex-end', () => {
    const result = inferAutoLayout([box(100, 0, 100, 20), box(150, 30, 50, 20), box(130, 60, 70, 20)], inner)
    expect(result).toMatchObject({ direction: 'column', align: 'flex-end', exact: true })
  })

  it('a grid of two lines wraps, with the line gap kept apart', () => {
    const result = inferAutoLayout(
      [box(0, 0, 100, 50), box(110, 0, 100, 50), box(0, 62, 100, 50), box(110, 62, 100, 50)],
      inner,
    )
    expect(result).toMatchObject({ direction: 'row', wrap: true, gap: 10, lineGap: 12, exact: true })
    expect(result.order).toEqual([0, 1, 2, 3])
  })

  it('order follows the visual position, not the input order', () => {
    const result = inferAutoLayout([box(200, 0, 50, 20), box(0, 0, 50, 20), box(100, 0, 50, 20)], inner)
    expect(result.direction).toBe('row')
    expect(result.order).toEqual([1, 2, 0])
  })

  it('a column reads its order top to bottom', () => {
    const result = inferAutoLayout([box(0, 100, 50, 20), box(0, 0, 50, 20), box(0, 50, 50, 20)], inner)
    expect(result.direction).toBe('column')
    expect(result.order).toEqual([1, 2, 0])
  })

  it('free space after the last child is not padding', () => {
    const result = inferAutoLayout([box(10, 10, 50, 20), box(70, 10, 50, 20)], inner)
    expect(result.padding.right).toBe(10)
    expect(result.padding.bottom).toBe(10)
  })

  it('padding is measured from the inner box, not from zero', () => {
    const result = inferAutoLayout([box(130, 150, 50, 20), box(190, 150, 50, 20)], box(100, 120, 400, 200))
    expect(result.padding).toMatchObject({ left: 30, top: 30 })
  })

  it('staggered rows that share no edge are reported inexact', () => {
    const result = inferAutoLayout([box(0, 0, 50, 40), box(60, 12, 50, 40)], inner)
    expect(result.exact).toBe(false)
  })
})

describe('inferAutoLayout — stretch (block flow)', () => {
  const column = [box(0, 0, 400, 30), box(0, 40, 400, 30)]

  it('full-width block children stretch when the layout is in flow', () => {
    const result = inferAutoLayout(column, inner, { stretch: true })
    expect(result).toMatchObject({ direction: 'column', align: 'stretch', gap: 10, exact: true })
  })

  it('children that hug do not stretch', () => {
    expect(inferAutoLayout([box(0, 0, 100, 30), box(0, 40, 100, 30)], inner, { stretch: true }).align).toBe('flex-start')
  })

  it('absolute children never stretch: they hug', () => {
    expect(inferAutoLayout(column, inner).align).toBe('flex-start')
  })

  it('equal padding either side counts as spanning', () => {
    const result = inferAutoLayout([box(12, 12, 376, 30), box(12, 52, 376, 30)], inner, { stretch: true })
    expect(result.align).toBe('stretch')
    expect(result.padding).toMatchObject({ left: 12, right: 12 })
  })
})
