import { describe, expect, it } from 'bun:test'
import { colorDifference, contrastLevel, contrastRatio, cssColorToRgb, parseHexColor, relativeLuminance } from './colorMath'

describe('parseHexColor', () => {
  it('reads the three hex forms a stylesheet actually uses', () => {
    expect(parseHexColor('#0C9AB0')).toEqual({ r: 12, g: 154, b: 176 })
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    // Alpha is parsed off and discarded — a token's opacity is not a colour
    // difference, and refusing the form outright would drop real tokens
    // (`--color-black-50: #00000080`).
    expect(parseHexColor('#00000080')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('returns null for every non-hex value a token can hold', () => {
    for (const value of ['currentColor', 'rgb(1,2,3)', 'var(--x)', '26px', '#gggggg', '#12345', '']) {
      expect(parseHexColor(value)).toBeNull()
    }
  })
})

describe('cssColorToRgb', () => {
  it('parses hex, rgb()/rgba(), and hsl()/hsla() to the same shape', () => {
    expect(cssColorToRgb('#0c9ab0')).toEqual({ r: 12, g: 154, b: 176 })
    expect(cssColorToRgb('rgb(12, 154, 176)')).toEqual({ r: 12, g: 154, b: 176 })
    expect(cssColorToRgb('rgba(12 154 176 / 0.5)')).toEqual({ r: 12, g: 154, b: 176 })
    expect(cssColorToRgb('rgb(100% 0% 0%)')).toEqual({ r: 255, g: 0, b: 0 })
  })

  it('converts hsl() the same way a browser would for known landmarks', () => {
    expect(cssColorToRgb('hsl(0, 0%, 0%)')).toEqual({ r: 0, g: 0, b: 0 })
    expect(cssColorToRgb('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255 })
    expect(cssColorToRgb('hsl(0deg 100% 50%)')).toEqual({ r: 255, g: 0, b: 0 })
  })

  it('returns null for a var() reference, currentColor, or garbage', () => {
    for (const value of ['var(--x)', 'currentColor', 'calc(1px + 2px)', 'not-a-color']) {
      expect(cssColorToRgb(value)).toBeNull()
    }
  })
})

describe('colorDifference', () => {
  it('is zero for identical colours', () => {
    expect(colorDifference({ r: 12, g: 154, b: 176 }, { r: 12, g: 154, b: 176 })).toBe(0)
  })

  it('rates an imperceptible shift below the just-noticeable threshold', () => {
    // One step per channel is invisible; the whole point of the metric is that
    // it does not report this as a different colour.
    expect(colorDifference({ r: 12, g: 154, b: 176 }, { r: 13, g: 155, b: 177 })).toBeLessThan(1)
  })

  it('rates two genuinely different brand colours as far apart', () => {
    // ALM aqua-100 vs coral-100 — the exact confusion this guards, since a
    // teal primary and a red primary must never match the same token.
    expect(colorDifference({ r: 12, g: 154, b: 176 }, { r: 239, g: 69, b: 80 })).toBeGreaterThan(40)
  })

  it('separates near-blacks that RGB distance would call adjacent', () => {
    // The failure mode plain RGB distance has: #000 and #1c1c1c are 28 units
    // apart in RGB — the same as two mid-greens nobody would confuse — but
    // perceptually they are clearly distinct, which is why the metric is
    // perceptual. ALM ships #1c1c1c as its text colour, not #000.
    const delta = colorDifference({ r: 0, g: 0, b: 0 }, { r: 28, g: 28, b: 28 })
    expect(delta).toBeGreaterThan(5)
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1)
    expect(contrastRatio({ r: 12, g: 154, b: 176 }, { r: 12, g: 154, b: 176 })).toBeCloseTo(1, 5)
  })

  it('does not depend on argument order', () => {
    const a = { r: 28, g: 28, b: 28 }
    const b = { r: 247, g: 249, b: 250 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })
})

describe('relativeLuminance', () => {
  it('orders black below a mid grey below white', () => {
    const black = relativeLuminance({ r: 0, g: 0, b: 0 })
    const grey = relativeLuminance({ r: 128, g: 128, b: 128 })
    const white = relativeLuminance({ r: 255, g: 255, b: 255 })
    expect(black).toBe(0)
    expect(white).toBeCloseTo(1, 5)
    expect(grey).toBeGreaterThan(black)
    expect(grey).toBeLessThan(white)
  })
})

describe('contrastLevel', () => {
  it('bands normal text at the 4.5/7 thresholds', () => {
    expect(contrastLevel(21)).toBe('AAA')
    expect(contrastLevel(7)).toBe('AAA')
    expect(contrastLevel(6.99)).toBe('AA')
    expect(contrastLevel(4.5)).toBe('AA')
    expect(contrastLevel(4.49)).toBe('fail')
    expect(contrastLevel(1)).toBe('fail')
  })

  it('bands large text at the looser 3/4.5 thresholds', () => {
    expect(contrastLevel(4.5, true)).toBe('AAA')
    expect(contrastLevel(3, true)).toBe('AA')
    expect(contrastLevel(2.9, true)).toBe('fail')
  })
})
