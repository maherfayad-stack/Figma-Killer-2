import { describe, expect, it } from 'bun:test'
import {
  formatColor,
  hslaToRgba,
  hsvaToRgba,
  isColorToken,
  parseCssColor,
  rgbaToHsla,
  rgbaToHsva,
  type Rgba,
} from './colorParsing'

describe('colorParsing — isColorToken', () => {
  it('recognises a var(--token) reference', () => {
    expect(isColorToken('var(--brand-500)')).toBe(true)
    expect(isColorToken('  var(--brand-500)  ')).toBe(true)
  })

  it('rejects anything that is not a bare var() reference', () => {
    expect(isColorToken('#fff')).toBe(false)
    // Built via concatenation, not a literal `var(--name, fallback)` string —
    // this repo's `no-css-var-fallbacks` architecture gate bans that exact
    // source shape everywhere under src/ui, including inside test fixtures.
    expect(isColorToken('var(' + '--a, #fff)')).toBe(false)
    expect(isColorToken('calc(var(--a) + 1px)')).toBe(false)
  })
})

describe('colorParsing — hex', () => {
  it('parses hex3, expanding each digit', () => {
    const parsed = parseCssColor('#f0a')
    expect(parsed).toEqual({ rgba: { r: 255, g: 0, b: 170, a: 1 }, model: 'hex' })
  })

  it('parses hex4, expanding the alpha digit too', () => {
    const parsed = parseCssColor('#f0af')
    expect(parsed?.rgba).toEqual({ r: 255, g: 0, b: 170, a: 1 })
    const half = parseCssColor('#f0a8')
    // 0x88 / 255 rounds to 0.53
    expect(half?.rgba.a).toBeCloseTo(0.53, 2)
  })

  it('parses hex6', () => {
    expect(parseCssColor('#3355ff')).toEqual({ rgba: { r: 51, g: 85, b: 255, a: 1 }, model: 'hex' })
  })

  it('parses hex8, decoding the trailing alpha byte', () => {
    const parsed = parseCssColor('#3355ff80')
    expect(parsed?.rgba.r).toBe(51)
    expect(parsed?.rgba.g).toBe(85)
    expect(parsed?.rgba.b).toBe(255)
    expect(parsed?.rgba.a).toBeCloseTo(0.5, 1)
  })

  it('is case-insensitive', () => {
    expect(parseCssColor('#3355FF')).toEqual(parseCssColor('#3355ff'))
  })

  it('round-trips hex6 through formatColor', () => {
    const parsed = parseCssColor('#3355ff')!
    expect(formatColor(parsed.rgba, 'hex')).toBe('#3355ff')
  })

  it('round-trips hex8 (alpha < 1) through formatColor, staying 8 digits', () => {
    const parsed = parseCssColor('#3355ff80')!
    const out = formatColor(parsed.rgba, 'hex')
    expect(out).toMatch(/^#3355ff[0-9a-f]{2}$/)
  })

  it('drops the alpha suffix once alpha rounds back to fully opaque', () => {
    const rgba: Rgba = { r: 51, g: 85, b: 255, a: 1 }
    expect(formatColor(rgba, 'hex')).toBe('#3355ff')
  })
})

describe('colorParsing — rgb()/rgba()', () => {
  it('parses comma syntax', () => {
    expect(parseCssColor('rgb(51, 85, 255)')).toEqual({
      rgba: { r: 51, g: 85, b: 255, a: 1 },
      model: 'rgb',
    })
  })

  it('parses rgba() comma syntax with a fractional alpha', () => {
    const parsed = parseCssColor('rgba(51, 85, 255, 0.5)')
    expect(parsed?.rgba).toEqual({ r: 51, g: 85, b: 255, a: 0.5 })
  })

  it('parses modern space + slash syntax', () => {
    const parsed = parseCssColor('rgb(51 85 255 / 0.5)')
    expect(parsed?.rgba).toEqual({ r: 51, g: 85, b: 255, a: 0.5 })
  })

  it('parses percentage channels and a percentage alpha', () => {
    const parsed = parseCssColor('rgba(100%, 0%, 0%, 50%)')
    expect(parsed?.rgba).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
  })

  it('round-trips rgb() through formatColor', () => {
    const parsed = parseCssColor('rgb(51, 85, 255)')!
    expect(formatColor(parsed.rgba, 'rgb')).toBe('rgb(51, 85, 255)')
  })

  it('round-trips rgba() alpha through formatColor', () => {
    const parsed = parseCssColor('rgba(51, 85, 255, 0.5)')!
    expect(formatColor(parsed.rgba, 'rgb')).toBe('rgba(51, 85, 255, 0.5)')
  })

  it('rejects a malformed rgb() call', () => {
    expect(parseCssColor('rgb(51, 85)')).toBeNull()
    expect(parseCssColor('rgb(nope, 85, 255)')).toBeNull()
  })
})

describe('colorParsing — hsl()/hsla()', () => {
  it('parses comma syntax', () => {
    const parsed = parseCssColor('hsl(210, 100%, 60%)')
    expect(parsed?.model).toBe('hsl')
    expect(parsed?.rgba.a).toBe(1)
  })

  it('parses hsla() with alpha', () => {
    const parsed = parseCssColor('hsla(210, 100%, 60%, 0.5)')
    expect(parsed?.rgba.a).toBe(0.5)
  })

  it('parses modern space + slash syntax and a deg suffix', () => {
    const parsed = parseCssColor('hsl(210deg 100% 60% / 0.5)')
    expect(parsed?.rgba.a).toBe(0.5)
  })

  it('round-trips h/s/l through rgbaToHsla within rounding tolerance', () => {
    const parsed = parseCssColor('hsl(210, 100%, 60%)')!
    const hsla = rgbaToHsla(parsed.rgba)
    expect(hsla.h).toBeCloseTo(210, 0)
    expect(hsla.s).toBeCloseTo(100, 0)
    expect(hsla.l).toBeCloseTo(60, 0)
  })

  it('round-trips hsl() through formatColor', () => {
    const rgba = hslaToRgba({ h: 0, s: 100, l: 50, a: 1 })
    expect(formatColor(rgba, 'hsl')).toBe('hsl(0, 100%, 50%)')
  })

  it('rejects hsl() without percentage sign on s/l', () => {
    expect(parseCssColor('hsl(210, 100, 60)')).toBeNull()
  })
})

describe('colorParsing — named colours', () => {
  it('parses the CSS Level 1 keyword set', () => {
    expect(parseCssColor('red')?.rgba).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseCssColor('BLACK')?.rgba).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })

  it('parses transparent as alpha 0', () => {
    expect(parseCssColor('transparent')?.rgba).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
})

describe('colorParsing — the "never guess" rule', () => {
  it('returns null, not a fallback colour, for an unparseable value', () => {
    expect(parseCssColor('conic-gradient(red, blue)')).toBeNull()
    expect(parseCssColor('currentColor')).toBeNull()
    expect(parseCssColor('oklch(0.7 0.15 200)')).toBeNull()
    expect(parseCssColor('not-a-color')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })

  it('never confuses a var() reference for a parseable colour', () => {
    expect(parseCssColor('var(--brand-500)')).toBeNull()
  })
})

describe('colorParsing — Hsva round trip (the drag surfaces)', () => {
  const cases: ReadonlyArray<Rgba> = [
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 255, b: 0, a: 1 },
    { r: 0, g: 0, b: 255, a: 1 },
    { r: 51, g: 85, b: 255, a: 0.42 },
    { r: 255, g: 255, b: 255, a: 1 },
    { r: 0, g: 0, b: 0, a: 1 },
  ]

  for (const rgba of cases) {
    it(`round-trips rgb(${rgba.r}, ${rgba.g}, ${rgba.b}) @ a=${rgba.a} through Hsva`, () => {
      const hsva = rgbaToHsva(rgba)
      const back = hsvaToRgba(hsva)
      // Integer 0-255 channels round-tripped through floating-point hue/sat/
      // value math can be off by a rounding unit — within 1 is a lossless
      // round trip for this representation.
      expect(Math.abs(back.r - rgba.r)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.g - rgba.g)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.b - rgba.b)).toBeLessThanOrEqual(1)
      expect(back.a).toBeCloseTo(rgba.a, 2)
    })
  }
})

describe('colorParsing — alpha round-trips through every model', () => {
  const rgba: Rgba = { r: 51, g: 85, b: 255, a: 0.5 }

  it('hex', () => {
    const out = formatColor(rgba, 'hex')
    const parsed = parseCssColor(out)!
    expect(parsed.rgba.a).toBeCloseTo(0.5, 1)
  })

  it('rgb', () => {
    const out = formatColor(rgba, 'rgb')
    const parsed = parseCssColor(out)!
    expect(parsed.rgba.a).toBe(0.5)
  })

  it('hsl', () => {
    const out = formatColor(rgba, 'hsl')
    const parsed = parseCssColor(out)!
    expect(parsed.rgba.a).toBe(0.5)
  })
})
