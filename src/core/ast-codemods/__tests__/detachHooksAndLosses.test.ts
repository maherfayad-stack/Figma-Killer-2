/**
 * detachComponentInstance — P5-C: DET-3 (context-reader hooks move into the
 * enclosing component), DET-6 (a literal-only class join is written as its
 * string) and the loss report behind DET-5's pre-commit confirm (`dryRun`,
 * `lossy`, `branchNote`, `movedHooks`, `perRow`).
 *
 * Every refusal asserts that EVERY file in the workspace is byte-identical
 * afterwards, and every dry run asserts the same of a success.
 *
 * The "generic shape" fixtures (arrow components, named exports, `useContext`
 * read directly, a theme context rather than an i18n one, `.tsx` beside the
 * page) deliberately share nothing with the eSIM corpus's habits — the
 * `genericRepoShapes.test.ts` discipline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance, type DetachComponentParams, type DetachRefusalReason, type DetachResult } from '../detachComponent'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detach-hooks-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
}

function snapshotWorkspace(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(full, fs.readFileSync(full, 'latin1'))
    }
  }
  walk(tmpDir)
  return out
}

function detachTag(
  pageRel: string,
  source: string,
  tag: string,
  options: Pick<DetachComponentParams, 'dryRun'> = {},
  occurrence = 1,
): { result: DetachResult; text: string } {
  const file = write(pageRel, source)
  const { line, col } = locateTag(source, tag, occurrence)
  const result = detachComponentInstance({ file, line, col, workspaceRoot: tmpDir, ...options })
  return { result, text: read(pageRel) }
}

function expectRefusedUntouched(pageRel: string, source: string, tag: string, reason: DetachRefusalReason): string {
  const file = write(pageRel, source)
  const before = snapshotWorkspace()
  const { line, col } = locateTag(source, tag)
  const result = detachComponentInstance({ file, line, col, workspaceRoot: tmpDir })
  if (result.ok) throw new Error(`expected a ${reason} refusal, got a success`)
  expect(result.refusal.reason).toBe(reason)
  expect(snapshotWorkspace()).toEqual(before)
  return result.refusal.message
}

const I18N = [
  "import { createContext, useContext } from 'react'",
  "export const LangContext = createContext({ t: { hello: 'Hi' }, lang: 'en' })",
  'export function useLanguage() {',
  '  const ctx = useContext(LangContext)',
  "  if (!ctx) throw new Error('no provider')",
  '  return ctx',
  '}',
  '',
].join('\n')

const GREETING = [
  "import { useLanguage } from '../i18n'",
  'export function Greeting({ name }: { name: string }) {',
  '  const { t } = useLanguage()',
  '  return <h2 className="greeting">{t.hello} {name}</h2>',
  '}',
  '',
].join('\n')

describe('DET-3 — a context reader moves into the enclosing component', () => {
  it('reuses the binding when the page already calls the same hook: nothing is added', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      "import { useLanguage } from '../i18n'",
      'export default function Home() {',
      '  const { t } = useLanguage()',
      '  return (',
      '    <main>',
      '      <p>{t.hello}</p>',
      '      <Greeting name="Ada" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Greeting')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.movedHooks).toEqual([])
    expect(result.lossy).toBe(false)
    expect(text).toBe([
      "import { useLanguage } from '../i18n'",
      'export default function Home() {',
      '  const { t } = useLanguage()',
      '  return (',
      '    <main>',
      '      <p>{t.hello}</p>',
      '      <h2 className="greeting">{t.hello} Ada</h2>',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'))
  })

  it('adds the hook at the top of a component that does not call it, and imports it', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      'export default function Home() {',
      '  const title = "Welcome"',
      '  return (',
      '    <main>',
      '      <h1>{title}</h1>',
      '      <Greeting name="Ada" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Greeting')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.movedHooks).toEqual(['useLanguage'])
    expect(result.lossy).toBe(true)
    expect(text).toContain("import { useLanguage } from '../i18n'")
    expect(text).not.toContain('Greeting')
    expect(text).toContain('export default function Home() {\n  const { t } = useLanguage()\n  const title = "Welcome"\n')
    expect(text).toContain('<h2 className="greeting">{t.hello} Ada</h2>')
  })

  it('adds a missing key to the page\'s own destructure of the same hook', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      "import { useLanguage } from '../i18n'",
      'export default function Home() {',
      '  const { lang } = useLanguage()',
      '  return <main lang={lang}><Greeting name="Ada" /></main>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Greeting')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.movedHooks).toEqual([])
    expect(text).toContain('  const { lang, t } = useLanguage()\n')
    expect(text).toContain('<main lang={lang}><h2 className="greeting">{t.hello} Ada</h2></main>')
    expect(text.match(/useLanguage\(\)/g)).toHaveLength(1)
  })

  it('reads a key off the page\'s whole-value binding of the same hook', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      "import { useLanguage } from '../i18n'",
      'export default function Home() {',
      '  const language = useLanguage()',
      '  return <main lang={language.lang}><Greeting name="Ada" /></main>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Greeting')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('<h2 className="greeting">{language.t.hello} Ada</h2>')
    expect(text.match(/useLanguage\(\)/g)).toHaveLength(1)
  })

  it('names the new binding so it shadows nothing the page already means', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      "const t = 'module-level'",
      'export default function Home() {',
      '  return <main title={t}><Greeting name="Ada" /></main>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Greeting')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('  const { t: t2 } = useLanguage()\n')
    expect(text).toContain('<main title={t}><h2 className="greeting">{t2.hello} Ada</h2></main>')
  })

  it('refuses `uses-hooks`, byte-identical, when the call site is a module-level JSX const', () => {
    write('i18n.tsx', I18N)
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      'const hero = <Greeting name="Ada" />',
      'export default function Home() {',
      '  return <main>{hero}</main>',
      '}',
      '',
    ].join('\n')
    expect(expectRefusedUntouched('pages/Home.tsx', source, 'Greeting', 'uses-hooks')).toContain('not inside a function component')
  })

  it('still refuses `uses-hooks` for a "context" hook that also holds state', () => {
    write('i18n.tsx', [
      "import { createContext, useContext, useState } from 'react'",
      "export const LangContext = createContext({ t: { hello: 'Hi' } })",
      'export function useLanguage() {',
      '  const ctx = useContext(LangContext)',
      '  const [seen] = useState(false)',
      '  return { ...ctx, seen }',
      '}',
      '',
    ].join('\n'))
    write('components/Greeting.tsx', GREETING)
    const source = [
      "import { Greeting } from '../components/Greeting'",
      'export default function Home() {',
      '  return <main><Greeting name="Ada" /></main>',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Greeting', 'uses-hooks')
  })

  it('refuses `uses-hooks` for a context reader handed one of the component\'s own props', () => {
    write('i18n.tsx', [
      "import { createContext, useContext } from 'react'",
      'export const LangContext = createContext({})',
      'export function useSection(section: string) {',
      '  const ctx = useContext(LangContext)',
      '  return ctx',
      '}',
      '',
    ].join('\n'))
    write('components/Section.tsx', [
      "import { useSection } from '../i18n'",
      'export function Section({ id }: { id: string }) {',
      '  const copy = useSection(id)',
      '  return <p>{copy.title}</p>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Section } from '../components/Section'",
      'export default function Home() {',
      '  return <main><Section id="intro" /></main>',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Section', 'uses-hooks')
  })
})

describe('DET-3 — generic shape: arrow components, named exports, useContext read directly (shares nothing with the eSIM corpus)', () => {
  it('moves `useContext(ThemeCtx)` into a concise-bodied arrow page, importing both names', () => {
    write('theme.ts', [
      "import { createContext } from 'react'",
      "export const ThemeCtx = createContext({ accent: 'teal' })",
      '',
    ].join('\n'))
    write('components/Badge.tsx', [
      "import { useContext } from 'react'",
      "import { ThemeCtx } from '../theme'",
      'export const Badge = ({ label }: { label: string }) => {',
      '  const theme = useContext(ThemeCtx)',
      '  return <span style={{ color: theme.accent }}>{label}</span>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Badge } from './components/Badge'",
      'export const Dashboard = () => (',
      '  <section>',
      '    <Badge label="new" />',
      '  </section>',
      ')',
      '',
    ].join('\n')
    const { result, text } = detachTag('Dashboard.tsx', source, 'Badge')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.movedHooks).toEqual(['useContext'])
    expect(text).toContain("import { useContext } from 'react'")
    expect(text).toContain("import { ThemeCtx } from './theme'")
    expect(text).toContain('export const Dashboard = () => {\n  const theme = useContext(ThemeCtx)\n  return (\n')
    expect(text).toContain('<span style={{ color: theme.accent }}>new</span>')
    expect(text.trimEnd().endsWith('}')).toBe(true)
  })
})

describe('DET-6 — a literal-only class join is written as its string', () => {
  /** A fixture's default import of `pkg` — spelled through a template so the no-tailwind-deps gate's literal scan never reads the fixture as a real import. */
  const defaultImport = (local: string, pkg: string) => `import ${local} from '${pkg}'`
  const card = (className: string, imports: string[]): string =>
    [...imports, `export function Card({ tone }: { tone?: string }) {`, `  return <div className={${className}}>Card</div>`, '}', ''].join('\n')
  const page = [
    "import { Card } from '../components/Card'",
    'export default function Home() {',
    '  return <main><Card tone="warm" /></main>',
    '}',
    '',
  ].join('\n')

  it('folds clsx() from the clsx package when every part is a literal', () => {
    write('components/Card.tsx', card("clsx('card', tone)", [defaultImport('clsx', 'clsx')]))
    const { result, text } = detachTag('pages/Home.tsx', page, 'Card')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('<main><div className="card warm">Card</div></main>')
    expect(text).not.toContain('clsx')
  })

  it('drops an omitted part, exactly as clsx does', () => {
    write('components/Card.tsx', card("clsx('card', tone)", [defaultImport('clsx', 'clsx')]))
    const { result, text } = detachTag('pages/Home.tsx', page.replace(' tone="warm"', ''), 'Card')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('<main><div className="card">Card</div></main>')
  })

  it('folds a template literal', () => {
    write('components/Card.tsx', card('`card card--${tone}`', []))
    const { result, text } = detachTag('pages/Home.tsx', page, 'Card')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('<main><div className="card card--warm">Card</div></main>')
  })

  it('never folds `cn` — tailwind-merge may drop a conflicting class', () => {
    write('lib/utils.ts', "export function cn(...parts: string[]) { return parts.join(' ') }\n")
    write('components/Card.tsx', card("cn('card', tone)", ["import { cn } from '../lib/utils'"]))
    const { result, text } = detachTag('pages/Home.tsx', page, 'Card')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain(`className={cn('card', "warm")}`)
    expect(text).toContain("import { cn } from '../lib/utils'")
  })

  it('never folds a part that is a binding — that would bake a resolved value into the JSX', () => {
    write('components/Card.module.css', '.card { color: red; }\n')
    write('components/Card.tsx', card('clsx(styles.card, tone)', [defaultImport('clsx', 'clsx'), "import styles from './Card.module.css'"]))
    const { result, text } = detachTag('pages/Home.tsx', page, 'Card')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(text).toContain('className={clsx(styles.card, "warm")}')
  })
})

