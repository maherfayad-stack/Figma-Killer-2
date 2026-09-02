/**
 * detachComponentInstance — WS-4.4. Covers the plan's explicit gate list:
 * plain component, destructured defaults, `{children}`, sub-component import
 * reconciliation, last-usage import removal, and every refusal reason.
 *
 * One fixture (the "arrow/named-export/barrel" describe block) deliberately
 * shares nothing with the eSIM corpus's habits (default-exported `function`
 * declarations, `.jsx`) — same discipline as `genericRepoShapes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance, type DetachResult } from '../detachComponent'

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

describe('detachComponentInstance — plain component', () => {
  it('inlines a simple component with a literal prop', () => {
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
    expect(text).toContain('<div className="card">{"Confirm"}</div>')
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
  it('uses the destructured default when the call site omits the attribute', () => {
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
    expect(read('pages/Home.tsx')).toContain("<span className={'neutral'}>{\"New\"}</span>")
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
    expect(read('pages/Home.tsx')).toContain('<span className={"warning"}>{"New"}</span>')
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
    expect(text).toContain('<p>{"Confirm"}</p>')
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
})

describe('detachComponentInstance — last-usage import removal', () => {
  it('removes the import when the detached call site was the only usage', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Hello</div>\n}\n')
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
    expect(text).not.toContain('Card')
    expect(text).toContain('<div>Hello</div>')
  })

  it('keeps the import when another call site still uses it', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Hello</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <Card />',
      '      <Card />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = detachAt(pageFile, 5, 8)
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain("import { Card } from '../components/Card'")
    expect(text).toContain('<div>Hello</div>') // the first call site, detached
    expect(text).toContain('<Card />') // the second call site untouched
  })
})

describe('detachComponentInstance — refusals', () => {
  it('refuses a plain HTML element', () => {
    const pageFile = write('pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    const result = detachAt(pageFile, 2, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-a-component')
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
    const pageFile = write('pages/Home.tsx', [
      "import { Counter } from '../components/Counter'",
      'export default function Home() {',
      '  return <Counter />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('uses-hooks')
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
    const pageFile = write('pages/Home.tsx', [
      "import { Widget } from '../components/Widget'",
      'export default function Home() {',
      '  return <Widget />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('uses-hooks')
  })

  it('refuses a component that maps over one of its own props', () => {
    write('components/List.tsx', [
      "export function List({ items }: { items: string[] }) {",
      '  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { List } from '../components/List'",
      'export default function Home() {',
      "  return <List items={['a', 'b']} />",
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('maps-over-props')
  })

  it('does NOT refuse a .map over something other than its own props', () => {
    write('components/List.tsx', [
      "const FIXED = ['x', 'y']",
      'export function List() {',
      '  return <ul>{FIXED.map((item) => <li key={item}>{item}</li>)}</ul>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { List } from '../components/List'",
      'export default function Home() {',
      '  return <List />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(true)
  })

  it('refuses a component taking an undestructured props parameter', () => {
    write('components/Card.tsx', [
      'export function Card(props) {',
      '  return <div>{props.title}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('unsupported-params')
  })

  it('refuses a package component', () => {
    const pageFile = write('pages/Home.tsx', [
      "import { Button } from '@alm-design/design-system'",
      'export default function Home() {',
      '  return <Button label="Save" />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('package-component')
  })

  it('refuses an import that resolves to a real LOCAL file with no component declaration', () => {
    // A real, in-workspace file — classified `local`, not `package` — whose
    // named export is not a function/arrow at all, so no declaration can be
    // read as a component body.
    write('components/Empty.tsx', 'export const Empty = 42\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Empty } from '../components/Empty'",
      'export default function Home() {',
      '  return <Empty />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('unresolvable')
  })

  it('classifies an import to a nonexistent file as a package (documented `componentSources` behaviour), not "unresolvable"', () => {
    // `classifyImport` (`componentSources.ts`) treats an import whose target
    // cannot be resolved on disk as a PACKAGE reference — a broken relative
    // import looks structurally identical to a bare npm specifier once
    // ts-morph can't find a `SourceFile` for it. Documented here so a future
    // reader doesn't "fix" detach to report this case as `unresolvable`.
    const pageFile = write('pages/Home.tsx', [
      "import { Ghost } from '../components/DoesNotExist'",
      'export default function Home() {',
      '  return <Ghost />',
      '}',
      '',
    ].join('\n'))
    const result = detachAt(pageFile, 3, 11)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('package-component')
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
    expect(read('src/pages/Home.tsx')).toContain('<section className="tile"><h2>{"Welcome"}</h2></section>')
  })
})
