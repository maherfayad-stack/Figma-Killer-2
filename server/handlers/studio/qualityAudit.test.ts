import { describe, expect, it } from 'bun:test'
import { auditPageSourceQuality, auditStylesheetQuality } from './qualityAudit'
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

describe('auditPageSourceQuality', () => {
  it('flags a literal <svg><path d="…"> as hand-authored, and never a raw-import icon', () => {
    const tsx = [
      "import { ChevronLeftIcon } from '@acme/ds'",
      "import smsIconSvg from '@acme/ds/icons/sms.svg?raw'",
      'export default function Screen() {',
      '  return (',
      '    <>',
      '      <ChevronLeftIcon />',
      '      <span dangerouslySetInnerHTML={{ __html: smsIconSvg }} />',
      '      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">',
      '        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47" />',
      '      </svg>',
      '    </>',
      '  )',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    const vector = findings.filter((f) => f.code === 'hand-authored-vector-path')
    expect(vector).toHaveLength(1)
    expect(vector[0]!.file).toBe('pages/Screen.tsx')
    expect(vector[0]!.line).toBeGreaterThan(0)
  })

  it('flags a ?raw import whose file is not on disk', () => {
    const tsx = [
      "import chartIcon from '@pkg/icons/chartLineDown.svg?raw'",
      'export default function Screen() {',
      '  return <span className="icon" dangerouslySetInnerHTML={{ __html: chartIcon }} />',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [], [
      { specifier: '@pkg/icons/chartLineDown.svg?raw', localName: 'chartIcon', line: 1 },
    ])
    const dead = findings.filter((f) => f.code === 'unresolved-asset-import')
    expect(dead).toHaveLength(1)
    expect(dead[0]!.line).toBe(1)
    expect(dead[0]!.selector).toBe('chartIcon')
    expect(dead[0]!.message).toContain('chartLineDown.svg?raw')
  })

  it('reports nothing about imports when every asset import resolves', () => {
    const tsx = [
      "import smsIcon from '@pkg/icons/sms.svg?raw'",
      'export default function Screen() {',
      '  return <span dangerouslySetInnerHTML={{ __html: smsIcon }} />',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [], [])
    expect(findings.filter((f) => f.code === 'unresolved-asset-import')).toHaveLength(0)
  })

  it('flags multiple hand-drawn <path> elements inside one <svg> as a single finding', () => {
    const tsx = [
      'export default function Screen() {',
      '  return (',
      '    <svg viewBox="0 0 24 24" aria-hidden="true">',
      '      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12" />',
      '      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66" />',
      '    </svg>',
      '  )',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    const vector = findings.filter((f) => f.code === 'hand-authored-vector-path')
    expect(vector).toHaveLength(1)
    expect(vector[0]!.message).toContain('2 hand-written')
  })

  it('flags a literal number/px value hardcoding layout inline', () => {
    const tsx = [
      "import styles from './Screen.module.css'",
      'export default function Screen() {',
      '  return <span className={styles.icon} style={{ width: 24, height: \'24px\' }} />',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    const sizing = findings.filter((f) => f.code === 'hardcoded-inline-sizing')
    expect(sizing).toHaveLength(2)
    expect(sizing.every((f) => f.file === 'pages/Screen.tsx' && f.line > 0)).toBe(true)
  })

  it('does not flag a CSS-custom-property style object or a genuinely dynamic value', () => {
    const tsx = [
      'export default function Screen({ progress, computedWidth }: { progress: number; computedWidth: number }) {',
      '  return (',
      '    <>',
      "      <div style={{ '--progress': `${progress}%` }} />",
      '      <div style={{ width: computedWidth }} />',
      '    </>',
      '  )',
      '}',
      '',
    ].join('\n')
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    expect(findings.filter((f) => f.code === 'hardcoded-inline-sizing')).toEqual([])
  })

  it('does not flag a hardcoded non-layout style value (e.g. opacity)', () => {
    const tsx = "export default function Screen() { return <div style={{ opacity: 0.5 }} /> }\n"
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    expect(findings.filter((f) => f.code === 'hardcoded-inline-sizing')).toEqual([])
  })

  it('flags a page that imports nothing from the configured design system', () => {
    const tsx = "export default function Screen() { return <div>Hi</div> }\n"
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', ['@acme/ds'])
    expect(findings.some((f) => f.code === 'design-system-unused')).toBe(true)
  })

  it('does not flag design-system-unused when the page imports the package, even via a subpath', () => {
    const tsx = "import '@acme/ds/dist/index.css'\nexport default function Screen() { return <div>Hi</div> }\n"
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', ['@acme/ds'])
    expect(findings.filter((f) => f.code === 'design-system-unused')).toEqual([])
  })

  it('does not flag design-system-unused when no design system is configured', () => {
    const tsx = "export default function Screen() { return <div>Hi</div> }\n"
    const { findings } = auditPageSourceQuality(tsx, 'pages/Screen.tsx', [])
    expect(findings.filter((f) => f.code === 'design-system-unused')).toEqual([])
  })

  it('never throws on malformed .tsx text', () => {
    expect(() => auditPageSourceQuality('this is not { valid tsx at all <svg', 'x.tsx', [])).not.toThrow()
    expect(() => auditPageSourceQuality('', 'x.tsx', [])).not.toThrow()
  })
})
