/**
 * gradientValue — parse/serialize tests.
 *
 * The refusal path is tested at least as hard as the happy path (per the
 * work order): every documented CSS gradient feature this module doesn't
 * support gets its own refusal test, not just a smoke test that SOME string
 * fails.
 */
import { describe, expect, it } from 'bun:test'
import {
  extractUrlPayload,
  isUrlImageValue,
  parseGradient,
  serializeGradient,
  wrapUrlPayload,
  type ParsedGradient,
} from '../gradientValue'

function expectOk(value: string) {
  const result = parseGradient(value)
  if (!result.ok) throw new Error(`Expected ok, got refusal: ${result.reason}`)
  return result.gradient
}

function expectRefused(value: string): string {
  const result = parseGradient(value)
  if (result.ok) throw new Error(`Expected a refusal for "${value}", parsed instead.`)
  return result.reason
}

describe('parseGradient — happy path', () => {
  it('parses a linear gradient with an angle and percentage stops', () => {
    const gradient = expectOk('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)')
    expect(gradient.kind).toBe('linear')
    expect(gradient.direction).toEqual({ kind: 'angle', raw: '90deg', value: 90, unit: 'deg' })
    expect(gradient.stops).toEqual([
      { color: '#ff0000', position: 0 },
      { color: '#0000ff', position: 100 },
    ])
  })

  it('parses a linear gradient with a "to <side>" keyword direction', () => {
    const gradient = expectOk('linear-gradient(to right, red, blue)')
    expect(gradient.direction).toEqual({ kind: 'keyword', keyword: 'to right' })
    expect(gradient.stops).toEqual([
      { color: 'red', position: undefined },
      { color: 'blue', position: undefined },
    ])
  })

  it('parses a "to <corner>" (two-word) direction', () => {
    const gradient = expectOk('linear-gradient(to top left, red, blue)')
    expect(gradient.direction).toEqual({ kind: 'keyword', keyword: 'to top left' })
  })

  it('parses a linear gradient with no explicit direction (CSS default)', () => {
    const gradient = expectOk('linear-gradient(red, blue)')
    expect(gradient.direction).toBeUndefined()
    expect(gradient.stops.map((s) => s.color)).toEqual(['red', 'blue'])
  })

  it('parses stops with only SOME positions set', () => {
    const gradient = expectOk('linear-gradient(red, blue 50%, green)')
    expect(gradient.stops).toEqual([
      { color: 'red', position: undefined },
      { color: 'blue', position: 50 },
      { color: 'green', position: undefined },
    ])
  })

  it('accepts rgba()/hsla() colours despite their internal commas', () => {
    const gradient = expectOk('linear-gradient(rgba(0, 0, 0, 0.5) 0%, hsla(200, 50%, 50%, 1) 100%)')
    expect(gradient.stops).toEqual([
      { color: 'rgba(0, 0, 0, 0.5)', position: 0 },
      { color: 'hsla(200, 50%, 50%, 1)', position: 100 },
    ])
  })

  it('accepts var(--token) as a stop colour', () => {
    const gradient = expectOk('linear-gradient(var(--brand-500), var(--brand-900))')
    expect(gradient.stops.map((s) => s.color)).toEqual(['var(--brand-500)', 'var(--brand-900)'])
  })

  it('parses a radial gradient with a bare shape', () => {
    const gradient = expectOk('radial-gradient(circle, red 0%, blue 100%)')
    expect(gradient.kind).toBe('radial')
    expect(gradient.shape).toBe('circle')
  })

  it('parses a radial gradient with an "ellipse" shape', () => {
    const gradient = expectOk('radial-gradient(ellipse, red, blue)')
    expect(gradient.shape).toBe('ellipse')
  })

  it('parses a radial gradient with no explicit shape', () => {
    const gradient = expectOk('radial-gradient(red, blue)')
    expect(gradient.shape).toBeUndefined()
  })

  it('parses 3+ stops', () => {
    const gradient = expectOk('linear-gradient(red 0%, yellow 50%, blue 100%)')
    expect(gradient.stops).toHaveLength(3)
  })

  it('is whitespace- and case-tolerant', () => {
    const gradient = expectOk('  LINEAR-GRADIENT( TO RIGHT ,   red  ,  blue ) ')
    expect(gradient.direction).toEqual({ kind: 'keyword', keyword: 'to right' })
    expect(gradient.stops.map((s) => s.color)).toEqual(['red', 'blue'])
  })

  it('supports grad/rad/turn angle units', () => {
    expect(expectOk('linear-gradient(0.25turn, red, blue)').direction).toEqual({
      kind: 'angle',
      raw: '0.25turn',
      value: 0.25,
      unit: 'turn',
    })
    expect(expectOk('linear-gradient(100grad, red, blue)').direction).toEqual({
      kind: 'angle',
      raw: '100grad',
      value: 100,
      unit: 'grad',
    })
    expect(expectOk('linear-gradient(1.5rad, red, blue)').direction).toEqual({
      kind: 'angle',
      raw: '1.5rad',
      value: 1.5,
      unit: 'rad',
    })
  })
})

