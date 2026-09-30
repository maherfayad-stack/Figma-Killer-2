/**
 * detachComponentInstance — WS-4.4 + the audit's DET-1/DET-2
 * (`docs/audits/2026-09-23-studio-audit/07-image-drop-and-detach.md` §B).
 *
 * Covers: plain components, destructured defaults, `{children}`,
 * sub-component import reconciliation, last-usage import removal, every
 * refusal reason — and, since DET-1, the codemod's promise to fail CLOSED:
 * a param used anywhere (not only as a whole `{param}`), an omitted prop,
 * an aliased import on a name collision, body locals, module-scope defaults,
 * side-effect CSS, `key`, and call-site spreads / component `...rest`
 * (DET-2). Every refusal asserts that BOTH files are byte-identical
 * afterwards (`expectRefusedUntouched`).
 *
 * The literal-collapse expectations changed on purpose with DET-1: a string
 * substituted into a child slot is JSX text (`Confirm`, not `{"Confirm"}`),
 * and into an attribute is an attribute string (`className="neutral"`, not
 * `className={'neutral'}`) — the forms Studio's own text and attribute
 * editing handle natively.
 *
 * Two fixtures ("arrow/named-export/barrel", "generic .jsx shape")
 * deliberately share nothing with the eSIM corpus's habits (default-exported
 * `function` declarations, `.jsx`, `import './X.css'`) — same discipline as
 * `genericRepoShapes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance, type DetachRefusalReason, type DetachResult } from '../detachComponent'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detach-component-'))
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

function detachAt(file: string, line: number, col: number): DetachResult {
  return detachComponentInstance({ file, line, col, workspaceRoot: tmpDir })
}

/** Writes the page, detaches the `occurrence`-th `<tag`, and returns the result plus the page's text afterwards. */
function detachTag(pageRel: string, source: string, tag: string, occurrence = 1): { result: DetachResult; text: string } {
  const pageFile = write(pageRel, source)
  const { line, col } = locateTag(source, tag, occurrence)
  const result = detachAt(pageFile, line, col)
  return { result, text: read(pageRel) }
}

/** Every file under the temp workspace, byte for byte. */
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

/**
 * The fail-closed contract: a refusal carries the expected reason and leaves
 * every file in the workspace — the page AND the component — byte-identical.
 */
function expectRefusedUntouched(pageRel: string, source: string, tag: string, reason: DetachRefusalReason, occurrence = 1): string {
  const pageFile = write(pageRel, source)
  const before = snapshotWorkspace()
  const { line, col } = locateTag(source, tag, occurrence)
  const result = detachAt(pageFile, line, col)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a refusal')
  expect(result.refusal.reason).toBe(reason)
  expect(snapshotWorkspace()).toEqual(before)
  return result.refusal.message
}

