/**
 * addSlotPropToComponent — E2.2's second operation. Covers all three type
 * surfaces (referenced interface, inline type literal, untyped/JS), the
 * "no parameters at all" brand-new-param path, the required-optional
 * distinction from `extractSubtreeToComponent`'s own slots, the blast-radius
 * report, and every refusal (`no-jsx-parent`, `unsupported-params`,
 * `unsupported-props-type`, `prop-name-taken`, `not-found`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { addSlotPropToComponent, type AddSlotPropToComponentResult } from '../addSlotPropToComponent'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-slot-prop-'))
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

function addSlotAt(
  file: string,
  exportName: string,
  line: number,
  col: number,
  slotName: string,
  extra: { preview?: boolean } = {},
): AddSlotPropToComponentResult {
  return addSlotPropToComponent({ file, exportName, line, col, workspaceRoot: tmpDir, slotName, ...extra })
}

describe('addSlotPropToComponent — success, by type surface', () => {
  it('adds an optional property to a REFERENCED interface, and the binding to the destructured pattern', () => {
    const file = write('components/Card.tsx', [
      'export interface CardProps {',
      '  title: string',
      '}',
      'export default function Card({ title }: CardProps) {',
      '  return (',
      '    <section>',
      '      <h1>{title}</h1>',
      '      <footer>Static footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slotName).toBe('footer')
    expect(result.callSites).toEqual([])

    const text = read('components/Card.tsx')
    expect(text).toContain("import type { ReactNode } from 'react'")
    expect(text).toContain('footer?: ReactNode')
    expect(text).toContain('{ title, footer }: CardProps')
    expect(text).toContain('{footer}')
    expect(text).not.toContain('Static footer</footer>')
  })

  it('adds an optional property to an INLINE type literal', () => {
    const file = write('components/Card.tsx', [
      'export default function Card({ title }: { title: string }) {',
      '  return (',
      '    <section>',
      '      <h1>{title}</h1>',
      '      <footer>Static</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    const text = read('components/Card.tsx')
    expect(text).toContain('title: string')
    expect(text).toContain('footer?: ReactNode')
    expect(text).toContain('{ title, footer }')
    expect(text).not.toContain('Static</footer>')
  })

  it('adds only the binding, no type annotation, for an UNTYPED parameter (JS honesty)', () => {
    const file = write('components/Card.jsx', [
      'export default function Card({ title }) {',
      '  return (',
      '    <section>',
      '      <h1>{title}</h1>',
      '      <footer>Static</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.jsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    const text = read('components/Card.jsx')
    expect(text).toContain('{ title, footer }')
    expect(text).not.toContain('ReactNode')
  })

  it('adds a brand-new destructured parameter (and interface, in TS) when the component takes none today', () => {
    const file = write('components/Static.tsx', [
      'export default function Static() {',
      '  return (',
      '    <section>',
      '      <p>Body</p>',
      '      <footer>Static footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Static.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    const text = read('components/Static.tsx')
    expect(text).toContain('interface StaticProps')
    expect(text).toContain('footer?: ReactNode')
    expect(text).toContain('function Static({ footer }: StaticProps)')
    expect(text).toContain('{footer}')
  })

  it('adds a brand-new UNTYPED parameter for a zero-param JS component', () => {
    const file = write('components/Static.jsx', [
      'export default function Static() {',
      '  return (',
      '    <section>',
      '      <p>Body</p>',
      '      <footer>Static footer</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Static.jsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    const text = read('components/Static.jsx')
    expect(text).toContain('function Static({ footer })')
    expect(text).not.toContain('interface')
  })

  it('names the conventional default slot "children" when the caller passes it', () => {
    const file = write('components/Card.tsx', [
      'export default function Card() {',
      '  return (',
      '    <section>',
      '      <p>Body</p>',
      '      <footer>Static</footer>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'children')
    expect(result.ok).toBe(true)
    expect(read('components/Card.tsx')).toContain('children?: ReactNode')
  })

  it('resolves a NAMED export among several components in one file', () => {
    const file = write('components/Both.tsx', [
      'export function CardA({ title }: { title: string }) {',
      '  return <section><h1>{title}</h1><footer>A</footer></section>',
      '}',
      'export function CardB({ title }: { title: string }) {',
      '  return <section><h1>{title}</h1><footer>B</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Both.tsx'), 'footer', 2)

    const result = addSlotAt(file, 'CardB', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    const text = read('components/Both.tsx')
    // Only CardB's own footer became a slot — CardA's is untouched.
    expect(text).toContain('<footer>A</footer>')
    expect(text).not.toContain('<footer>B</footer>')
  })
})

describe('addSlotPropToComponent — blast radius (findComponentCallSites)', () => {
  it('reports every existing call site on success', () => {
    const file = write('components/Card.tsx', [
      'export default function Card({ title }: { title: string }) {',
      '  return <section><h1>{title}</h1><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.tsx', ["import Card from '../components/Card'", 'export default function Home() {', '  return <Card title="a" />', '}', ''].join('\n'))
    write('pages/About.tsx', ["import Card from '../components/Card'", 'export default function About() {', '  return <Card title="b" />', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.committed).toBe(true)
    expect(result.callSites).toHaveLength(2)
    expect(result.callSites.map((c) => c.file).sort()).toEqual(['pages/About.tsx', 'pages/Home.tsx'])
  })
})

describe('addSlotPropToComponent — preview (the enforced "blast radius up front" path)', () => {
  it('reports the blast radius WITHOUT writing anything to disk', () => {
    const file = write('components/Card.tsx', [
      'export default function Card({ title }: { title: string }) {',
      '  return <section><h1>{title}</h1><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.tsx', ["import Card from '../components/Card'", 'export default function Home() {', '  return <Card title="a" />', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')
    const before = read('components/Card.tsx')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer', { preview: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.committed).toBe(false)
    expect(result.callSites).toHaveLength(1)
    // Disk is byte-for-byte unchanged — a preview really did nothing.
    expect(read('components/Card.tsx')).toBe(before)
  })

  it('a preview that says OK is a real guarantee — the follow-up commit (fresh call, same file) also succeeds and matches the preview\'s own callSites', () => {
    const file = write('components/Card.tsx', [
      'export default function Card({ title }: { title: string }) {',
      '  return <section><h1>{title}</h1><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.tsx', ["import Card from '../components/Card'", 'export default function Home() {', '  return <Card title="a" />', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const preview = addSlotAt(file, 'default', loc.line, loc.col, 'footer', { preview: true })
    expect(preview.ok).toBe(true)

    const commit = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(commit.ok).toBe(true)
    if (!preview.ok || !commit.ok) return
    expect(commit.committed).toBe(true)
    expect(commit.callSites).toEqual(preview.callSites)
    expect(read('components/Card.tsx')).toContain('footer?: ReactNode')
  })

  it('still refuses in preview mode exactly like a commit would (unsupported-params)', () => {
    const file = write('components/Card.tsx', [
      'export default function Card(props: { title: string }) {',
      '  return <section><h1>{props.title}</h1><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer', { preview: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('unsupported-params')
  })
})

describe('addSlotPropToComponent — refusals', () => {
  it('refuses no-jsx-parent when the target is the component\'s entire returned markup', () => {
    const file = write('components/Card.tsx', ['export default function Card() {', '  return <section>Only content</section>', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'section')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'children')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('no-jsx-parent')
  })

  it('refuses unsupported-params for an undestructured props parameter', () => {
    const file = write('components/Card.tsx', [
      'export default function Card(props: { title: string }) {',
      '  return <section><h1>{props.title}</h1><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('unsupported-params')
  })

  it('refuses unsupported-props-type for a props type this codemod cannot add a property to (a union alias)', () => {
    // Destructured (so `unsupported-params` doesn't fire first) but typed
    // against a union alias, which has no single object shape to add a
    // property to.
    const file = write('components/Card.tsx', [
      'type CardProps = { title: string } | { subtitle: string }',
      'export default function Card({ title }: CardProps) {',
      '  return <section><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('unsupported-props-type')
  })

  it('refuses prop-name-taken when the component already has a prop of that name', () => {
    const file = write('components/Card.tsx', [
      'export default function Card({ footer }: { footer: string }) {',
      '  return <section><p>{footer}</p><footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('prop-name-taken')
  })

  it('refuses prop-name-taken for "children" when the component already destructures children', () => {
    const file = write('components/Card.tsx', [
      "import type { ReactNode } from 'react'",
      'export default function Card({ children }: { children: ReactNode }) {',
      '  return <section>{children}<footer>Static</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'default', loc.line, loc.col, 'children')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('prop-name-taken')
  })

  it('refuses not-found for a stale/renamed exportName', () => {
    const file = write('components/Card.tsx', ['export default function Card() {', '  return <section><footer>Static</footer></section>', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    const result = addSlotAt(file, 'Nope', loc.line, loc.col, 'footer')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('not-found')
  })

  it('throws for an invalid slot name — a caller-contract violation', () => {
    const file = write('components/Card.tsx', ['export default function Card() {', '  return <section><footer>Static</footer></section>', '}', ''].join('\n'))
    const loc = locateTag(read('components/Card.tsx'), 'footer')

    expect(() => addSlotAt(file, 'default', loc.line, loc.col, '1bad')).toThrow()
  })

  it('throws when the location does not sit inside the named export\'s own returned JSX', () => {
    const file = write('components/Both.tsx', [
      'export function CardA() {',
      '  return <section><footer>A</footer></section>',
      '}',
      'export function CardB() {',
      '  return <section><footer>B</footer></section>',
      '}',
      '',
    ].join('\n'))
    const loc = locateTag(read('components/Both.tsx'), 'footer', 2) // CardB's footer

    // Asking to edit CardA at a location that's actually inside CardB.
    expect(() => addSlotAt(file, 'CardA', loc.line, loc.col, 'footer')).toThrow()
  })
})
