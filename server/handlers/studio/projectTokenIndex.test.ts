import { describe, expect, it } from 'bun:test'
import { buildProjectTokenIndex, nearestSizeToken, rgbToHex } from './projectTokenIndex'

/** A trimmed slice of the shape `@alm-design/design-system` actually ships. */
const ALM_CSS = `
:root{--color-aqua-100:#0c9ab0;--color-coral-100:#ef4550;--color-metal:#1c1c1c;--color-light:#fff}
:root{
  --font-display: 'Open Sans', system-ui, sans-serif;
  --type-display-size: 34px;
  --type-headline-family: var(--font-display);
  --type-headline-size: 26px;
  --type-headline-lh: 40px;
  --type-title-size: 18px;
  --type-subtitle-size: 16px;
  --type-body-size: 14px;
  --type-caption-size: 12px;
  --rounded: 8px;
  --space: 16px;
}
`

describe('buildProjectTokenIndex', () => {
  it('indexes colour tokens as normalised hex', () => {
    const index = buildProjectTokenIndex(ALM_CSS)
    const aqua = index.colors.find((c) => c.name === '--color-aqua-100')
    expect(aqua?.hex).toBe('#0c9ab0')
    // Shorthand expands, so `#fff` and `#ffffff` compare as one colour.
    expect(index.colors.find((c) => c.name === '--color-light')?.hex).toBe('#ffffff')
  })

  it('separates type sizes from other px lengths', () => {
    const index = buildProjectTokenIndex(ALM_CSS)
    const typeNames = index.fontSizes.map((t) => t.name)
    expect(typeNames).toContain('--type-headline-size')
    expect(typeNames).toContain('--type-body-size')
    // A radius and a spacing step are px-valued too, and offering them as
    // candidate FONT sizes would let a 16px heading match `--space`.
    expect(typeNames).not.toContain('--rounded')
    expect(typeNames).not.toContain('--space')
    expect(index.lengths.map((t) => t.name)).toContain('--space')
  })

  it('does not mistake a line-height or a family for a size', () => {
    const index = buildProjectTokenIndex(ALM_CSS)
    const names = index.fontSizes.map((t) => t.name)
    expect(names).not.toContain('--type-headline-lh')
    expect(names).not.toContain('--type-headline-family')
  })

  it('resolves a one-level var() alias rather than dropping it', () => {
    const index = buildProjectTokenIndex(':root{--base:20px;--type-alias-size:var(--base)}')
    expect(index.fontSizes.find((t) => t.name === '--type-alias-size')?.px).toBe(20)
  })

  it('lets a later source win, the way the cascade does', () => {
    // A project's `styles/imported/` copy of the design system's tokens and
    // the package's own `dist/index.css` both declare the same names.
    const index = buildProjectTokenIndex(':root{--type-body-size:14px}', ':root{--type-body-size:15px}')
    expect(index.fontSizes.find((t) => t.name === '--type-body-size')?.px).toBe(15)
  })

  it('ignores rem, whose px value depends on a root size this index does not know', () => {
    const index = buildProjectTokenIndex(':root{--type-rem-size:1.5rem}')
    expect(index.fontSizes).toHaveLength(0)
  })

  it('returns an empty index for CSS with no custom properties', () => {
    const index = buildProjectTokenIndex('.a{color:red}', '')
    expect(index.colors).toHaveLength(0)
    expect(index.fontSizes).toHaveLength(0)
  })
})

describe('nearestSizeToken', () => {
  const index = buildProjectTokenIndex(ALM_CSS)

  it('picks the closest token and reports a signed error', () => {
    // The real regression: a screen title measured at ~21px. Picking by NAME
    // gives `--type-headline-size` (26px, five too big); picking by VALUE
    // gives `--type-title-size` (18px) — and the +/-3px error is reported so
    // the caller can see that neither token actually covers it.
    const nearest = nearestSizeToken(index.fontSizes, 21)
    expect(nearest?.token.name).toBe('--type-title-size')
    expect(nearest?.deltaPx).toBe(-3)
  })

  it('reports a zero error for an exact hit', () => {
    const nearest = nearestSizeToken(index.fontSizes, 14)
    expect(nearest?.token.name).toBe('--type-body-size')
    expect(nearest?.deltaPx).toBe(0)
  })

  it('returns null only when there are no candidates', () => {
    expect(nearestSizeToken([], 16)).toBeNull()
  })
})

describe('rgbToHex', () => {
  it('pads and clamps', () => {
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(rgbToHex({ r: 300, g: -5, b: 176 })).toBe('#ff00b0')
  })
})
