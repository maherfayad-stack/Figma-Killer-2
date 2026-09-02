/**
 * tokenExtractScss.ts — T6 (`STUDIO-FIGMA-PARITY-PLAN.md` §11): a Sass
 * design system authored purely in `$variables` used to yield ZERO tokens.
 */
import { describe, expect, it } from 'bun:test'
import { extractScssVariableTokens } from '../tokenExtractScss'

describe('extractScssVariableTokens', () => {
  it('reads top-level $variable declarations and classifies them value-first', () => {
    const scss = `
      $color-brand: #0c9ab0;
      $space-md: 16px;
      $type-title-size: 18px;
    `
    const tokens = extractScssVariableTokens(scss)
    expect(tokens.colors).toEqual([{ name: '$color-brand', light: '#0c9ab0' }])
    expect(tokens.spacing).toEqual([{ name: '$space-md', px: 16 }])
    expect(tokens.typographySizes).toEqual([{ name: '$type-title-size', px: 18 }])
  })

  it('ignores a $variable declared inside a mixin/nested rule — local, not a design token', () => {
    const scss = `
      @mixin button {
        $local-padding: 8px;
        padding: $local-padding;
      }
      $space-md: 16px;
    `
    const tokens = extractScssVariableTokens(scss)
    expect(tokens.spacing.map((s) => s.name)).toEqual(['$space-md'])
  })

  it('counts (does not guess) a value that references another variable or interpolates', () => {
    const scss = `
      $space-base: 16px;
      $space-derived: $space-base * 2;
      $space-interpolated: #{$space-base};
    `
    const tokens = extractScssVariableTokens(scss)
    // The plain literal still classifies normally — only the two values that
    // actually reference `$space-base` (a real design-token-shaped NAME, so
    // a bare `#` inside a resolved hex value is never mistaken for this) are
    // rejected as unresolvable.
    expect(tokens.spacing).toEqual([{ name: '$space-base', px: 16 }])
    expect(tokens.unclassifiedCount).toBe(2)
  })

  it('strips // and /* */ comments before scanning', () => {
    const scss = `
      // $fake: red;
      /* $also-fake: blue; */
      $color-real: #ef4550;
    `
    const tokens = extractScssVariableTokens(scss)
    expect(tokens.colors).toEqual([{ name: '$color-real', light: '#ef4550' }])
  })

  it('returns an empty result for CSS with no $variables', () => {
    expect(extractScssVariableTokens('.a { color: red; }').colors).toHaveLength(0)
    expect(extractScssVariableTokens('').colors).toHaveLength(0)
  })
})