describe('the loss report the Detach action asks about first (dryRun)', () => {
  const branchy = [
    'export function Status({ loading }: { loading?: boolean }) {',
    '  if (loading) return <p>Loading</p>',
    '  return <div className="ready">Ready</div>',
    '}',
    '',
  ].join('\n')
  const page = [
    "import { Status } from '../components/Status'",
    'export default function Home() {',
    '  return <main><Status /></main>',
    '}',
    '',
  ].join('\n')

  it("'if-lossy' holds back a detach that drops other rendered states, and writes nothing", () => {
    write('components/Status.tsx', branchy)
    const pageFile = write('pages/Home.tsx', page)
    const before = snapshotWorkspace()
    const { line, col } = locateTag(page, 'Status')
    const result = detachComponentInstance({ file: pageFile, line, col, workspaceRoot: tmpDir, dryRun: 'if-lossy' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.written).toBe(false)
    expect(result.lossy).toBe(true)
    expect(result.branchNote).toContain('more than one rendered state')
    expect(snapshotWorkspace()).toEqual(before)
  })

  it("'if-lossy' writes a detach that loses nothing, in one step", () => {
    write('components/Status.tsx', 'export function Status() {\n  return <div className="ready">Ready</div>\n}\n')
    const { result, text } = detachTag('pages/Home.tsx', page, 'Status', { dryRun: 'if-lossy' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.written).toBe(true)
    expect(result.lossy).toBe(false)
    expect(text).toContain('<main><div className="ready">Ready</div></main>')
  })

  it("'always' reports and never writes, even when nothing would be lost", () => {
    write('components/Status.tsx', 'export function Status() {\n  return <div className="ready">Ready</div>\n}\n')
    const pageFile = write('pages/Home.tsx', page)
    const before = snapshotWorkspace()
    const { line, col } = locateTag(page, 'Status')
    const result = detachComponentInstance({ file: pageFile, line, col, workspaceRoot: tmpDir, dryRun: 'always' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result).toMatchObject({ written: false, lossy: false, movedHooks: [], perRow: false })
    expect(snapshotWorkspace()).toEqual(before)
  })

  it('reports a call site inside a `.map` row as per-row, and carries the key when it is written', () => {
    write('components/Row.tsx', 'export function Row({ label }: { label: string }) {\n  return <li className="row">{label}</li>\n}\n')
    const source = [
      "import { Row } from '../components/Row'",
      "const ITEMS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]",
      'export default function Home() {',
      '  return <ul>{ITEMS.map((item) => <Row key={item.id} label={item.label} />)}</ul>',
      '}',
      '',
    ].join('\n')
    const held = detachTag('pages/Home.tsx', source, 'Row', { dryRun: 'if-lossy' })
    if (!held.result.ok) throw new Error(held.result.refusal.message)
    expect(held.result).toMatchObject({ written: false, lossy: true, perRow: true })
    expect(held.text).toBe(source)

    const { result, text } = detachTag('pages/Home.tsx', source, 'Row')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.written).toBe(true)
    expect(text).toContain('{ITEMS.map((item) => <li key={item.id} className="row">{item.label}</li>)}')
  })
})
