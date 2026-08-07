import { describe, expect, it } from 'bun:test'
import { auditStylesheetQuality } from './qualityAudit'
import { buildProjectTokenIndex } from './projectTokenIndex'

const TOKENS_CSS = `:root {
  --color-coral-500: #ef4550;
  --color-ink: #1c1c1c;
  --color-paper: #ffffff;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --type-title-size: 18px;
}`

const tokens = buildProjectTokenIndex(TOKENS_CSS)

describe('auditStylesheetQuality', () => {
  it('flags a raw hex colour within perceptual range of a project token', () => {
    const css = `.cta { color: #ffffff; background: #ef4550; }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    const raw = findings.filter((f) => f.code === 'raw-hex-color' && f.selector === '.cta')
    expect(raw.length).toBeGreaterThan(0)
    const coral = raw.find((f) => f.message.includes('#ef4550') || f.suggestedToken?.value === '#ef4550')
    expect(coral).toBeDefined()
    expect(coral!.suggestedToken?.name).toBe('--color-coral-500')
  })

  it('does not flag a value already expressed as var(--token)', () => {
    const css = `.cta { color: var(--color-paper); background: var(--color-coral-500); }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    expect(findings.filter((f) => f.code === 'raw-hex-color')).toEqual([])
  })

  it('flags a raw px length close to a spacing token', () => {
    const css = `.row { padding: 16px; }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    const px = findings.find((f) => f.code === 'raw-px-length')
    expect(px).toBeDefined()
    expect(px!.suggestedToken?.name).toBe('--spacing-md')
  })

  it('reports a raw px length with no exact token match, without inventing one', () => {
    const css = `.row { padding: 13px; }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    const px = findings.find((f) => f.code === 'raw-px-length')
    expect(px).toBeDefined()
    expect(px!.suggestedToken).toBeUndefined()
    expect(px!.message).toContain('--spacing-md')
  })

  it('flags a same-rule color/background pair that fails WCAG AA contrast', () => {
    // Light grey text on white — a classic low-contrast mistake.
    const css = `.hint { color: #cccccc; background: #ffffff; }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    const contrast = findings.find((f) => f.code === 'low-contrast-pair')
    expect(contrast).toBeDefined()
    expect(contrast!.message).toContain('WCAG AA')
  })

  it('does not flag a color/background pair with healthy contrast', () => {
    const css = `.body { color: #1c1c1c; background: #ffffff; }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    expect(findings.filter((f) => f.code === 'low-contrast-pair')).toEqual([])
  })

  it('resolves color/background contrast through var(--token) references, not only raw hex', () => {
    const css = `.hint { color: var(--color-paper); background: var(--color-paper); }`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    // Identical colour on identical colour — the worst possible contrast (1:1) — must still be caught even though neither side is a raw hex literal.
    const contrast = findings.find((f) => f.code === 'low-contrast-pair')
    expect(contrast).toBeDefined()
  })

  it('reports a file:line for every finding', () => {
    const css = `.a { color: #ffffff; }\n\n.cta {\n  color: #ffffff;\n  background: #ef4550;\n}`
    const { findings } = auditStylesheetQuality(css, 'src/screens/Home.module.css', tokens)
    for (const finding of findings) {
      expect(finding.file).toBe('src/screens/Home.module.css')
      expect(finding.line).toBeGreaterThan(0)
    }
  })

  it('never throws on malformed CSS text', () => {
    expect(() => auditStylesheetQuality('this is not { valid css at all', 'x.css', tokens)).not.toThrow()
    expect(() => auditStylesheetQuality('', 'x.css', tokens)).not.toThrow()
  })
})
