import { describe, expect, it } from 'bun:test'
import { auditCompositionQuality, COMPOSITION_RULES, LAYOUT_ARCHETYPES } from './compositionAudit'
import { buildProjectTokenIndex } from './projectTokenIndex'

const COMPOSITION_TOKENS_CSS = `:root {
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --type-body-size: 16px;
  --type-title-size: 24px;
  --type-display-size: 40px;
}`
const compTokens = buildProjectTokenIndex(COMPOSITION_TOKENS_CSS)

function sheet(cssText: string, relFile = 'pages/Screen.module.css') {
  return [{ relFile, cssText }]
}

describe('auditCompositionQuality — off-scale-spacing', () => {
  it('flags padding/margin/gap values off the project’s own spacing step', () => {
    const css = `.a{padding:8px}.b{margin:16px}.c{gap:24px}.d{padding:13px}.e{gap:4px}.f{margin:8px}.g{padding:7px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    const finding = findings.find((f) => f.code === 'off-scale-spacing')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('2 of 7')
    expect(finding!.message).toContain('multiples of 4px')
    expect(finding!.message).toContain('13px')
    expect(finding!.message).toContain('7px')
  })

  it('reports exactly one aggregate finding, not one per offending declaration', () => {
    const css = `.a{padding:8px}.b{margin:16px}.c{gap:24px}.d{padding:13px}.e{gap:7px}.f{margin:9px}.g{padding:11px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'off-scale-spacing')).toHaveLength(1)
  })

  it('checks each value of a shorthand', () => {
    const css = `.a{padding:8px 13px}.b{margin:16px}.c{gap:24px}.d{padding:4px}.e{gap:8px}.f{margin:16px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.find((f) => f.code === 'off-scale-spacing')!.message).toContain('13px')
  })

  it('does not run against a project that declares no spacing tokens', () => {
    const bare = buildProjectTokenIndex(':root{--color-ink:#111}')
    const css = `.a{padding:13px}.b{margin:7px}.c{gap:9px}.d{padding:11px}.e{gap:3px}.f{margin:5px}`
    const { findings } = auditCompositionQuality(sheet(css), bare)
    expect(findings.filter((f) => f.code === 'off-scale-spacing')).toEqual([])
  })

  it('does not run on too few samples to be a rhythm', () => {
    const css = `.a{padding:13px}.b{margin:7px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'off-scale-spacing')).toEqual([])
  })

  it('detects an 8px step when the project’s scale is built on one', () => {
    const eight = buildProjectTokenIndex(':root{--spacing-sm:8px;--spacing-md:16px;--spacing-lg:24px}')
    const css = `.a{padding:8px}.b{margin:16px}.c{gap:24px}.d{padding:12px}.e{gap:8px}.f{margin:16px}`
    const { findings } = auditCompositionQuality(sheet(css), eight)
    const finding = findings.find((f) => f.code === 'off-scale-spacing')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('multiples of 8px')
    expect(finding!.message).toContain('12px')
  })
})

describe('auditCompositionQuality — off-scale-type-size', () => {
  it('flags a font-size on no step of the project’s type scale', () => {
    const css = `.a{font-size:16px}.b{font-size:24px}.c{font-size:15px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    const finding = findings.find((f) => f.code === 'off-scale-type-size')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('1 of 3')
    expect(finding!.message).toContain('15px')
  })

  it('does not flag sizes written as var(--token)', () => {
    const css = `.a{font-size:var(--type-body-size)}.b{font-size:var(--type-title-size)}.c{font-size:var(--type-display-size)}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'off-scale-type-size')).toEqual([])
  })

  it('does not run against a project with no type tokens', () => {
    const bare = buildProjectTokenIndex(':root{--spacing-md:16px}')
    const css = `.a{font-size:15px}.b{font-size:17px}.c{font-size:19px}`
    const { findings } = auditCompositionQuality(sheet(css), bare)
    expect(findings.filter((f) => f.code === 'off-scale-type-size')).toEqual([])
  })
})