describe('parseGradient — refusals', () => {
  it('refuses a plain colour / non-function value', () => {
    expect(expectRefused('red')).toMatch(/not a single/i)
  })

  it('refuses url(...)', () => {
    expect(expectRefused("url('/hero.png')")).toMatch(/not a single/i)
  })

  it('refuses conic-gradient (unsupported function)', () => {
    expect(expectRefused('conic-gradient(red, blue)')).toMatch(/not a single/i)
  })

  it('refuses repeating-linear-gradient (unsupported function)', () => {
    expect(expectRefused('repeating-linear-gradient(red, blue)')).toMatch(/not a single/i)
  })

  it('refuses a layered value: gradient + image on the same background-image', () => {
    expect(expectRefused("linear-gradient(red, blue), url('/hero.png')")).toMatch(/more than one layer/i)
  })

  it('refuses two comma-separated gradients (multi-layer background-image)', () => {
    expect(expectRefused('linear-gradient(red, blue), linear-gradient(yellow, green)')).toMatch(
      /more than one layer/i,
    )
  })

  it('refuses a colour hint between stops', () => {
    const reason = expectRefused('linear-gradient(red, 50%, blue)')
    expect(reason).toMatch(/colour hint/i)
  })

  it('refuses a double-position hard stop', () => {
    const reason = expectRefused('linear-gradient(red 0% 10%, blue 90% 100%)')
    expect(reason).toMatch(/more than one position/i)
  })

  it('refuses a stop position in a non-percentage unit', () => {
    const reason = expectRefused('linear-gradient(red 0px, blue 100px)')
    expect(reason).toMatch(/percentage/i)
  })

  it('refuses fewer than two stops', () => {
    expect(expectRefused('linear-gradient(red)')).toMatch(/at least two/i)
  })

  it('refuses radial-gradient with an explicit position ("at ...")', () => {
    const reason = expectRefused('radial-gradient(circle at center, red, blue)')
    expect(reason).toMatch(/size or position/i)
  })

  it('refuses radial-gradient with a size keyword', () => {
    const reason = expectRefused('radial-gradient(closest-side, red, blue)')
    expect(reason).toMatch(/size or position/i)
  })

  it('refuses an unsupported direction keyword', () => {
    const reason = expectRefused('linear-gradient(to bottom top, red, blue)')
    expect(reason).toMatch(/unsupported direction/i)
  })

  it('refuses unbalanced parentheses', () => {
    expect(expectRefused('linear-gradient(red, blue')).toMatch(/unbalanced/i)
  })

  it('refuses an empty value', () => {
    expect(expectRefused('')).toMatch(/empty/i)
  })

  it('refuses a stray trailing comma (empty argument)', () => {
    expect(expectRefused('linear-gradient(red, blue,)')).toMatch(/empty/i)
  })

  it('refuses a CSS Color 4 interpolation-method prefix', () => {
    // `in oklch` isn't a direction/shape our grammar recognises, and isn't a
    // colour stop either — it must not silently become stop #1's colour.
    const reason = expectRefused('linear-gradient(in oklch, red, blue)')
    expect(typeof reason).toBe('string')
    expect(reason.length).toBeGreaterThan(0)
  })
})

describe('serializeGradient', () => {
  it('round-trips a fully-specified linear gradient (structurally)', () => {
    const gradient: ParsedGradient = {
      kind: 'linear',
      direction: { kind: 'angle', raw: '90deg', value: 90, unit: 'deg' },
      stops: [
        { color: '#ff0000', position: 0 },
        { color: '#0000ff', position: 100 },
      ],
    }
    const css = serializeGradient(gradient)
    expect(css).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)')
    expect(expectOk(css)).toEqual(gradient)
  })

  it('omits the direction when unset, matching CSS default semantics', () => {
    const gradient: ParsedGradient = {
      kind: 'linear',
      stops: [
        { color: 'red', position: undefined },
        { color: 'blue', position: undefined },
      ],
    }
    expect(serializeGradient(gradient)).toBe('linear-gradient(red, blue)')
  })

  it('omits the shape when unset for a radial gradient', () => {
    const gradient: ParsedGradient = {
      kind: 'radial',
      stops: [
        { color: 'red', position: undefined },
        { color: 'blue', position: undefined },
      ],
    }
    expect(serializeGradient(gradient)).toBe('radial-gradient(red, blue)')
  })

  it('preserves the exact angle text rather than reformatting it', () => {
    const gradient = expectOk('linear-gradient(33.333deg, red, blue)')
    expect(serializeGradient(gradient)).toBe('linear-gradient(33.333deg, red, blue)')
  })

  it('preserves a keyword direction with a corner', () => {
    const gradient = expectOk('linear-gradient(to bottom right, red, blue)')
    expect(serializeGradient(gradient)).toBe('linear-gradient(to bottom right, red, blue)')
  })
})

describe('URL helpers (the OTHER backgroundImage shape)', () => {
  it('isUrlImageValue recognises url(...)', () => {
    expect(isUrlImageValue("url('/hero.png')")).toBe(true)
    expect(isUrlImageValue('linear-gradient(red, blue)')).toBe(false)
  })

  it('extractUrlPayload pulls the payload out of single/double/no quotes', () => {
    expect(extractUrlPayload("url('/hero.png')")).toBe('/hero.png')
    expect(extractUrlPayload('url("/hero.png")')).toBe('/hero.png')
    expect(extractUrlPayload('url(/hero.png)')).toBe('/hero.png')
    expect(extractUrlPayload('linear-gradient(red, blue)')).toBe('')
  })

  it('wrapUrlPayload produces the canonical single-quoted form', () => {
    expect(wrapUrlPayload('/hero.png')).toBe("url('/hero.png')")
    expect(wrapUrlPayload('')).toBe('')
    expect(wrapUrlPayload("'/hero.png'")).toBe("url('/hero.png')")
  })
})
