/**
 * extractSubtreeToComponent — E2.1. Covers the refusal vocabulary at least as
 * thoroughly as the successes (spread-props, name-taken, and every lifted
 * `refusePlacement` reason this codemod can reach), verbatim round-tripping
 * of non-trivial call-site expressions (trap #4), and free-variable
 * partitioning (module import vs. body-local prop vs. shadowed/local name).
 *
 * One fixture (the "arrow/named-export shape" describe block) deliberately
 * shares nothing with the eSIM corpus's habits — same discipline
 * `genericRepoShapes.test.ts` established for the parser itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { extractSubtreeToComponent, type ExtractSubtreeToComponentResult } from '../extractSubtreeToComponent'
import { listSlotChildCandidates } from '../subtreeSlotChildren'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-subtree-'))
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

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(tmpDir, ...relPath.split('/')))
}

function extractAt(
  file: string,
  line: number,
  col: number,
  componentName: string,
  extra: Partial<Parameters<typeof extractSubtreeToComponent>[0]> = {},
): ExtractSubtreeToComponentResult {
  return extractSubtreeToComponent({ file, line, col, workspaceRoot: tmpDir, componentName, ...extra })
}

describe('extractSubtreeToComponent — basic extraction', () => {
  it('extracts a plain element with a body-local free variable as a prop', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ title }: { title: string }) {",
      '  return (',
      '    <div className="wrap">',
      '      <p>{title}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const source = read('pages/Home.tsx')
    const loc = locateTag(source, 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Title')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.newFile).toBe('pages/Title.tsx')
    expect(result.shifted).toBe(true)
    expect(result.freeVariables).toEqual([{ name: 'title', kind: 'prop', isComponentTag: false }])

    const newFileText = read('pages/Title.tsx')
    expect(newFileText).toContain('export interface TitleProps {')
    expect(newFileText).toContain('title: unknown')
    expect(newFileText).toContain('export function Title({ title }: TitleProps)')
    // The subtree's own JSX text is untouched — moved verbatim.
    expect(newFileText).toContain('<p>{title}</p>')

    const pageText = read('pages/Home.tsx')
    expect(pageText).toContain('<Title title={title} />')
    expect(pageText).toContain("import { Title } from './Title'")
  })

  it('emits no interface/parameter for a subtree with no free variables', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <span className="badge">Static</span>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'span')

    const result = extractAt(pageFile, loc.line, loc.col, 'Badge')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.freeVariables).toEqual([])

    const newFileText = read('pages/Badge.tsx')
    expect(newFileText).not.toContain('interface')
    expect(newFileText).toContain('export function Badge()')
    expect(read('pages/Home.tsx')).toContain('<Badge />')
  })
})

describe('extractSubtreeToComponent — verbatim round-trip (trap #4)', () => {
  it('preserves a property-access expression verbatim, forwarding only the root binding', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ user }: { user: { name: string } }) {",
      '  return (',
      '    <div>',
      '      <p className="greeting">{user.name}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Greeting')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The whole `user.name` expression is untouched in the new file — never
    // baked into a resolved value like `"Ada"`.
    expect(read('pages/Greeting.tsx')).toContain('{user.name}')
    // Only `user` (the root binding) is forwarded — the plain identifier,
    // never an evaluated value.
    expect(read('pages/Home.tsx')).toContain('<Greeting user={user} />')
  })

  it('preserves a ternary verbatim', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ cond, a, b }: { cond: boolean; a: string; b: string }) {",
      '  return (',
      '    <div>',
      '      <p>{cond ? a : b}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Choice')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(read('pages/Choice.tsx')).toContain('{cond ? a : b}')
    const propNames = result.freeVariables.map((v) => v.name).sort()
    expect(propNames).toEqual(['a', 'b', 'cond'])
    expect(read('pages/Home.tsx')).toContain('<Choice cond={cond} a={a} b={b} />')
  })

  it('preserves a template literal verbatim', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ count }: { count: number }) {",
      '  return (',
      '    <div>',
      '      <p>{`${count} items`}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Count')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(read('pages/Count.tsx')).toContain('{`${count} items`}')
    expect(read('pages/Home.tsx')).toContain('<Count count={count} />')
  })
})

describe('extractSubtreeToComponent — free-variable partitioning', () => {
  it('mirrors a module-scope import into the new file and drops it from the page when it was the last usage', () => {
    write('lib/format.ts', "export function formatPrice(n: number): string {\n  return `$${n}`\n}\n")
    const pageFile = write('pages/Home.tsx', [
      "import { formatPrice } from '../lib/format'",
      'export default function Home({ price }: { price: number }) {',
      '  return (',
      '    <div>',
      '      <p>{formatPrice(price)}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Price')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const kinds = Object.fromEntries(result.freeVariables.map((v) => [v.name, v.kind]))
    expect(kinds.formatPrice).toBe('import')
    expect(kinds.price).toBe('prop')

    const newFileText = read('pages/Price.tsx')
    expect(newFileText).toContain("import { formatPrice } from '../lib/format'")
    expect(newFileText).toContain('{formatPrice(price)}')

    const pageText = read('pages/Home.tsx')
    // Only usage of `formatPrice` was inside the extracted subtree — its
    // import is now unused in the page and must be dropped.
    expect(pageText).not.toContain('formatPrice')
    expect(pageText).toContain('<Price price={price} />')
  })

  it('keeps a page-level import when another usage remains outside the extracted subtree', () => {
    write('lib/format.ts', "export function formatPrice(n: number): string {\n  return `$${n}`\n}\n")
    const pageFile = write('pages/Home.tsx', [
      "import { formatPrice } from '../lib/format'",
      'export default function Home({ price }: { price: number }) {',
      '  return (',
      '    <div>',
      '      <span>{formatPrice(price)}</span>',
      '      <p>{formatPrice(price)}</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Price')
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain("import { formatPrice } from '../lib/format'")
  })

  it('does not treat a name locally bound INSIDE the subtree (a .map callback param) as free', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ items }: { items: string[] }) {",
      '  return (',
      '    <ul>',
      '      {items.map((item) => <li key={item}>{item}</li>)}',
      '    </ul>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'ul')

    const result = extractAt(pageFile, loc.line, loc.col, 'ItemList')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // `items` (the array) is free; `item` (the callback's own parameter) is not.
    const names = result.freeVariables.map((v) => v.name)
    expect(names).toContain('items')
    expect(names).not.toContain('item')
  })

  it('mirrors a module-scope component import into the new file rather than forwarding it as a prop', () => {
    write('components/Icon.tsx', 'export function Icon() {\n  return <svg />\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Icon } from '../components/Icon'",
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p><Icon />Label</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Row')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // `Icon` resolves at the PAGE FILE's own module scope (an import), so it
    // is mirrored as an import into the new file — not forwarded as a prop.
    const iconVar = result.freeVariables.find((v) => v.name === 'Icon')
    expect(iconVar).toEqual({ name: 'Icon', kind: 'import', isComponentTag: true })

    const newFileText = read('pages/Row.tsx')
    expect(newFileText).toContain("import { Icon } from '../components/Icon'")
    expect(newFileText).toContain('<Icon />')

    const pageText = read('pages/Home.tsx')
    expect(pageText).toContain('<Row />')
    // The page's own `Icon` import is now unused (its only usage moved into
    // Row.tsx) and must be dropped.
    expect(pageText).not.toContain("from '../components/Icon'")
  })

  it('forwards a JSX tag reference that is a body-local (not module-scope) binding as a ComponentType-typed prop', () => {
    const pageFile = write('pages/Home.tsx', [
      "import type { ComponentType } from 'react'",
      'export default function Home({ Icon }: { Icon: ComponentType }) {',
      '  return (',
      '    <div>',
      '      <p><Icon />Label</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Row')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const iconVar = result.freeVariables.find((v) => v.name === 'Icon')
    expect(iconVar).toEqual({ name: 'Icon', kind: 'prop', isComponentTag: true })

    const newFileText = read('pages/Row.tsx')
    expect(newFileText).toContain('Icon: ComponentType')
    expect(newFileText).toContain('<Icon />')

    expect(read('pages/Home.tsx')).toContain('<Row Icon={Icon} />')
  })
})

describe('extractSubtreeToComponent — refusals', () => {
  it('refuses an element that spreads an arbitrary prop bag', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home({ rest }: { rest: Record<string, unknown> }) {',
      '  return (',
      '    <div>',
      '      <p {...rest}>Text</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Spready')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('spread-props')
    expect(exists('pages/Spready.tsx')).toBe(false)
  })

  it('refuses when the target file already exists', () => {
    write('pages/Existing.tsx', 'export function Existing() {\n  return <div />\n}\n')
    const pageFile = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p>Hi</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Existing')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('name-taken')
  })

  it('refuses when the name collides with a binding already in scope in the page file', () => {
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p>Hi</p>',
      '      <Card />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Card')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('name-taken')
  })

  it('refuses via a caller-supplied `existingComponentNames` catalog', () => {
    const pageFile = write('pages/Home.tsx', 'export default function Home() {\n  return (\n    <div><p>Hi</p></div>\n  )\n}\n')
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Button', { existingComponentNames: new Set(['Button']) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('name-taken')
  })

  it('refuses a subtree that is itself a .map row (AST-derived, no nodeId needed)', () => {
    const pageFile = write('pages/Home.tsx', [
      "export default function Home({ items }: { items: string[] }) {",
      '  return (',
      '    <ul>',
      '      {items.map((item) => <li key={item}><span>{item}</span></li>)}',
      '    </ul>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'span')

    const result = extractAt(pageFile, loc.line, loc.col, 'Row')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('list-row')
  })

  it('refuses a route-chrome file (layout.tsx) — filename-derivable with no nodeId', () => {
    const pageFile = write('app/layout.tsx', [
      'export default function RootLayout({ children }: { children: React.ReactNode }) {',
      '  return (',
      '    <html>',
      '      <body>',
      '        <p>{children}</p>',
      '      </body>',
      '    </html>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('app/layout.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Body')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('route-chrome')
  })

  it('refuses a caller-supplied `.map` row nodeId (a store-known iteration id)', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p>Row text</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')
    const rel = 'pages/Home.tsx'

    const result = extractAt(pageFile, loc.line, loc.col, 'Row', { nodeId: `${rel}:${loc.line}:${loc.col}#3` })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('list-row')
  })

  it('refuses a caller-supplied inlined (shared-component) nodeId', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p>Shared text</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Shared', {
      nodeId: `pages/Home.tsx:1:1~components/Card.tsx:${loc.line}:${loc.col}`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('shared-component')
  })

  it('refuses via a caller-supplied structural lockReason (code-placed)', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <p>Text</p>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'p')

    const result = extractAt(pageFile, loc.line, loc.col, 'Locked', { lockReason: 'spread props' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('code-placed')
  })

  it('throws for an invalid (non-PascalCase) component name — a caller-contract violation, not a user-facing refusal', () => {
    const pageFile = write('pages/Home.tsx', 'export default function Home() {\n  return (\n    <div><p>Hi</p></div>\n  )\n}\n')
    const loc = locateTag(read('pages/Home.tsx'), 'p')
    expect(() => extractAt(pageFile, loc.line, loc.col, 'lowercase')).toThrow()
  })
})

describe('extractSubtreeToComponent — arrow/named-export shape (shares nothing with the eSIM corpus)', () => {
  it('extracts from an arrow-function page component using a typed destructured prop', () => {
    const pageFile = write('src/pages/Home.tsx', [
      "import type { FC } from 'react'",
      'interface HomeProps {',
      '  tagline: string',
      '}',
      'export const Home: FC<HomeProps> = ({ tagline }) => {',
      '  return (',
      '    <section className="hero">',
      '      <h2>{tagline}</h2>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('src/pages/Home.tsx'), 'h2')

    const result = extractAt(pageFile, loc.line, loc.col, 'Tagline')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newFile).toBe('src/pages/Tagline.tsx')
    expect(read('src/pages/Tagline.tsx')).toContain('<h2>{tagline}</h2>')
    expect(read('src/pages/Home.tsx')).toContain('<Tagline tagline={tagline} />')
  })
})

describe('extractSubtreeToComponent — E2.2 keep/slot toggle', () => {
  const MULTI_CHILD_SOURCE = [
    'export default function Home() {',
    '  return (',
    '    <section className="card">',
    '      <header className="card__header">Header</header>',
    '      <p className="card__body">Body text</p>',
    '      <footer className="card__footer">Footer</footer>',
    '    </section>',
    '  )',
    '}',
    '',
  ].join('\n')

  function multiChildFixture(): { pageFile: string; loc: { line: number; col: number } } {
    const pageFile = write('pages/Home.tsx', MULTI_CHILD_SOURCE)
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    return { pageFile, loc }
  }

  it('is byte-identical to a promote with no slotChildren argument at all', () => {
    // Two independent workspaces, same fixture, same everything except one
    // passes `slotChildren: []` and the other omits the field entirely.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-subtree-a-'))
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-subtree-b-'))
    try {
      const fileA = path.join(dirA, 'pages', 'Home.tsx')
      fs.mkdirSync(path.dirname(fileA), { recursive: true })
      fs.writeFileSync(fileA, MULTI_CHILD_SOURCE, 'utf8')
      const fileB = path.join(dirB, 'pages', 'Home.tsx')
      fs.mkdirSync(path.dirname(fileB), { recursive: true })
      fs.writeFileSync(fileB, MULTI_CHILD_SOURCE, 'utf8')

      const loc = locateTag(MULTI_CHILD_SOURCE, 'section')
      const withoutArg = extractSubtreeToComponent({ file: fileA, line: loc.line, col: loc.col, workspaceRoot: dirA, componentName: 'CardA' })
      const withEmptyArray = extractSubtreeToComponent({
        file: fileB,
        line: loc.line,
        col: loc.col,
        workspaceRoot: dirB,
        componentName: 'CardA',
        slotChildren: [],
      })
      expect(withoutArg.ok).toBe(true)
      expect(withEmptyArray.ok).toBe(true)
      if (!withoutArg.ok || !withEmptyArray.ok) return

      expect(withEmptyArray.slots).toEqual([])
      expect(withEmptyArray.freeVariables).toEqual(withoutArg.freeVariables)

      const newFileTextA = fs.readFileSync(path.join(dirA, 'pages', 'CardA.tsx'), 'utf8')
      const newFileTextB = fs.readFileSync(path.join(dirB, 'pages', 'CardA.tsx'), 'utf8')
      expect(newFileTextB).toBe(newFileTextA)

      const pageTextA = fs.readFileSync(fileA, 'utf8')
      const pageTextB = fs.readFileSync(fileB, 'utf8')
      expect(pageTextB).toBe(pageTextA)
      expect(pageTextA).toContain('<CardA />')
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true })
      fs.rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('promotes one child as the conventional default "children" slot — {children} inside, JSX children at the call site', () => {
    const { pageFile, loc } = multiChildFixture()
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const headerIndex = candidates.find((c) => c.tagName === 'header')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', {
      slotChildren: [{ childIndex: headerIndex, slotName: 'children' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slots).toEqual([{ slotName: 'children' }])

    const newFileText = read('pages/Card.tsx')
    // Required, not optional — E2.1's own extraction always rewrites its one
    // call site to pass every slot it creates, unlike `addSlotPropToComponent`,
    // which must stay optional for N untouched existing call sites.
    expect(newFileText).toContain('children: ReactNode')
    expect(newFileText).not.toContain('children?: ReactNode')
    expect(newFileText).toContain('export function Card({ children }: CardProps)')
    expect(newFileText).toContain('{children}')
    expect(newFileText).not.toContain('Header</header>') // moved OUT, not duplicated

    const pageText = read('pages/Home.tsx')
    expect(pageText).toContain('<Card><header className="card__header">Header</header></Card>')
  })

  it('promotes two children as distinct NAMED slots — required props, header={<Original/>} at the call site', () => {
    const { pageFile, loc } = multiChildFixture()
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const headerIndex = candidates.find((c) => c.tagName === 'header')!.index
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', {
      slotChildren: [
        { childIndex: headerIndex, slotName: 'header' },
        { childIndex: footerIndex, slotName: 'footer' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slots).toEqual([{ slotName: 'header' }, { slotName: 'footer' }])

    const newFileText = read('pages/Card.tsx')
    expect(newFileText).toContain("import type { ReactNode } from 'react'")
    expect(newFileText).toContain('header: ReactNode') // required — this codemod's own single call site always supplies it
    expect(newFileText).toContain('footer: ReactNode')
    expect(newFileText).toContain('{header}')
    expect(newFileText).toContain('{footer}')
    // The KEPT middle child moved inline, byte-for-byte.
    expect(newFileText).toContain('<p className="card__body">Body text</p>')

    const pageText = read('pages/Home.tsx')
    expect(pageText).toContain('header={<header className="card__header">Header</header>}')
    expect(pageText).toContain('footer={<footer className="card__footer">Footer</footer>}')
    // Self-closing — no 'children' slot in this decision set, so there is no
    // separate `</Card>` closing tag.
    expect(pageText).not.toContain('</Card>')
    expect(pageText).toContain(' />')
  })

  it("forwards a prop AND a slot together — the prop stays name={name}, the slot stays verbatim markup", () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home({ title }: { title: string }) {',
      '  return (',
      '    <section>',
      '      <h1>{title}</h1>',
      '      <footer>Footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: footerIndex, slotName: 'footer' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.freeVariables.map((v) => v.name)).toEqual(['title'])
    expect(read('pages/Home.tsx')).toContain('<Card title={title} footer={<footer>Footer</footer>} />')
  })

  it('does not require mirroring an import used only inside a slotted (never-moved) child', () => {
    const pageFile = write('pages/Home.tsx', [
      "import { Icon } from '../components/Icon'",
      'export default function Home() {',
      '  return (',
      '    <section>',
      '      <p>Body</p>',
      '      <footer><Icon /></footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: footerIndex, slotName: 'footer' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // `Icon` is only ever referenced inside the SLOTTED footer, which never
    // moves into the new file — so it's not a free variable of Card.tsx at all.
    expect(result.freeVariables).toEqual([])
    expect(read('pages/Card.tsx')).not.toContain('Icon')
    // And the page's own Icon import survives — it's still used, just now at the call site.
    expect(read('pages/Home.tsx')).toContain("import { Icon } from '../components/Icon'")
    expect(read('pages/Home.tsx')).toContain('footer={<footer><Icon /></footer>}')
  })

  it('a spread inside a SLOTTED child does not refuse spread-props (it never enters the new interface)', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home({ rest }: { rest: Record<string, unknown> }) {',
      '  return (',
      '    <section>',
      '      <p>Body</p>',
      '      <footer {...rest}>Footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: footerIndex, slotName: 'footer' }] })
    expect(result.ok).toBe(true)
  })

  it('a spread inside KEPT content still refuses spread-props', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home({ rest }: { rest: Record<string, unknown> }) {',
      '  return (',
      '    <section>',
      '      <p {...rest}>Body</p>',
      '      <footer>Footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: footerIndex, slotName: 'footer' }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('spread-props')
  })

  it('refuses slot-name-conflict when two slot decisions want the same name', () => {
    const { pageFile, loc } = multiChildFixture()
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const headerIndex = candidates.find((c) => c.tagName === 'header')!.index
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', {
      slotChildren: [
        { childIndex: headerIndex, slotName: 'region' },
        { childIndex: footerIndex, slotName: 'region' },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('slot-name-conflict')
    expect(exists('pages/Card.tsx')).toBe(false)
  })

  it('refuses slot-name-conflict when a slot name collides with a forwarded prop', () => {
    const pageFile = write('pages/Home.tsx', [
      'export default function Home({ footer }: { footer: string }) {',
      '  return (',
      '    <section>',
      '      <p>{footer}</p>',
      '      <footer>Static</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('pages/Home.tsx'), 'section')
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const footerIndex = candidates.find((c) => c.tagName === 'footer')!.index

    const result = extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: footerIndex, slotName: 'footer' }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('slot-name-conflict')
  })

  it('throws for an out-of-range childIndex — a caller-contract violation', () => {
    const { pageFile, loc } = multiChildFixture()
    expect(() => extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: 99, slotName: 'header' }] })).toThrow()
  })

  it('throws for a duplicate childIndex', () => {
    const { pageFile, loc } = multiChildFixture()
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const headerIndex = candidates.find((c) => c.tagName === 'header')!.index
    expect(() =>
      extractAt(pageFile, loc.line, loc.col, 'Card', {
        slotChildren: [
          { childIndex: headerIndex, slotName: 'a' },
          { childIndex: headerIndex, slotName: 'b' },
        ],
      }),
    ).toThrow()
  })

  it('throws for an invalid slot name', () => {
    const { pageFile, loc } = multiChildFixture()
    const candidates = listSlotChildCandidates({ file: pageFile, line: loc.line, col: loc.col })
    const headerIndex = candidates.find((c) => c.tagName === 'header')!.index
    expect(() => extractAt(pageFile, loc.line, loc.col, 'Card', { slotChildren: [{ childIndex: headerIndex, slotName: '1bad' }] })).toThrow()
  })
})
