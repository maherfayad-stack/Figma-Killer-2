import { describe, expect, it } from 'bun:test'
import { generateVariantSeeds, MAX_VARIANTS_PER_SET, VARIANT_DENSITIES } from './variantSeeds'
import { buildProjectTokenIndex } from './projectTokenIndex'
import { MIN_TYPE_HIERARCHY_RATIO } from './qualityAudit'

const PROJECT_CSS = `:root {
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --radius-sharp: 2px;
  --radius-soft: 6px;
  --radius-round: 16px;
  --radius-pill: 999px;
  --type-body-size: 16px;
  --type-title-size: 26px;
  --type-display-size: 42px;
  --color-brand-coral: #ef4550;
  --color-accent-aqua: #0c9ab0;
  --color-primary-violet: #6b46ff;
  --color-text-muted: #767676;
  --color-surface: #ffffff;
}`

const tokens = buildProjectTokenIndex(PROJECT_CSS)

function seeds(rngSeed = 7, count = 3) {
  return generateVariantSeeds({ tokens, brief: 'A trip search screen.', baseName: 'Home', count, rngSeed })
}

describe('generateVariantSeeds', () => {
  it('names the pages HomeA/HomeB/HomeC', () => {
    expect(seeds().map((v) => v.pageName)).toEqual(['HomeA', 'HomeB', 'HomeC'])
  })

  it('is deterministic for a given rngSeed', () => {
    expect(seeds(42)).toEqual(seeds(42))
  })

  it('produces a different set for a different rngSeed', () => {
    // Over the four varied axes, two different seeds landing identically is
    // possible in principle; across several it is not.
    const a = [1, 2, 3, 4, 5].map((n) => JSON.stringify(seeds(n).map((v) => v.style)))
    expect(new Set(a).size).toBeGreaterThan(1)
  })

  it('assigns each density without replacement', () => {
    const densities = seeds().map((v) => v.style.density)
    expect(new Set(densities).size).toBe(3)
    for (const d of densities) expect(VARIANT_DENSITIES).toContain(d)
  })

  it('assigns each corner family without replacement when the project declares enough radius tokens', () => {
    expect(new Set(seeds().map((v) => v.style.radiusFamily)).size).toBe(3)
  })

  it('assigns a distinct accent token per variant', () => {
    expect(new Set(seeds().map((v) => v.style.accentToken)).size).toBe(3)
  })

  it('only ever picks accent tokens the project actually declares, never a neutral or a state colour', () => {
    for (const variant of seeds()) {
      expect(tokens.colors.some((c) => c.name === variant.style.accentToken)).toBe(true)
      expect(variant.style.accentToken).not.toBe('--color-text-muted')
      expect(variant.style.accentToken).not.toBe('--color-surface')
    }
  })

  it('picks heading sizes from the project’s own type tokens, never a computed px', () => {
    for (const variant of seeds()) {
      expect(tokens.fontSizes.some((t) => t.name === variant.style.headingSizeToken)).toBe(true)
      expect(tokens.fontSizes.some((t) => t.px === variant.style.headingSizePx)).toBe(true)
    }
  })

  it('never proposes a type ratio its own flat-type-hierarchy check would fail', () => {
    for (const variant of seeds()) {
      expect(variant.style.typeScaleRatio).toBeGreaterThanOrEqual(MIN_TYPE_HIERARCHY_RATIO)
    }
  })

  it('keeps every spacing step on the project’s own base', () => {
    for (const variant of seeds()) {
      expect(variant.style.spacingBasePx).toBe(4)
      expect(variant.style.spacingBaseIsFallback).toBe(false)
      expect(variant.style.spacingStepPx % variant.style.spacingBasePx).toBe(0)
    }
  })

  it('marks the spacing base as a fallback when the project declares no spacing tokens', () => {
    const bare = buildProjectTokenIndex(':root{--color-brand:#ef4550;--type-body-size:16px;--type-title-size:32px}')
    const set = generateVariantSeeds({ tokens: bare, brief: 'b', baseName: 'Home', count: 3, rngSeed: 3 })
    for (const variant of set) {
      expect(variant.style.spacingBaseIsFallback).toBe(true)
      expect(variant.directive).toContain('declares no spacing tokens')
    }
  })

  it('degrades honestly against a project with no tokens at all', () => {
    const empty = buildProjectTokenIndex('')
    const set = generateVariantSeeds({ tokens: empty, brief: 'b', baseName: 'Home', count: 3, rngSeed: 3 })
    expect(set).toHaveLength(3)
    for (const variant of set) {
      expect(variant.style.accentToken).toBeUndefined()
      expect(variant.directive).toContain('studio_list_tokens')
    }
  })

  it('caps the count and never returns fewer than one', () => {
    expect(generateVariantSeeds({ tokens, brief: 'b', baseName: 'Home', count: 99, rngSeed: 1 })).toHaveLength(MAX_VARIANTS_PER_SET)
    expect(generateVariantSeeds({ tokens, brief: 'b', baseName: 'Home', count: 0, rngSeed: 1 })).toHaveLength(1)
  })

  it('writes a self-contained directive carrying the brief and every seeded token', () => {
    const [first] = seeds()
    const directive = first!.directive
    expect(directive).toContain('A trip search screen.')
    expect(directive).toContain('HomeA.tsx')
    expect(directive).toContain(`var(${first!.style.accentToken})`)
    expect(directive).toContain(`var(${first!.style.headingSizeToken})`)
    expect(directive).toContain(`var(${first!.style.radiusToken})`)
    expect(directive).toContain('do not change the brief')
  })

  it('reuses a corner family rather than inventing one the project has no token for', () => {
    const oneRadius = buildProjectTokenIndex(':root{--radius-soft:6px;--spacing-sm:8px;--spacing-md:16px;--type-body-size:16px;--type-title-size:32px}')
    const set = generateVariantSeeds({ tokens: oneRadius, brief: 'b', baseName: 'Home', count: 3, rngSeed: 9 })
    expect(new Set(set.map((v) => v.style.radiusFamily))).toEqual(new Set(['soft']))
    for (const variant of set) expect(variant.style.radiusToken).toBe('--radius-soft')
  })
})
