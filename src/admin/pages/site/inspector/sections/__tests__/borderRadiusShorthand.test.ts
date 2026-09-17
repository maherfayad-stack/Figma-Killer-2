/**
 * borderRadiusShorthand — the pure `border-radius` ⇄ four-corner model behind
 * the radius cluster's link toggle. Written against CSS Backgrounds 3 §5.1's
 * own 1/2/3/4-component expansion, and against the three shapes the module
 * refuses rather than guesses at.
 */
import { describe, expect, it } from 'bun:test'
import { parseRadiusShorthand } from '../borderRadiusShorthand'

describe('parseRadiusShorthand — CSS expansion', () => {
  it('one component sets every corner', () => {
    const parsed = parseRadiusShorthand('12px')
    expect(parsed).toEqual({
      ok: true,
      corners: { TopLeft: '12px', TopRight: '12px', BottomRight: '12px', BottomLeft: '12px' },
    })
  })

  it('two components pair the diagonals', () => {
    const parsed = parseRadiusShorthand('4px 8px')
    expect(parsed).toEqual({
      ok: true,
      corners: { TopLeft: '4px', TopRight: '8px', BottomRight: '4px', BottomLeft: '8px' },
    })
  })

  it('three components repeat the second for bottom-left', () => {
    const parsed = parseRadiusShorthand('1px 2px 3px')
    expect(parsed).toEqual({
      ok: true,
      corners: { TopLeft: '1px', TopRight: '2px', BottomRight: '3px', BottomLeft: '2px' },
    })
  })

  it('four components map one-to-one, clockwise from top-left', () => {
    const parsed = parseRadiusShorthand('1px 2px 3px 4px')
    expect(parsed).toEqual({
      ok: true,
      corners: { TopLeft: '1px', TopRight: '2px', BottomRight: '3px', BottomLeft: '4px' },
    })
  })

  it('an empty value is four empty corners, not a refusal', () => {
    expect(parseRadiusShorthand('   ')).toEqual({
      ok: true,
      corners: { TopLeft: '', TopRight: '', BottomRight: '', BottomLeft: '' },
    })
  })
})

describe('parseRadiusShorthand — refusals', () => {
  it('refuses the elliptical form, because each corner is then two radii', () => {
    const parsed = parseRadiusShorthand('12px 4px / 8px 2px')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toMatch(/elliptical/i)
  })

  it('refuses a value containing a function call, because spaces are not a safe separator inside one', () => {
    const parsed = parseRadiusShorthand('calc(1px + 2px) 4px')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toMatch(/function call/i)
  })

  it('refuses more than four components', () => {
    expect(parseRadiusShorthand('1px 2px 3px 4px 5px').ok).toBe(false)
  })
})