describe('detachComponentInstance — plain component', () => {
  it('inlines a simple component with a literal prop, as JSX text', () => {
    write('components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div className="card">{title}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Confirm" />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<div className="card">Confirm</div>')
    // Last usage of `Card` removed — its import is gone too.
    expect(text).not.toContain("from '../components/Card'")
  })

  it('keeps a binding EXPRESSION as a binding, never bakes a resolved value', () => {
    write('components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div>{title}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home({ plan }: { plan: { name: string } }) {',
      '  return <Card title={plan.name} />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    // `plan` is still in scope at the call site's own position, so the
    // binding survives verbatim — never baked into a string.
    expect(read('pages/Home.tsx')).toContain('<div>{plan.name}</div>')
  })
})

describe('detachComponentInstance — destructured defaults', () => {
  it('uses the destructured default when the call site omits the attribute, as an attribute string', () => {
    write('components/Badge.tsx', [
      "export function Badge({ label, tone = 'neutral' }: { label: string; tone?: string }) {",
      '  return <span className={tone}>{label}</span>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Badge } from '../components/Badge'",
      'export default function Home() {',
      '  return <Badge label="New" />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain('<span className="neutral">New</span>')
  })

  it('prefers the call site\'s own value over the default when both are present', () => {
    write('components/Badge.tsx', [
      "export function Badge({ label, tone = 'neutral' }: { label: string; tone?: string }) {",
      '  return <span className={tone}>{label}</span>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Badge } from '../components/Badge'",
      'export default function Home() {',
      '  return <Badge label="New" tone="warning" />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain('<span className="warning">New</span>')
  })

  it('keeps the default for a call-site expression that may be undefined — exactly what destructuring does', () => {
    write('components/Badge.tsx', [
      "export function Badge({ tone = 'neutral' }: { tone?: string }) {",
      '  return <span className={tone} />',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Badge } from '../components/Badge'",
      'export default function Home({ item }: { item: { tone?: string } }) {',
      '  return <Badge tone={item.tone} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Badge')
    expect(result.ok).toBe(true)
    expect(text).toContain("<span className={item.tone === undefined ? 'neutral' : item.tone} />")
  })

  it('imports a module-scope name a default reads (bug 8)', () => {
    write('tokens.ts', 'export const DEFAULT_SIZE = 24\n')
    write('components/Box.tsx', [
      "import { DEFAULT_SIZE } from '../tokens'",
      'export function Box({ size = DEFAULT_SIZE }: { size?: number }) {',
      '  return <div style={{ width: size }} />',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Box } from '../components/Box'",
      'export default function Home() {',
      '  return <Box />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Box')
    expect(result.ok).toBe(true)
    expect(text).toContain("import { DEFAULT_SIZE } from '../tokens'")
    expect(text).toContain('<div style={{ width: DEFAULT_SIZE }} />')
    expect(text).not.toContain('components/Box')
  })
})

describe('detachComponentInstance — a param used anywhere, by symbol (bug 1)', () => {
  it('substitutes a param inside a call, and aliases a colliding CSS-module import (bug 3)', () => {
    write('lib/cn.ts', 'export function cn(...parts: unknown[]) { return parts.filter(Boolean).join(\' \') }\n')
    write('components/Card.module.css', '.card { padding: 8px; }\n')
    write('pages/Home.module.css', '.page { margin: 0; }\n')
    write('components/Card.tsx', [
      "import styles from './Card.module.css'",
      "import { cn } from '../lib/cn'",
      'export function Card({ className, title }: { className?: string; title: string }) {',
      '  return <div className={cn(styles.card, className)}>{title}</div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import styles from './Home.module.css'",
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <main className={styles.page}><Card className="mt-4" title="Hi" /></main>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    // The page's own `styles` is untouched and still means Home.module.css…
    expect(text).toContain("import styles from './Home.module.css'")
    expect(text).toContain('<main className={styles.page}>')
    // …and Card's `styles` arrives under an alias, renamed exactly.
    expect(text).toContain("import cardStyles from '../components/Card.module.css'")
    expect(text).toContain("import { cn } from '../lib/cn'")
    expect(text).toContain('<div className={cn(cardStyles.card, "mt-4")}>Hi</div>')
  })

  it('never leaves a bare param behind for the page to silently rebind (`&&`, omitted prop)', () => {
    write('components/Card.tsx', [
      'export function Card({ featured, title }: { featured?: boolean; title: string }) {',
      '  return <article>{featured && <strong>New</strong>}<h3>{title}</h3></article>',
      '}',
      '',
    ].join('\n'))
    // The page has a `featured` of its own — the old codemod left `{featured
    // && …}` in place, which then silently read THIS binding.
    const source = [
      "import { Card } from '../components/Card'",
      'export default function Home({ featured }: { featured: boolean }) {',
      "  return <section>{featured ? 'yes' : 'no'}<Card title=\"A\" /></section>",
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    expect(text).toContain('<article>{undefined && <strong>New</strong>}<h3>A</h3></article>')
    expect(text).not.toContain('{featured &&')
  })

  it('substitutes a boolean shorthand as `true`', () => {
    write('components/Card.tsx', [
      'export function Card({ featured }: { featured?: boolean }) {',
      '  return <article>{featured && <strong>New</strong>}</article>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card featured />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    expect(text).toContain('<article>{true && <strong>New</strong>}</article>')
  })

  it('substitutes a param inside a template literal', () => {
    write('components/PlanLink.tsx', [
      'export function PlanLink({ id }: { id: string }) {',
      '  return <a href={`/p/${id}`}>Open</a>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { PlanLink } from '../components/PlanLink'",
      'export default function Home({ plan }: { plan: { id: string } }) {',
      '  return <PlanLink id={plan.id} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'PlanLink')
    expect(result.ok).toBe(true)
    expect(text).toContain('<a href={`/p/${plan.id}`}>Open</a>')
  })

  it('substitutes a param inside a style object, including a shorthand property', () => {
    write('components/Box.tsx', [
      'export function Box({ size, gap }: { size: number; gap: number }) {',
      '  return <div style={{ width: size, gap }} />',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Box } from '../components/Box'",
      'export default function Home() {',
      '  return <Box size={24} gap={8} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Box')
    expect(result.ok).toBe(true)
    expect(text).toContain('<div style={{ width: 24, gap: 8 }} />')
  })

  it('substitutes a param used as a method receiver', () => {
    write('components/Heading.tsx', [
      'export function Heading({ title }: { title: string }) {',
      '  return <h2>{title.toUpperCase()}</h2>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Heading } from '../components/Heading'",
      'export default function Home() {',
      '  return <Heading title="Confirm" />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Heading')
    expect(result.ok).toBe(true)
    expect(text).toContain('<h2>{"Confirm".toUpperCase()}</h2>')
  })

  it('parenthesizes a non-primary call-site expression where the grammar needs it', () => {
    write('components/Count.tsx', [
      'export function Count({ n }: { n: number }) {',
      '  return <b>{n * 2}</b>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Count } from '../components/Count'",
      'export default function Home({ a, b }: { a: number; b: number }) {',
      '  return <Count n={a + b} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Count')
    expect(result.ok).toBe(true)
    expect(text).toContain('<b>{(a + b) * 2}</b>')
  })

  it('treats an omitted prop with no default as `undefined`: the attribute is dropped, the child is empty (bug 2)', () => {
    write('components/Tip.tsx', [
      'export function Tip({ title, hint }: { title: string; hint?: string }) {',
      '  return <p title={hint}>{title}{hint}</p>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Tip } from '../components/Tip'",
      'export default function Home() {',
      '  return <Tip title="A" />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Tip')
    expect(result.ok).toBe(true)
    expect(text).toContain('<p>A</p>')
    expect(text).not.toContain('hint')
  })
})

describe('detachComponentInstance — body locals (bug 4)', () => {
  it('inlines a const read once, computed from a param', () => {
    write('components/Heading.tsx', [
      'export function Heading({ title }: { title: string }) {',
      '  const label = title.toUpperCase()',
      '  return <h2>{label}</h2>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Heading } from '../components/Heading'",
      'export default function Home() {',
      '  return <Heading title="Confirm" />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Heading')
    expect(result.ok).toBe(true)
    expect(text).toContain('<h2>{"Confirm".toUpperCase()}</h2>')
    expect(text).not.toContain('label')
  })

  it('refuses `body-local` for a const the markup reads twice', () => {
    write('components/Heading.tsx', [
      'export function Heading({ title }: { title: string }) {',
      '  const label = title.toUpperCase()',
      '  return <h2 title={label}>{label}</h2>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Heading } from '../components/Heading'",
      'export default function Home() {',
      '  return <Heading title="Confirm" />',
      '}',
      '',
    ].join('\n')
    const message = expectRefusedUntouched('pages/Home.tsx', source, 'Heading', 'body-local')
    expect(message).toContain('label')
  })

  it('refuses `body-local` for a const computed from another body value', () => {
    write('components/Heading.tsx', [
      'export function Heading({ title }: { title: string }) {',
      '  const base = title.trim()',
      '  const label = base.toUpperCase()',
      '  return <h2>{label}</h2>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Heading } from '../components/Heading'",
      'export default function Home() {',
      '  return <Heading title="Confirm" />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Heading', 'body-local')
  })

  it('refuses `body-local` for a tag chosen by a body value, naming the tag', () => {
    write('components/Banner.tsx', [
      "import { InfoIcon, WarnIcon } from './icons'",
      'export function Banner({ warn }: { warn?: boolean }) {',
      '  const Icon = warn ? WarnIcon : InfoIcon',
      '  return <div><Icon /></div>',
      '}',
      '',
    ].join('\n'))
    write('components/icons.tsx', 'export const InfoIcon = () => <i />\nexport const WarnIcon = () => <b />\n')
    const source = [
      "import { Banner } from '../components/Banner'",
      'export default function Home() {',
      '  return <Banner warn />',
      '}',
      '',
    ].join('\n')
    const message = expectRefusedUntouched('pages/Home.tsx', source, 'Banner', 'body-local')
    expect(message).toContain('<Icon>')
  })

  it('refuses `body-local` for a body function the markup calls', () => {
    write('components/Button.tsx', [
      'export function Button({ label }: { label: string }) {',
      '  function handleClick() { console.error(label) }',
      '  return <button onClick={handleClick}>{label}</button>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Button } from '../components/Button'",
      'export default function Home() {',
      '  return <Button label="Go" />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Button', 'body-local')
  })
})

describe('detachComponentInstance — {children}', () => {
  it('splices the call site\'s own children into a {children} slot', () => {
    write('components/Shell.tsx', [
      "export function Shell({ title, children }: { title: string; children: React.ReactNode }) {",
      '  return (',
      '    <div className="shell">',
      '      <p>{title}</p>',
      '      <div className="shell__panel">{children}</div>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Shell } from '../components/Shell'",
      'export default function Home() {',
      '  return (',
      '    <Shell title="Confirm">',
      '      <p className="body">Your booking details</p>',
      '    </Shell>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 4, 6)
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<div className="shell__panel"><p className="body">Your booking details</p></div>')
    expect(text).toContain('<p>Confirm</p>')
  })

  it('leaves an empty {children} slot empty for a self-closing call site', () => {
    write('components/Shell.tsx', [
      "export function Shell({ children }: { children?: React.ReactNode }) {",
      '  return <div className="shell">{children}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Shell } from '../components/Shell'",
      'export default function Home() {',
      '  return <Shell />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain('<div className="shell"></div>')
  })

  it('keeps the space in front of an inline text run inside the children', () => {
    write('components/Line.tsx', [
      'export function Line({ children }: { children: React.ReactNode }) {',
      '  return <p>{children}</p>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Line } from '../components/Line'",
      'export default function Home() {',
      '  return <Line><b>x</b> and more</Line>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Line')
    expect(result.ok).toBe(true)
    expect(text).toContain('<p><b>x</b> and more</p>')
  })
})

describe('detachComponentInstance — sub-component import reconciliation', () => {
  it('imports a sub-component Card\'s JSX references that the page did not already import', () => {
    write('components/Icon.tsx', [
      'export function Icon() {',
      '  return <svg />',
      '}',
      '',
    ].join('\n'))
    write('components/Card.tsx', [
      "import { Icon } from './Icon'",
      'export function Card() {',
      '  return <div><Icon /><span>Card</span></div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<Icon />')
    expect(text).toContain("import { Icon } from '../components/Icon'")
  })

  it('does not re-import an identifier the page already has in scope', () => {
    write('components/Icon.tsx', 'export function Icon() {\n  return <svg />\n}\n')
    write('components/Card.tsx', [
      "import { Icon } from './Icon'",
      'export function Card() {',
      '  return <div><Icon /></div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      "import { Icon } from '../components/Icon'",
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <Icon />',
      '      <Card />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 7, 8)
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    // Only ONE import of Icon — not duplicated.
    expect(text.split("from '../components/Icon'").length - 1).toBe(1)
  })

  it('aliases a sub-component whose name the page already uses for a different component', () => {
    write('components/Icon.tsx', 'export function Icon() {\n  return <svg />\n}\n')
    write('ui/Icon.tsx', 'export function Icon() {\n  return <i />\n}\n')
    write('components/Card.tsx', [
      "import { Icon } from './Icon'",
      'export function Card() {',
      '  return <div><Icon /></div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      "import { Icon } from '../ui/Icon'",
      'export default function Home() {',
      '  return <section><Icon /><Card /></section>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    expect(text).toContain("import { Icon } from '../ui/Icon'")
    expect(text).toContain("import { Icon as CardIcon } from '../components/Icon'")
    expect(text).toContain('<section><Icon /><div><CardIcon /></div></section>')
  })

  it('imports an exported module-scope const of the component file from that file', () => {
    write('components/List.tsx', [
      "export const FIXED = ['x', 'y']",
      'export function List() {',
      '  return <ul>{FIXED.map((item) => <li key={item}>{item}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { List } from '../components/List'",
      'export default function Home() {',
      '  return <List />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'List')
    expect(result.ok).toBe(true)
    expect(text).toContain("import { FIXED } from '../components/List'")
    expect(text).toContain('<ul>{FIXED.map((item) => <li key={item}>{item}</li>)}</ul>')
  })

  it('refuses `unbound-reference` for a module-scope const the component file does not export', () => {
    // The pre-DET-1 codemod wrote `import { FIXED } from '../components/List'`
    // here — an import of a name that module does not export.
    write('components/List.tsx', [
      "const FIXED = ['x', 'y']",
      'export function List() {',
      '  return <ul>{FIXED.map((item) => <li key={item}>{item}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { List } from '../components/List'",
      'export default function Home() {',
      '  return <List />',
      '}',
      '',
    ].join('\n')
    const message = expectRefusedUntouched('pages/Home.tsx', source, 'List', 'unbound-reference')
    expect(message).toContain('FIXED')
  })

  it('mirrors a side-effect stylesheet import of the component file', () => {
    write('components/Card.css', '.card { padding: 8px; }\n')
    write('components/Card.tsx', [
      "import './Card.css'",
      'export function Card() {',
      '  return <div className="card">Hi</div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    expect(text).toContain("import '../components/Card.css'")
    expect(text).toContain('<div className="card">Hi</div>')
  })
})

describe('detachComponentInstance — key (bug 7)', () => {
  it('carries the call site\'s key onto the inlined root element', () => {
    write('components/Card.tsx', [
      'export function Card({ title }: { title: string }) {',
      '  return <div className="card">{title}</div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      "const ITEMS = [{ id: 'a', name: 'A' }]",
      'export default function Home() {',
      '  return <ul>{ITEMS.map((item) => <Card key={item.id} title={item.name} />)}</ul>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Card')
    expect(result.ok).toBe(true)
    expect(text).toContain('{ITEMS.map((item) => <div key={item.id} className="card">{item.name}</div>)}')
  })

  it('carries a key onto a fragment root as <Fragment key>, importing Fragment', () => {
    write('components/Pair.tsx', [
      'export function Pair({ a, b }: { a: string; b: string }) {',
      '  return <><dt>{a}</dt><dd>{b}</dd></>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Pair } from '../components/Pair'",
      "const ROWS = [{ id: 'a', k: 'K', v: 'V' }]",
      'export default function Home() {',
      '  return <dl>{ROWS.map((row) => <Pair key={row.id} a={row.k} b={row.v} />)}</dl>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Pair')
    expect(result.ok).toBe(true)
    expect(text).toContain("import { Fragment } from 'react'")
    expect(text).toContain('<Fragment key={row.id}><dt>{row.k}</dt><dd>{row.v}</dd></Fragment>')
  })
})

describe('detachComponentInstance — name collisions', () => {
  it('refuses `name-collision` when an inner binding of the component would capture a call-site value', () => {
    write('components/Card.tsx', [
      "export const ROWS = ['x']",
      'export function Card({ title }: { title: string }) {',
      '  return <ul>{ROWS.map((item) => <li key={item}>{item}{title}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      "const ITEMS = [{ id: 'a', name: 'A' }]",
      'export default function Home() {',
      '  return <div>{ITEMS.map((item) => <Card key={item.id} title={item.name} />)}</div>',
      '}',
      '',
    ].join('\n')
    const message = expectRefusedUntouched('pages/Home.tsx', source, 'Card', 'name-collision')
    expect(message).toContain('item')
  })

  it('inlines a same-file component with no import at all', () => {
    const source = [
      "const LABEL = 'Global'",
      'function Badge() {',
      '  return <span>{LABEL}</span>',
      '}',
      'export default function Home() {',
      '  return <div><Badge /></div>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Badge')
    expect(result.ok).toBe(true)
    expect(text).toContain('return <div><span>{LABEL}</span></div>')
    expect(text).not.toContain('import')
  })

  it('refuses `name-collision` for a same-file component whose module-scope name a local shadows at the call site', () => {
    const source = [
      "const label = 'Global'",
      'function Badge() {',
      '  return <span>{label}</span>',
      '}',
      'export default function Home() {',
      "  const label = 'Local'",
      '  return <div>{label}<Badge /></div>',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Badge', 'name-collision')
  })

  it('refuses `name-collision` when the page shadows a global the component reads', () => {
    write('components/Num.tsx', [
      'export function Num({ v }: { v: number }) {',
      '  return <b>{String(v)}</b>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Num } from '../components/Num'",
      'export default function Home() {',
      "  const String = (x: unknown) => 'nope'",
      '  return <p>{String(1)}<Num v={1} /></p>',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Num', 'name-collision')
  })
})

describe('detachComponentInstance — spread and rest (DET-2)', () => {
  const HEADING = [
    'export function Heading({ title }: { title: string }) {',
    '  return <h3>{title}</h3>',
    '}',
    '',
  ].join('\n')

  it('reads a param out of a call-site spread', () => {
    write('components/Heading.tsx', HEADING)
    const source = [
      "import { Heading } from '../components/Heading'",
      "const plan = { title: 'Pro' }",
      'export default function Home() {',
      '  return <Heading {...plan} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Heading')
    expect(result.ok).toBe(true)
    expect(text).toContain('<h3>{plan.title}</h3>')
  })

  it('lets an explicit attribute AFTER the spread win', () => {
    write('components/Heading.tsx', HEADING)
    const source = [
      "import { Heading } from '../components/Heading'",
      "const plan = { title: 'Pro' }",
      'export default function Home() {',
      '  return <Heading {...plan} title="X" />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Heading')
    expect(result.ok).toBe(true)
    expect(text).toContain('<h3>X</h3>')
  })

  it('refuses `spread-ambiguous` for an explicit attribute BEFORE the spread', () => {
    write('components/Heading.tsx', HEADING)
    const source = [
      "import { Heading } from '../components/Heading'",
      "const plan = { title: 'Pro' }",
      'export default function Home() {',
      '  return <Heading title="X" {...plan} />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Heading', 'spread-ambiguous')
  })

  it('refuses `spread-ambiguous` for a spread of a non-identifier', () => {
    write('components/Heading.tsx', HEADING)
    const source = [
      "import { Heading } from '../components/Heading'",
      "function getPlan() { return { title: 'Pro' } }",
      'export default function Home() {',
      '  return <Heading {...getPlan()} />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Heading', 'spread-ambiguous')
  })

  it('writes the call site\'s leftover attributes where the component spreads ...rest', () => {
    write('components/Btn.tsx', [
      'export function Btn({ label, ...rest }: { label: string; [key: string]: unknown }) {',
      '  return <button type="button" {...rest}>{label}</button>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Btn } from '../components/Btn'",
      'export default function Home({ go }: { go: () => void }) {',
      '  return <Btn label="Go" id="go" onClick={go} />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Btn')
    expect(result.ok).toBe(true)
    expect(text).toContain('<button type="button" id="go" onClick={go}>Go</button>')
    expect(text).not.toContain('rest')
  })

  it('lets a leftover attribute override the component\'s own earlier one, as the spread did', () => {
    write('components/Btn.tsx', [
      'export function Btn({ label, ...rest }: { label: string; [key: string]: unknown }) {',
      '  return <button type="button" {...rest}>{label}</button>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Btn } from '../components/Btn'",
      'export default function Home() {',
      '  return <Btn label="Send" type="submit" />',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Btn')
    expect(result.ok).toBe(true)
    expect(text).toContain('<button type="submit">Send</button>')
  })

  it('refuses `spread-ambiguous` for a call-site spread into a component that forwards ...rest', () => {
    write('components/Btn.tsx', [
      'export function Btn({ label, ...rest }: { label: string; [key: string]: unknown }) {',
      '  return <button {...rest}>{label}</button>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Btn } from '../components/Btn'",
      "const extra = { id: 'x' }",
      'export default function Home() {',
      '  return <Btn label="Go" {...extra} />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Btn', 'spread-ambiguous')
  })
})

describe('detachComponentInstance — refusals', () => {
  it('refuses a plain HTML element', () => {
    const source = 'export default function Home() {\n  return <div>Hi</div>\n}\n'
    expectRefusedUntouched('pages/Home.tsx', source, 'div', 'not-a-component')
  })

  it('refuses a component using useState', () => {
    write('components/Counter.tsx', [
      "import { useState } from 'react'",
      'export function Counter() {',
      '  const [n] = useState(0)',
      '  return <span>{n}</span>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Counter } from '../components/Counter'",
      'export default function Home() {',
      '  return <Counter />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Counter', 'uses-hooks')
  })

  it('refuses a component using a custom hook', () => {
    write('components/Widget.tsx', [
      "function useWidgetState() { return 1 }",
      'export function Widget() {',
      '  const n = useWidgetState()',
      '  return <span>{n}</span>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Widget } from '../components/Widget'",
      'export default function Home() {',
      '  return <Widget />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Widget', 'uses-hooks')
  })

  it('refuses a component that maps over one of its own props', () => {
    write('components/List.tsx', [
      "export function List({ items }: { items: string[] }) {",
      '  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { List } from '../components/List'",
      'export default function Home() {',
      "  return <List items={['a', 'b']} />",
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'List', 'maps-over-props')
  })

  it('refuses a component taking an undestructured props parameter', () => {
    write('components/Card.tsx', [
      'export function Card(props) {',
      '  return <div>{props.title}</div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Card', 'unsupported-params')
  })

  it('refuses `unsupported-params` for a nested destructure the markup reads', () => {
    write('components/Card.tsx', [
      'export function Card({ plan: { name } }: { plan: { name: string } }) {',
      '  return <div>{name}</div>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Card } from '../components/Card'",
      "const plan = { name: 'Pro' }",
      'export default function Home() {',
      '  return <Card plan={plan} />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Card', 'unsupported-params')
  })

  it('refuses a package component', () => {
    const source = [
      "import { Button } from '@alm-design/design-system'",
      'export default function Home() {',
      '  return <Button label="Save" />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Button', 'package-component')
  })

  it('refuses an import that resolves to a real LOCAL file with no component declaration', () => {
    // A real, in-workspace file — classified `local`, not `package` — whose
    // named export is not a function/arrow at all, so no declaration can be
    // read as a component body.
    write('components/Empty.tsx', 'export const Empty = 42\n')
    const source = [
      "import { Empty } from '../components/Empty'",
      'export default function Home() {',
      '  return <Empty />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Empty', 'unresolvable')
  })

  it('classifies an import to a nonexistent file as a package (documented `componentSources` behaviour), not "unresolvable"', () => {
    // `classifyImport` (`componentSources.ts`) treats an import whose target
    // cannot be resolved on disk as a PACKAGE reference — a broken relative
    // import looks structurally identical to a bare npm specifier once
    // ts-morph can't find a `SourceFile` for it. Documented here so a future
    // reader doesn't "fix" detach to report this case as `unresolvable`.
    const source = [
      "import { Ghost } from '../components/DoesNotExist'",
      'export default function Home() {',
      '  return <Ghost />',
      '}',
      '',
    ].join('\n')
    expectRefusedUntouched('pages/Home.tsx', source, 'Ghost', 'package-component')
  })
})

describe('detachComponentInstance — branch selection (parser-06)', () => {
  it('inlines the LAST return (the branch actually shown) and notes the alternative', () => {
    write('components/Status.tsx', [
      'export function Status({ loading }: { loading: boolean }) {',
      '  if (loading) return <span>Loading…</span>',
      '  return <span>Ready</span>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Status } from '../components/Status'",
      'export default function Home() {',
      '  return <Status loading={false} />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain('<span>Ready</span>')
    if (result.ok) expect(result.branchNote).toBeDefined()
  })

  it('wraps a non-JSX root in braces when the call site is a JSX child', () => {
    write('components/Maybe.tsx', [
      'export function Maybe({ on }: { on: boolean }) {',
      '  return on ? <b>On</b> : <i>Off</i>',
      '}',
      '',
    ].join('\n'))
    const source = [
      "import { Maybe } from '../components/Maybe'",
      'export default function Home({ flag }: { flag: boolean }) {',
      '  return <p><Maybe on={flag} /></p>',
      '}',
      '',
    ].join('\n')
    const { result, text } = detachTag('pages/Home.tsx', source, 'Maybe')
    expect(result.ok).toBe(true)
    expect(text).toContain('<p>{flag ? <b>On</b> : <i>Off</i>}</p>')
  })
})

describe('detachComponentInstance — arrow/named-export/barrel shape (shares nothing with the eSIM corpus)', () => {
  it('inlines a `const` arrow component re-exported through a barrel', () => {
    write('src/components/Tile/Tile.tsx', [
      "import type { FC } from 'react'",
      'export interface TileProps {',
      '  heading: string',
      '}',
      'export const Tile: FC<TileProps> = ({ heading }) => {',
      '  return <section className="tile"><h2>{heading}</h2></section>',
      '}',
      '',
    ].join('\n'))
    write('src/components/Tile/index.ts', "export { Tile } from './Tile'\n")
    const pageFile = write('src/pages/Home.tsx', [
      "import { Tile } from '../components/Tile'",
      'export const Home = () => {',
      '  return <Tile heading="Welcome" />',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
    expect(read('src/pages/Home.tsx')).toContain('<section className="tile"><h2>Welcome</h2></section>')
  })
})

describe('detachComponentInstance — generic .jsx shape: renamed params, rest.x, polymorphic tag (shares nothing with the eSIM corpus)', () => {
  it('handles a renamed destructure, a `rest.x` read, and a tag chosen by a prop', () => {
    write('src/ui/Chip.jsx', [
      "import css from './chip.module.css'",
      "export const Chip = ({ label: text, as: Tag = 'span', ...rest }) => (",
      '  <Tag className={css.chip} aria-label={rest.title}>{text}</Tag>',
      ')',
      '',
    ].join('\n'))
    write('src/ui/chip.module.css', '.chip { border-radius: 4px; }\n')
    write('src/ui/index.js', "export { Chip } from './Chip.jsx'\n")
    const source = [
      "import { Chip } from '../ui'",
      'export const Board = ({ status }) => (',
      '  <nav>',
      '    <Chip label={status} as="strong" title="State" />',
      '  </nav>',
      ')',
      '',
    ].join('\n')
    const { result, text } = detachTag('src/views/Board.jsx', source, 'Chip')
    expect(result.ok).toBe(true)
    expect(text).toContain("import css from '../ui/chip.module.css'")
    expect(text).toContain('<strong className={css.chip} aria-label="State">{status}</strong>')
    expect(text).not.toContain('Chip')
  })
})
