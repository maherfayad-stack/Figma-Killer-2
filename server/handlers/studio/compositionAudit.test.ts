import { describe, expect, it } from 'bun:test'
import { auditCompositionQuality } from './compositionAudit'
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
