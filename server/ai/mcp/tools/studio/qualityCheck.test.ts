/**
 * `studio_quality_check` — handler coverage against a real temp project
 * directory. The scoring itself is exercised in
 * `server/handlers/studio/qualityAudit.test.ts`; this proves the tool wires
 * page resolution -> stylesheet discovery -> the audit correctly, end to end,
 * plus the plural-page batching (mcp-tooling CHANGE A).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioQualityCheckMcpTools } from './qualityCheck'

function tool(name: string) {
  const t = studioQualityCheckMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

interface PageResult {
  ok: boolean
  page: { id: string; title: string }
  filesScanned: string[]
  findings: Array<{ code: string; file: string; line: number }>
  findingCount: number
  note?: string
  error?: string
}

describe('studio_quality_check', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-quality-check-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is not mutating and needs no requiredCapabilities (a headless read)', () => {
    expect(tool('studio_quality_check').mutates).toBeFalsy()
    expect(tool('studio_quality_check').requiredCapabilities ?? []).toEqual([])
  })

  it('flags a raw hex colour and a low-contrast pair in the screen\'s own stylesheet', async () => {
    write(
      dir,
      'pages/Checkout.tsx',
      [
        "import styles from './Checkout.module.css'",
        'export default function Checkout() {',
        '  return <div className={styles.hint}>Almost done</div>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      dir,
      'pages/Checkout.module.css',
      [
        '.hint {',
        '  color: #cccccc;',
        '  background: #ffffff;',
        '}',
      ].join('\n'),
    )

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Checkout'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const page = result.results[0]!
    expect(page.filesScanned).toContain('pages/Checkout.module.css')
    expect(page.findings.some((f) => f.code === 'low-contrast-pair')).toBe(true)
    expect(page.findings.every((f) => f.file === 'pages/Checkout.module.css' && f.line > 0)).toBe(true)
  })

  it('still scans the page source (finding nothing) when the page imports no stylesheet', async () => {
    write(
      dir,
      'pages/Bare.tsx',
      ['export default function Bare() {', '  return <div>Nothing here</div>', '}', ''].join('\n'),
    )

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Bare'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const page = result.results[0]!
    // No stylesheet, but the .tsx itself was still read and scanned.
    expect(page.filesScanned).toEqual(['pages/Bare.tsx'])
    expect(page.findings).toEqual([])
    expect(page.note).toBeDefined()
  })

  it('flags a hand-authored <svg><path> in the page source', async () => {
    write(
      dir,
      'pages/Social.tsx',
      [
        'export default function Social() {',
        '  return (',
        '    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">',
        '      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47" />',
        '    </svg>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Social'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const page = result.results[0]!
    const finding = page.findings.find((f) => f.code === 'hand-authored-vector-path')
    expect(finding).toBeDefined()
    expect(finding!.file).toBe('pages/Social.tsx')
    expect(finding!.line).toBeGreaterThan(0)
  })

  it('flags a hardcoded inline sizing patch but not a dynamic custom-property style', async () => {
    write(
      dir,
      'pages/Sized.tsx',
      [
        "import styles from './Sized.module.css'",
        'export default function Sized({ progress }: { progress: number }) {',
        '  return (',
        '    <div>',
        '      <span className={styles.icon} style={{ width: 24, height: 24 }} />',
        "      <div className={styles.bar} style={{ '--progress': `${progress}%` }} />",
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write(dir, 'pages/Sized.module.css', '.icon {}\n.bar {}\n')

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Sized'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const page = result.results[0]!
    const sizing = page.findings.filter((f) => f.code === 'hardcoded-inline-sizing')
    expect(sizing).toHaveLength(2)
    expect(sizing.every((f) => f.file === 'pages/Sized.tsx')).toBe(true)
  })

  it('flags a page that imports nothing from an installed, detectable design system', async () => {
    write(dir, 'package.json', JSON.stringify({ dependencies: { 'acme-ui': '1.0.0' } }))
    write(dir, 'node_modules/acme-ui/package.json', JSON.stringify({ name: 'acme-ui', version: '1.0.0', types: 'index.d.ts' }))
    write(dir, 'node_modules/acme-ui/index.d.ts', 'export declare const Button: React.FC<{ label: string }>;\n')
    write(
      dir,
      'pages/Plain.tsx',
      ['export default function Plain() {', '  return <div>Hello</div>', '}', ''].join('\n'),
    )
    write(
      dir,
      'pages/Adopted.tsx',
      ["import { Button } from 'acme-ui'", 'export default function Adopted() {', '  return <Button label="Go" />', '}', ''].join('\n'),
    )

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Plain', 'Adopted'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const plain = result.results.find((r) => r.page.title === 'Plain')!
    const adopted = result.results.find((r) => r.page.title === 'Adopted')!
    expect(plain.findings.some((f) => f.code === 'design-system-unused')).toBe(true)
    expect(adopted.findings.filter((f) => f.code === 'design-system-unused')).toEqual([])
  })

  it('does not flag design-system-unused when the project has no component package installed', async () => {
    write(
      dir,
      'pages/Plain.tsx',
      ['export default function Plain() {', '  return <div>Hello</div>', '}', ''].join('\n'),
    )

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Plain'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    const page = result.results[0]!
    expect(page.findings.filter((f) => f.code === 'design-system-unused')).toEqual([])
  })

  it('errors clearly when no screen matches the name', async () => {
    write(dir, 'pages/Home.tsx', ['export default function Home() { return <div /> }', ''].join('\n'))

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['DoesNotExist'] },
      {} as never,
    )) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('DoesNotExist')
  })

  it('omitting pages audits every screen in the project in one call', async () => {
    write(dir, 'pages/Home.tsx', ['export default function Home() { return <div /> }', ''].join('\n'))
    write(dir, 'pages/About.tsx', ['export default function About() { return <div /> }', ''].join('\n'))

    const result = (await tool('studio_quality_check').handler!({ dir }, {} as never)) as {
      ok: boolean
      results: PageResult[]
    }
    expect(result.ok).toBe(true)
    expect(result.results.map((r) => r.page.title).sort()).toEqual(['About', 'Home'])
  })

  it('audits several named screens in one call, sharing the project-wide token index across all of them', async () => {
    write(
      dir,
      'pages/Checkout.tsx',
      ["import styles from './Checkout.module.css'", 'export default function Checkout() {', '  return <div className={styles.hint}>Hi</div>', '}', ''].join('\n'),
    )
    write(dir, 'pages/Checkout.module.css', '.hint { color: #cccccc; background: #ffffff; }\n')
    write(dir, 'pages/Bare.tsx', ['export default function Bare() {', '  return <div>Nothing here</div>', '}', ''].join('\n'))

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Checkout', 'Bare'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[] }

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    const checkout = result.results.find((r) => r.page.title === 'Checkout')!
    const bare = result.results.find((r) => r.page.title === 'Bare')!
    expect(checkout.findings.some((f) => f.code === 'low-contrast-pair')).toBe(true)
    expect(bare.findings).toEqual([])
  })

  it('a name that matches no screen lands in unmatched, not results, and does not fail the other pages in the batch', async () => {
    write(dir, 'pages/Home.tsx', ['export default function Home() { return <div /> }', ''].join('\n'))

    const result = (await tool('studio_quality_check').handler!(
      { dir, pages: ['Home', 'DoesNotExist'] },
      {} as never,
    )) as { ok: boolean; results: PageResult[]; unmatched?: string[] }

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.unmatched).toEqual(['DoesNotExist'])
  })
})
