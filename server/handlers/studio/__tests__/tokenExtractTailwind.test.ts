/**
 * tokenExtractTailwind.ts — T6 (`STUDIO-FIGMA-PARITY-PLAN.md` §11): a
 * project that REPLACES `theme.colors` (no `extend` wrapper for that key)
 * used to yield zero colour tokens the instant the same config also had an
 * unrelated `extend` block for another key, because the old code picked
 * `extend` OR `theme` for the whole scan, never both. `fontFamily` was not
 * read at all.
 */
import { describe, expect, it } from 'bun:test'
import { extractTailwindThemeTokens } from '../tokenExtractTailwind'

describe('extractTailwindThemeTokens — theme.extend (the common case, must not regress)', () => {
  it('reads colors/spacing/fontSize from theme.extend', () => {
    const config = `
      module.exports = {
        theme: {
          extend: {
            colors: { brand: '#0c9ab0' },
            spacing: { md: '16px' },
            fontSize: { lg: '20px' },
          },
        },
      }
    `
    const tokens = extractTailwindThemeTokens(config)
    expect(tokens.colors).toEqual([{ name: '--brand', light: '#0c9ab0' }])
    expect(tokens.spacing).toEqual([{ name: '--space-md', px: 16 }])
    expect(tokens.typographySizes).toEqual([{ name: '--text-lg', px: 20 }])
  })
})

describe('extractTailwindThemeTokens — theme.colors REPLACE form (T6 gap)', () => {
  it('reads colors declared directly under theme, with no extend block anywhere in the config', () => {
    const config = `module.exports = { theme: { colors: { brand: '#0c9ab0' } } }`
    const tokens = extractTailwindThemeTokens(config)
    expect(tokens.colors).toEqual([{ name: '--brand', light: '#0c9ab0' }])
  })

  it('reads a replace-style theme.colors even when the SAME config has an unrelated theme.extend for a different key — the actual regression', () => {
    const config = `
      module.exports = {
        theme: {
          colors: { brand: '#0c9ab0' },
          extend: { spacing: { md: '16px' } },
        },
      }
    `
    const tokens = extractTailwindThemeTokens(config)
    expect(tokens.colors).toEqual([{ name: '--brand', light: '#0c9ab0' }])
    expect(tokens.spacing).toEqual([{ name: '--space-md', px: 16 }])
  })

  it('merges a direct theme.colors with theme.extend.colors, extend winning on a name collision (Tailwind\'s own semantic)', () => {
    const config = `
      module.exports = {
        theme: {
          colors: { brand: '#0c9ab0', accent: '#ef4550' },
          extend: { colors: { brand: '#111111' } },
        },
      }
    `
    const tokens = extractTailwindThemeTokens(config)
    const byName = new Map(tokens.colors.map((c) => [c.name, c.light]))
    expect(byName.get('--brand')).toBe('#111111') // extend overrides
    expect(byName.get('--accent')).toBe('#ef4550') // direct-only key survives
  })
})

describe('extractTailwindThemeTokens — fontFamily (T6 gap)', () => {
  it('counts a discovered fontFamily entry as a typography-detail (no field to hold it yet — honest count, not silence)', () => {
    const config = `
      module.exports = {
        theme: {
          extend: {
            fontFamily: { sans: ['Inter', 'system-ui'], mono: ['Menlo'] },
          },
        },
      }
    `
    const tokens = extractTailwindThemeTokens(config)
    expect(tokens.typographyDetailCount).toBe(2)
  })
})
