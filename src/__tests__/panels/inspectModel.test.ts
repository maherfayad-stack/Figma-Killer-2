import { describe, expect, it } from 'bun:test'
import {
  buildInspectModel,
  canonicalColorKey,
  findMatchingColorToken,
  parseCssColor,
  rgbaToHex,
  type ComputedStyleSnapshot,
} from '@site/panels/InspectPanel/inspectModel'

function snapshot(overrides: Partial<ComputedStyleSnapshot> = {}): ComputedStyleSnapshot {
  return {
    color: 'rgb(37, 99, 235)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopColor: 'rgb(0, 0, 0)',
    borderRightColor: 'rgb(0, 0, 0)',
    borderBottomColor: 'rgb(0, 0, 0)',
    borderLeftColor: 'rgb(0, 0, 0)',
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    borderTopStyle: 'none',
    borderRightStyle: 'none',
    borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    fontFamily: 'Inter, sans-serif',
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: '24px',
    letterSpacing: 'normal',
    width: '200px',
    height: '100px',
    marginTop: '0px',
    marginRight: '0px',
    marginBottom: '0px',
    marginLeft: '0px',
    paddingTop: '8px',
    paddingRight: '8px',
    paddingBottom: '8px',
    paddingLeft: '8px',
    ...overrides,
  }
}

describe('parseCssColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseCssColor('#2563eb')).toEqual({ r: 37, g: 99, b: 235, a: 1 })
  })

  it('parses 3-digit hex', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('parses 8-digit hex with alpha', () => {
    const parsed = parseCssColor('#2563eb80')
    expect(parsed?.r).toBe(37)
    expect(parsed?.g).toBe(99)
    expect(parsed?.b).toBe(235)
    expect(parsed?.a).toBeCloseTo(0.5, 2)
  })

  it('parses rgb()', () => {
    expect(parseCssColor('rgb(37, 99, 235)')).toEqual({ r: 37, g: 99, b: 235, a: 1 })
  })

  it('parses rgba()', () => {
    expect(parseCssColor('rgba(37, 99, 235, 0.5)')).toEqual({ r: 37, g: 99, b: 235, a: 0.5 })
  })

  it('parses hsl()', () => {
    const parsed = parseCssColor('hsl(0, 0%, 100%)')
    expect(parsed).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('parses "transparent" as fully transparent black', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('returns null for unparseable input', () => {
    expect(parseCssColor('not-a-color')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

describe('canonicalColorKey', () => {
  it('treats equivalent colors in different formats as equal', () => {
    expect(canonicalColorKey('#2563eb')).toBe(canonicalColorKey('rgb(37, 99, 235)'))
  })

  it('treats different colors as unequal', () => {
    expect(canonicalColorKey('#2563eb')).not.toBe(canonicalColorKey('#000000'))
  })

  it('is alpha-sensitive', () => {
    expect(canonicalColorKey('rgba(0, 0, 0, 1)')).not.toBe(canonicalColorKey('rgba(0, 0, 0, 0.5)'))
  })
})

describe('rgbaToHex', () => {
  it('renders a fully opaque color as 6-digit hex', () => {
    expect(rgbaToHex({ r: 37, g: 99, b: 235, a: 1 })).toBe('#2563eb')
  })

  it('renders a translucent color as 8-digit hex', () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000')
  })
})

describe('findMatchingColorToken', () => {
  const tokens = [
    { name: '--color-primary-500', value: '#2563eb' },
    { name: '--color-neutral-900', value: 'rgb(17, 17, 17)' },
  ]

  it('matches exactly, across formats', () => {
    expect(findMatchingColorToken('rgb(37, 99, 235)', tokens)).toBe('--color-primary-500')
    expect(findMatchingColorToken('#111111', tokens)).toBe('--color-neutral-900')
  })

  it('returns null when nothing matches', () => {
    expect(findMatchingColorToken('#ff00ff', tokens)).toBeNull()
  })

  it('returns null for unparseable computed values', () => {
    expect(findMatchingColorToken('currentcolor', tokens)).toBeNull()
  })
})

describe('buildInspectModel', () => {
  it('emits text + background swatches, and resolves a matching token name', () => {
    const tokens = [{ name: '--color-primary-500', value: '#2563eb' }]
    const model = buildInspectModel(snapshot(), tokens)

    const text = model.colors.find((c) => c.property === 'color')
    expect(text?.value.tokenName).toBe('--color-primary-500')
    expect(text?.value.hex).toBe('#2563eb')

    const background = model.colors.find((c) => c.property === 'background-color')
    expect(background?.value.raw).toBe('rgba(0, 0, 0, 0)')
    expect(background?.value.tokenName).toBeNull()
  })

  it('omits border swatches when no border is actually rendered', () => {
    const model = buildInspectModel(snapshot())
    expect(model.colors.some((c) => c.property.startsWith('border'))).toBe(false)
  })

  it('collapses four equal visible border sides into one "Border" swatch', () => {
    const model = buildInspectModel(
      snapshot({
        borderTopWidth: '1px',
        borderRightWidth: '1px',
        borderBottomWidth: '1px',
        borderLeftWidth: '1px',
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'solid',
      }),
    )
    const borderSwatches = model.colors.filter((c) => c.property.startsWith('border'))
    expect(borderSwatches).toHaveLength(1)
    expect(borderSwatches[0].property).toBe('border-color')
    expect(borderSwatches[0].label).toBe('Border')
  })

  it('emits one swatch per side when border colors differ', () => {
    const model = buildInspectModel(
      snapshot({
        borderTopWidth: '1px',
        borderTopStyle: 'solid',
        borderTopColor: 'rgb(255, 0, 0)',
        borderLeftWidth: '2px',
        borderLeftStyle: 'solid',
        borderLeftColor: 'rgb(0, 255, 0)',
      }),
    )
    const borderSwatches = model.colors.filter((c) => c.property.startsWith('border'))
    expect(borderSwatches).toHaveLength(2)
    expect(borderSwatches.map((s) => s.property).sort()).toEqual(['border-left-color', 'border-top-color'])
  })

  it('carries typography values through verbatim', () => {
    const model = buildInspectModel(snapshot())
    expect(model.typography).toEqual({
      fontFamily: 'Inter, sans-serif',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '24px',
      letterSpacing: 'normal',
    })
  })

  it('builds the box model from width/height/margin/padding/border-width', () => {
    const model = buildInspectModel(snapshot({ paddingTop: '10px' }))
    expect(model.boxModel.width).toBe('200px')
    expect(model.boxModel.height).toBe('100px')
    expect(model.boxModel.padding).toEqual({ top: '10px', right: '8px', bottom: '8px', left: '8px' })
    expect(model.boxModel.margin).toEqual({ top: '0px', right: '0px', bottom: '0px', left: '0px' })
  })

  it('emits a compact CSS block with only present declarations', () => {
    const model = buildInspectModel(snapshot())
    expect(model.css).toContain('color: rgb(37, 99, 235);')
    expect(model.css).toContain('font-size: 16px;')
    expect(model.css.startsWith('{')).toBe(true)
    expect(model.css.endsWith('}')).toBe(true)
  })
})