describe('auditCompositionQuality — flat-type-hierarchy', () => {
  it('flags a screen whose largest type barely exceeds its body size', () => {
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:24px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    const finding = findings.find((f) => f.code === 'flat-type-hierarchy')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('24px')
    expect(finding!.message).toContain('16px')
    expect(finding!.message).toContain('1.5')
  })

  it('does not flag a screen with a real hierarchy', () => {
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:40px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'flat-type-hierarchy')).toEqual([])
  })

  it('measures the hierarchy across every stylesheet the page imports, not one', () => {
    const sheets = [
      { relFile: 'pages/Screen.module.css', cssText: `.a{font-size:16px}.b{font-size:16px}` },
      { relFile: 'components/Hero.module.css', cssText: `.h{font-size:40px}` },
    ]
    const { findings } = auditCompositionQuality(sheets, compTokens)
    expect(findings.filter((f) => f.code === 'flat-type-hierarchy')).toEqual([])
  })

  it('resolves a var(--token) font-size through the project token index', () => {
    const css = `.a{font-size:var(--type-body-size)}.b{font-size:var(--type-body-size)}.c{font-size:var(--type-title-size)}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.some((f) => f.code === 'flat-type-hierarchy')).toBe(true)
  })

  it('does not run on fewer than three type samples', () => {
    const css = `.a{font-size:16px}.b{font-size:17px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'flat-type-hierarchy')).toEqual([])
  })

  it('never throws on malformed CSS', () => {
    expect(() => auditCompositionQuality(sheet('.a{ padding: ; } .b {'), compTokens)).not.toThrow()
    expect(() => auditCompositionQuality([], compTokens)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// A13 — composition archetypes and the two findings that grade "designed"
// ---------------------------------------------------------------------------

describe('auditCompositionQuality — no-focal-point', () => {
  it('flags a screen with a real scale but only two type sizes in use', () => {
    // 16 / 16 / 40 is a ratio of 2.5, so `flat-type-hierarchy` is silent —
    // and yet there is a body size and one heading and nothing in between.
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:40px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    const finding = findings.find((f) => f.code === 'no-focal-point')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('2 distinct type sizes')
  })

  it('flags a "hero" size that is set on so many rules it is a body style', () => {
    // Body still dominates (three 16px rules), so the scale reads fine at
    // 40/16 = 2.5 — but the "hero" size is on three separate rules, which
    // makes it a repeated style rather than the one thing that leads.
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:16px}.d{font-size:24px}.e{font-size:40px}.f{font-size:40px}.g{font-size:40px}`
    const finding = auditCompositionQuality(sheet(css), compTokens).findings.find((f) => f.code === 'no-focal-point')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('set on 3 rules')
  })

  it('flags a top-two gap too small to pick an entry point from', () => {
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:36px}.d{font-size:40px}`
    const finding = auditCompositionQuality(sheet(css), compTokens).findings.find((f) => f.code === 'no-focal-point')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('top two sizes are 40px and 36px')
  })

  it('stays silent on a screen with three well-separated steps and one hero', () => {
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:24px}.d{font-size:40px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'no-focal-point')).toEqual([])
  })

  it('never double-reports with flat-type-hierarchy — a screen with no scale is one problem', () => {
    const css = `.a{font-size:16px}.b{font-size:16px}.c{font-size:20px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.some((f) => f.code === 'flat-type-hierarchy')).toBe(true)
    expect(findings.filter((f) => f.code === 'no-focal-point')).toEqual([])
  })
})

describe('auditCompositionQuality — monotone-band-rhythm', () => {
  it('flags a screen where every gap is the same value', () => {
    const css = `.a{padding:16px}.b{margin:16px}.c{gap:16px}.d{padding:16px}.e{gap:16px}.f{margin:16px}`
    const finding = auditCompositionQuality(sheet(css), compTokens).findings.find((f) => f.code === 'monotone-band-rhythm')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('every padding, margin and gap on the screen is 16px')
  })

  it('flags a screen whose largest gap is under one step above its inner rhythm', () => {
    // Inner rhythm 16px, project base 4px: an 18px largest is a 2px
    // difference, under the one step that would separate a band.
    const css = `.a{padding:16px}.b{margin:16px}.c{gap:16px}.d{padding:18px}.e{gap:16px}.f{margin:16px}`
    const finding = auditCompositionQuality(sheet(css), compTokens).findings.find((f) => f.code === 'monotone-band-rhythm')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('largest gap is 18px')
  })

  it('stays silent when bands are genuinely separated', () => {
    const css = `.a{padding:8px}.b{margin:8px}.c{gap:8px}.d{padding:32px}.e{gap:8px}.f{margin:8px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'monotone-band-rhythm')).toEqual([])
  })

  it('does not run on too few samples to be a rhythm', () => {
    const css = `.a{padding:16px}.b{margin:16px}`
    const { findings } = auditCompositionQuality(sheet(css), compTokens)
    expect(findings.filter((f) => f.code === 'monotone-band-rhythm')).toEqual([])
  })

  it('runs for a project that declares no spacing tokens — band rhythm needs no scale to measure against', () => {
    const bare = buildProjectTokenIndex(':root{--color-ink:#111}')
    const css = `.a{padding:15px}.b{margin:15px}.c{gap:15px}.d{padding:15px}.e{gap:15px}.f{margin:15px}`
    const { findings } = auditCompositionQuality(sheet(css), bare)
    expect(findings.some((f) => f.code === 'monotone-band-rhythm')).toBe(true)
    // ...and the off-scale rule still stands down, because there is no scale.
    expect(findings.filter((f) => f.code === 'off-scale-spacing')).toEqual([])
  })
})

describe('LAYOUT_ARCHETYPES', () => {
  it('offers enough distinct shapes for three variants to differ structurally', () => {
    expect(LAYOUT_ARCHETYPES.length).toBeGreaterThanOrEqual(6)
    expect(new Set(LAYOUT_ARCHETYPES.map((a) => a.id)).size).toBe(LAYOUT_ARCHETYPES.length)
  })

  it('every archetype brief stands alone — a subagent sees only the text it is handed', () => {
    for (const archetype of LAYOUT_ARCHETYPES) {
      expect(archetype.brief.length).toBeGreaterThan(80)
      expect(archetype.brief).not.toContain('as discussed')
    }
  })

  it('every composition rule a finding grades names that finding', () => {
    const graded = COMPOSITION_RULES.filter((rule) => rule.includes('(graded:'))
    expect(graded.length).toBeGreaterThanOrEqual(3)
    expect(COMPOSITION_RULES.join(' ')).toContain('monotone-band-rhythm')
    expect(COMPOSITION_RULES.join(' ')).toContain('no-focal-point')
    expect(COMPOSITION_RULES.join(' ')).toContain('low-contrast-pair')
  })
})
