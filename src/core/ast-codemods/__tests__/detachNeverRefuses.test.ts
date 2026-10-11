/**
 * detachComponentInstance — G-3 (OD-21/OD-23): what used to be a refusal is an
 * outcome.
 *
 *   - a component that keeps state (`useState`, `useReducer`, `useRef`) detaches
 *     into a page whose call site is hook-legal: the state is hoisted to the top
 *     of the enclosing component under fresh names, and reported (`movedHooks`);
 *   - `props.x` is read like a destructured `x`, `props.children` is placed like
 *     `{children}`, `{...props}` forwards the call site's attributes, and
 *     `const { x } = props` in the body is a destructure;
 *   - a component that maps over one of its own props keeps its `.map` over the
 *     call site's array (a literal, or whatever expression the call site gave).
 *
 * What still refuses stays byte-identical and says why (a call site inside a
 * list row, a state starting from a prop, an effect, a type only the component's
 * file knows).
 *
 * The fixtures are a storefront, a settings page and a notes list: they share
 * nothing with the eSIM corpus (the `genericRepoShapes.test.ts` discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance, type DetachRefusalReason, type DetachResult } from '../detachComponent'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detach-never-refuses-'))
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

const read = (relPath: string) => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

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

function detach(pageRel: string, source: string, tag: string, occurrence = 1): { result: DetachResult; text: string } {
  const file = write(pageRel, source)
  const { line, col } = locateTag(source, tag, occurrence)
  const result = detachComponentInstance({ file, line, col, workspaceRoot: tmpDir })
  return { result, text: read(pageRel) }
}

function expectDetached(pageRel: string, source: string, tag: string, occurrence = 1): string {
  const { result, text } = detach(pageRel, source, tag, occurrence)
  if (process.env.DBG && result.ok) console.log(`-----\n${text}`)
  if (!result.ok) throw new Error(`expected a detach, got a ${result.refusal.reason} refusal: ${result.refusal.message}`)
  return text
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

describe('G-3 - a component that keeps state detaches: the state moves up under fresh names', () => {
  const QUANTITY = [
    "import { useState } from 'react'",
    'export function Quantity({ label }: { label: string }) {',
    '  const [count, setCount] = useState(1)',
    '  return (',
    '    <div className="qty">',
    '      <span>{label}</span>',
    '      <button type="button" onClick={() => setCount(count + 1)}>{count}</button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')

  it('hoists useState to the top of the enclosing component and reads it from the markup', () => {
    write('components/Quantity.tsx', QUANTITY)
    const text = expectDetached(
      'pages/Cart.tsx',
      [
        "import { Quantity } from '../components/Quantity'",
        'export default function Cart() {',
        '  return (',
        '    <main>',
        '      <Quantity label="Kettles" />',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'Quantity',
    )
    expect(text).toContain("import { useState } from 'react'")
    expect(text).toContain('  const [count, setCount] = useState(1)\n  return (')
    expect(text).toContain('<span>Kettles</span>')
    expect(text).toContain('onClick={() => setCount(count + 1)}>{count}</button>')
    expect(text).not.toContain('<Quantity')
    expect(text).not.toContain("components/Quantity'")
    expect(read('components/Quantity.tsx')).toBe(QUANTITY)
  })

  it('reports the move (movedHooks, lossy) so the editor can say it before writing', () => {
    write('components/Quantity.tsx', QUANTITY)
    const source = [
      "import { Quantity } from '../components/Quantity'",
      'export default function Cart() {',
      '  return <Quantity label="Kettles" />',
      '}',
      '',
    ].join('\n')
    const file = write('pages/Cart.tsx', source)
    const { line, col } = locateTag(source, 'Quantity')
    const result = detachComponentInstance({ file, line, col, workspaceRoot: tmpDir, dryRun: 'always' })
    expect(result.ok && result.movedHooks).toEqual(['useState'])
    expect(result.ok && result.lossy).toBe(true)
    expect(read('pages/Cart.tsx')).toBe(source)
  })

  it('gives a second instance its own state: the names are fresh', () => {
    write('components/Quantity.tsx', QUANTITY)
    const page = [
      "import { Quantity } from '../components/Quantity'",
      'export default function Cart() {',
      '  return (',
      '    <main>',
      '      <Quantity label="Kettles" />',
      '      <Quantity label="Mugs" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')
    const once = expectDetached('pages/Cart.tsx', page, 'Quantity', 1)
    const twice = expectDetached('pages/Cart.tsx', once, 'Quantity')
    expect(twice).toContain('const [count, setCount] = useState(1)')
    expect(twice).toContain('const [count2, setCount2] = useState(1)')
    expect(twice).toContain('onClick={() => setCount2(count2 + 1)}>{count2}</button>')
    expect(twice.match(/import \{ useState \} from 'react'/g)).toHaveLength(1)
  })

  it('reuses the page\'s own react import and keeps a typed initial value', () => {
    write('components/Search.tsx', [
      "import { useState } from 'react'",
      'export function Search() {',
      "  const [query, setQuery] = useState<string | null>(null)",
      '  return <input value={query ?? ""} onChange={(e) => setQuery(e.target.value)} />',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      [
        "import { useEffect, useState } from 'react'",
        "import { Search } from '../components/Search'",
        'export default function Home() {',
        '  const [open, setOpen] = useState(false)',
        '  useEffect(() => {}, [open])',
        '  return <main onClick={() => setOpen(!open)}><Search /></main>',
        '}',
        '',
      ].join('\n'),
      'Search',
    )
    expect(text).toContain("const [query, setQuery] = useState<string | null>(null)\n  const [open, setOpen] = useState(false)")
    expect(text.match(/from 'react'/g)).toHaveLength(1)
    expect(text).toContain('<input value={query ?? ""} onChange={(e) => setQuery(e.target.value)} />')
  })

  it('hoists useRef (typed with a DOM type) and useReducer (a module-scope reducer is imported)', () => {
    write('components/Panel.tsx', [
      "import { useReducer, useRef } from 'react'",
      'export function reduce(state: { open: boolean }) {',
      '  return { open: !state.open }',
      '}',
      'export function Panel() {',
      '  const box = useRef<HTMLDivElement>(null)',
      '  const [state, toggle] = useReducer(reduce, { open: false })',
      '  return <div ref={box} onClick={toggle}>{state.open ? "open" : "closed"}</div>',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Panel } from '../components/Panel'", 'export default function Home() {', '  return <Panel />', '}', ''].join('\n'),
      'Panel',
    )
    expect(text).toContain('const box = useRef<HTMLDivElement>(null)')
    expect(text).toContain('const [state, toggle] = useReducer(reduce, { open: false })')
    expect(text).toMatch(/import \{[^}]*\breduce\b[^}]*\} from '..\/components\/Panel'/)
    expect(text).toMatch(/import \{[^}]*\buseReducer\b[^}]*\} from 'react'/)
    expect(text).toContain('<div ref={box} onClick={toggle}>{state.open ? "open" : "closed"}</div>')
  })

  it('writes the hooks into a concise arrow component by giving it a block body', () => {
    write('components/Quantity.tsx', QUANTITY)
    const text = expectDetached(
      'pages/Cart.tsx',
      ["import { Quantity } from '../components/Quantity'", 'export default () => (', '  <main><Quantity label="x" /></main>', ')', ''].join('\n'),
      'Quantity',
    )
    expect(text).toContain('const [count, setCount] = useState(1)')
    expect(text).toContain('return ')
  })

  it("makes the page a client component when the state came from a 'use client' file", () => {
    write('components/Toggle.tsx', [
      "'use client'",
      "import { useState } from 'react'",
      'export function Toggle() {',
      '  const [on, setOn] = useState(false)',
      '  return <button onClick={() => setOn(!on)}>{on ? "on" : "off"}</button>',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'app/page.tsx',
      ["import { Toggle } from '../components/Toggle'", 'export default function Page() {', '  return <main><Toggle /></main>', '}', ''].join('\n'),
      'Toggle',
    )
    expect(text.startsWith("'use client'")).toBe(true)
    expect(text).toContain('const [on, setOn] = useState(false)')
  })

  it('refuses, byte-identical, when the call site is inside a list row: one state would be shared by every row', () => {
    write('components/Quantity.tsx', QUANTITY)
    const message = expectRefusedUntouched(
      'pages/Cart.tsx',
      [
        "import { Quantity } from '../components/Quantity'",
        "const ITEMS = ['Kettle', 'Mug']",
        'export default function Cart() {',
        '  return <main>{ITEMS.map((name) => <Quantity key={name} label={name} />)}</main>',
        '}',
        '',
      ].join('\n'),
      'Quantity',
      'uses-hooks',
    )
    expect(message).toContain('once per row')
  })

  it("starts the hoisted state from the call site's own value when the component starts it from a prop", () => {
    write('components/Start.tsx', [
      "import { useState } from 'react'",
      'export function Start({ initial = 7 }: { initial?: number }) {',
      '  const [n, setN] = useState(initial)',
      '  return <button onClick={() => setN(n + 1)}>{n}</button>',
      '}',
      '',
    ].join('\n'))
    const page = ["import { Start } from '../components/Start'", 'export default function A() {', '  return <main><Start initial={3} /><Start /></main>', '}', ''].join('\n')
    const once = expectDetached('pages/A.tsx', page, 'Start')
    expect(once).toContain('const [n, setN] = useState(3)')
    expect(expectDetached('pages/A.tsx', once, 'Start')).toContain('const [n2, setN2] = useState(7)')
  })

  it('refuses, byte-identical, a state that starts from a value the call site computes, an effect, and a type only the component knows', () => {
    write('components/Start.tsx', [
      "import { useState } from 'react'",
      'export function Start({ initial }: { initial: number }) {',
      '  const [n, setN] = useState(initial)',
      '  return <button onClick={() => setN(n + 1)}>{n}</button>',
      '}',
      '',
    ].join('\n'))
    expectRefusedUntouched(
      'pages/A.tsx',
      ["import { Start } from '../components/Start'", 'export default function A({ seed }: { seed: number }) {', '  return <Start initial={seed} />', '}', ''].join('\n'),
      'Start',
      'uses-hooks',
    )

    write('components/Ticker.tsx', [
      "import { useEffect, useState } from 'react'",
      'export function Ticker() {',
      '  const [n, setN] = useState(0)',
      '  useEffect(() => { setN(1) }, [])',
      '  return <i>{n}</i>',
      '}',
      '',
    ].join('\n'))
    expectRefusedUntouched('pages/B.tsx', ["import { Ticker } from '../components/Ticker'", 'export default function B() {', '  return <Ticker />', '}', ''].join('\n'), 'Ticker', 'uses-hooks')

    write('components/Typed.tsx', [
      "import { useState } from 'react'",
      'type Sort = { by: string }',
      'export function Typed() {',
      '  const [sort, setSort] = useState<Sort | null>(null)',
      '  return <i onClick={() => setSort({ by: "a" })}>{sort?.by}</i>',
      '}',
      '',
    ].join('\n'))
    expectRefusedUntouched('pages/C.tsx', ["import { Typed } from '../components/Typed'", 'export default function C() {', '  return <Typed />', '}', ''].join('\n'), 'Typed', 'uses-hooks')
  })
})

describe('G-3 - props.x is a destructured prop', () => {
  it("substitutes props.title, places props.children, and reads the call site's attributes", () => {
    write('components/Banner.tsx', [
      'export function Banner(props) {',
      '  return (',
      '    <aside className="banner" id={props.id}>',
      '      <h3>{props.title}</h3>',
      '      {props.children}',
      '    </aside>',
      '  )',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      [
        "import { Banner } from '../components/Banner'",
        'export default function Home() {',
        '  return (',
        '    <main>',
        '      <Banner title="Sale" id="top"><p>Today only</p></Banner>',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'Banner',
    )
    expect(text).toContain('<aside className="banner" id="top">')
    expect(text).toContain('<h3>Sale</h3>')
    expect(text).toContain('<p>Today only</p>')
    expect(text).not.toContain('props')
    expect(text).not.toContain('<Banner')
  })

  it("writes {...props} as the call site's own attributes", () => {
    write('components/Link.tsx', ['export function Link(props) {', '  return <a className="link" {...props} />', '}', ''].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Link } from '../components/Link'", 'export default function Home() {', '  return <nav><Link href="/a" target="_blank" /></nav>', '}', ''].join('\n'),
      'Link',
    )
    expect(text).toContain('<a className="link" href="/a" target="_blank" />')
  })

  it('refuses {...props} when the call site also passes children: they would be forwarded, not placed', () => {
    write('components/Box.tsx', ['export function Box(props) {', '  return <div {...props} />', '}', ''].join('\n'))
    expectRefusedUntouched(
      'pages/Home.tsx',
      ["import { Box } from '../components/Box'", 'export default function Home() {', '  return <Box id="x"><b>hi</b></Box>', '}', ''].join('\n'),
      'Box',
      'spread-ambiguous',
    )
  })

  it('treats `const { title, tone = "plain" } = props` in the body as the destructure it is', () => {
    write('components/Note.tsx', [
      'export function Note(props: { title: string; tone?: string }) {',
      "  const { title, tone = 'plain' } = props",
      '  return <p className={tone}>{title}</p>',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Note } from '../components/Note'", 'export default function Home() {', '  return <main><Note title="Hi" /><Note title="Yo" tone="loud" /></main>', '}', ''].join('\n'),
      'Note',
    )
    expect(text).toContain('<p className="plain">Hi</p>')
    expect(text).toContain('<Note title="Yo" tone="loud" />')
  })

  it('does not drop a prop the body also destructures: props.title still reads the call site', () => {
    write('components/Both.tsx', [
      'export function Both(props: { title: string; sub: string }) {',
      '  const { title } = props',
      '  return <p>{title} / {props.title} / {props.sub}</p>',
      '}',
      '',
    ].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Both } from '../components/Both'", 'export default function Home() {', '  return <Both title="A" sub="B" />', '}', ''].join('\n'),
      'Both',
    )
    expect(text).toContain('<p>A / A / B</p>')
  })

  it('still refuses a call site that spreads into a whole-props component, by name', () => {
    write('components/Card.tsx', ['export function Card(props) {', '  return <div>{props.title}</div>', '}', ''].join('\n'))
    expectRefusedUntouched(
      'pages/Home.tsx',
      ["import { Card } from '../components/Card'", 'const shared = { title: "x" }', 'export default function Home() {', '  return <Card {...shared} />', '}', ''].join('\n'),
      'Card',
      'spread-ambiguous',
    )
  })
})

describe('G-3 - a component that maps over its own props keeps the .map over the call site\'s array', () => {
  const LIST = [
    'export function NoteList({ notes, empty = [] }: { notes: string[]; empty?: string[] }) {',
    '  return (',
    '    <ul>',
    '      {notes.map((note) => <li key={note}>{note}</li>)}',
    '      {empty.map((note) => <li key={note}>{note}</li>)}',
    '    </ul>',
    '  )',
    '}',
    '',
  ].join('\n')

  it('substitutes an array literal, and the default for an omitted prop', () => {
    write('components/NoteList.tsx', LIST)
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { NoteList } from '../components/NoteList'", 'export default function Home() {', "  return <NoteList notes={['a', 'b']} />", '}', ''].join('\n'),
      'NoteList',
    )
    expect(text).toContain("{['a', 'b'].map((note) => <li key={note}>{note}</li>)}")
    expect(text).toContain('{[].map((note) => <li key={note}>{note}</li>)}')
  })

  it('substitutes the call site\'s own expression and keeps it data-driven', () => {
    write('components/NoteList.tsx', LIST)
    const text = expectDetached(
      'pages/Home.tsx',
      [
        "import { NoteList } from '../components/NoteList'",
        'export default function Home({ inbox }: { inbox: { notes: string[] } }) {',
        '  return <NoteList notes={inbox.notes} />',
        '}',
        '',
      ].join('\n'),
      'NoteList',
    )
    expect(text).toContain('{inbox.notes.map((note) => <li key={note}>{note}</li>)}')
  })

  it('reads props.items.map the same way', () => {
    write('components/Bag.tsx', ['export function Bag(props) {', '  return <ul>{props.items.map((x) => <li key={x}>{x}</li>)}</ul>', '}', ''].join('\n'))
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Bag } from '../components/Bag'", 'export default function Home() {', '  return <Bag items={[1, 2]} />', '}', ''].join('\n'),
      'Bag',
    )
    expect(text).toContain('<ul>{[1, 2].map((x) => <li key={x}>{x}</li>)}</ul>')
  })

  it('refuses, naming the capture, when the row\'s own binding would capture a name the call site passes', () => {
    write('components/NoteList.tsx', ['export function NoteList({ notes, tag }: { notes: string[]; tag: string }) {', '  return <ul>{notes.map((tag2) => <li key={tag2}>{tag}</li>)}</ul>', '}', ''].join('\n'))
    // `note` at the call site, `note` bound by the component's own callback: the value would read the wrong one.
    write('components/Capture.tsx', ['export function Capture({ notes, label }: { notes: string[]; label: string }) {', '  return <ul>{notes.map((note) => <li key={note}>{label}</li>)}</ul>', '}', ''].join('\n'))
    expectRefusedUntouched(
      'pages/Home.tsx',
      [
        "import { Capture } from '../components/Capture'",
        'export default function Home({ note }: { note: string }) {',
        '  return <Capture notes={["a"]} label={note} />',
        '}',
        '',
      ].join('\n'),
      'Capture',
      'name-collision',
    )
  })
})

describe("OD-21 - a component from the project's design-system/ folder detaches as local code", () => {
  /** The real vendored design system, placed where Studio writes it - a fixture that is not ours to simplify. */
  function placeDesignSystem(): void {
    const vendor = path.resolve(import.meta.dir, '..', '..', '..', '..', 'vendor', 'alm-design-system', 'src')
    // Every source file; not the ~570 icon SVGs, which nothing under test reads.
    fs.cpSync(vendor, path.join(tmpDir, 'design-system'), { recursive: true, filter: (from) => !/\/icons\/(line-icons|logotypes)/.test(from.split(path.sep).join('/')) })
  }

  it("inlines the design system's Chip into the page, bound to the call site's own props", () => {
    placeDesignSystem()
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Chip } from '../design-system'", 'export default function Home() {', '  return <main><Chip label="Sale" selected /></main>', '}', ''].join('\n'),
      'Chip',
    )
    expect(text).not.toContain('<Chip')
    expect(text).toContain('chip--selected')
    expect(text).toContain('<span className="chip__label">Sale</span>')
    expect(text).toContain("import '../design-system/components/Chip.css'")
  })

  it('leaves the design-system folder byte-identical, whatever it inlines', () => {
    placeDesignSystem()
    const before = snapshotWorkspace()
    expectDetached(
      'pages/Home.tsx',
      ["import { Separator } from '../design-system'", 'export default function Home() {', '  return <Separator variant="dashed" />', '}', ''].join('\n'),
      'Separator',
    )
    for (const [file, text] of before) {
      if (file.includes('design-system')) expect(fs.readFileSync(file, 'latin1')).toBe(text)
    }
  })

  it("hands a context reader the call site's prop: useDir(dir) with no dir is useDir(undefined) at the top of the page's component", () => {
    write('design-system/context.js', [
      "import { createContext, useContext } from 'react'",
      "export const DirContext = createContext('ltr')",
      'export const useDir = (propDir) => {',
      '  const fromProvider = useContext(DirContext)',
      '  return propDir ?? fromProvider',
      '}',
      '',
    ].join('\n'))
    write('design-system/components/Panel.jsx', [
      "import { useDir } from '../context'",
      'export function Panel({ dir, title }) {',
      '  const d = useDir(dir)',
      '  return <section dir={d}><h2>{title}</h2></section>',
      '}',
      '',
    ].join('\n'))
    write('design-system/index.js', "export { Panel } from './components/Panel'" + '\n')
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Panel } from '../design-system'", 'export default function Home() {', '  return <main><Panel title="Hi" /><Panel title="Yo" dir="rtl" /></main>', '}', ''].join('\n'),
      'Panel',
    )
    expect(text).toContain('const d = useDir(undefined)')
    expect(text).toContain('<section dir={d}><h2>Hi</h2></section>')
    expect(text).toMatch(/import { useDir } from '..\/design-system\/context'/)
    const second = expectDetached('pages/Home.tsx', text, 'Panel')
    expect(second).toContain('const d2 = useDir("rtl")')
  })

  it('still names what cannot be inlined: a private helper the design system does not export', () => {
    placeDesignSystem()
    const message = expectRefusedUntouched(
      'pages/Home.tsx',
      ["import { Dialog } from '../design-system'", 'export default function Home() {', '  return <Dialog />', '}', ''].join('\n'),
      'Dialog',
      'unbound-reference',
    )
    expect(message).toContain('does not export')
  })
})

describe('G-3 - a component that renders several roots detaches into plain siblings', () => {
  const PAIR = ['export function Pair({ a, b }: { a: string; b: string }) {', '  return <><dt>{a}</dt><dd>{b}</dd></>', '}', ''].join('\n')

  it("writes the roots between the parent's own children, not inside a fragment", () => {
    write('components/Pair.tsx', PAIR)
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Pair } from '../components/Pair'", 'export default function Home() {', '  return <dl><dt>first</dt><Pair a="K" b="V" /><dd>last</dd></dl>', '}', ''].join('\n'),
      'Pair',
    )
    expect(text).toContain('<dl><dt>first</dt><dt>K</dt><dd>V</dd><dd>last</dd></dl>')
    expect(text).not.toContain('<>')
  })

  it("keeps the fragment where it is the page component's whole return value", () => {
    write('components/Pair.tsx', PAIR)
    const text = expectDetached(
      'pages/Home.tsx',
      ["import { Pair } from '../components/Pair'", 'export default function Home() {', '  return <Pair a="K" b="V" />', '}', ''].join('\n'),
      'Pair',
    )
    expect(text).toContain('return <><dt>K</dt><dd>V</dd></>')
  })
})
