/**
 * P3-B — the parser half of "ordinary React renders" (audit 03: WB-4, WB-26,
 * WB-5). The end-to-end load + write-back round trips live in
 * `server/handlers/__tests__/studioOrdinaryReactShapes.test.ts`; this file
 * pins each SHAPE at the parser, including the refusals — a look-alike that is
 * not React's own export must NOT be treated as one, and a member tag that is
 * not a namespace member must not render some other component.
 *
 * The fixture is a small bookshop app, sharing nothing with the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  readPageComponent,
  reexportChainFiles,
  resolveComponentSources,
  type ParsedNode,
  type ParsedPage,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-react-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, lines: readonly string[]): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `${lines.join('\n')}\n`, 'utf8')
}

/** Parses + inlines exactly like `loadStudioPages` does for one page. */
function load(pageRel: string, dependencyFiles?: Set<string>): ParsedPage {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const evalOptions = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, evalOptions)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions, ...(dependencyFiles ? { dependencyFiles } : {}) })
}

const nodesOf = (page: ParsedPage): ParsedNode[] => Object.values(page.nodes)
const texts = (page: ParsedPage): string[] => nodesOf(page).flatMap((n) => (n.text === undefined ? [] : [n.text]))
const names = (page: ParsedPage): string[] => nodesOf(page).map((n) => n.name)

describe('WB-4 — memo and forwardRef are read as the function they wrap', () => {
  it('unwraps every spelling: memo, React.memo, a namespace import, an alias, forwardRef, nesting and a type cast', () => {
    write('ui/Cards.tsx', [
      "import React, { memo, forwardRef, memo as remember } from 'react'",
      "import * as R from 'react'",
      'export const A = memo(function A() { return <p>alpha</p> })',
      'export const B = React.memo(() => <p>beta</p>)',
      'export const C = R.memo(() => <p>gamma</p>)',
      'export const D = remember(() => <p>delta</p>)',
      'export const E = forwardRef<HTMLParagraphElement>((_props, ref) => <p ref={ref}>epsilon</p>)',
      'export const F = memo(forwardRef(function F(_props, ref) { return <p ref={ref}>zeta</p> }))',
      'function Inner() { return <p>eta</p> }',
      'export const G = memo(Inner) as typeof Inner',
    ])
    write('pages/Shelf.tsx', [
      "import { A, B, C, D, E, F, G } from '../ui/Cards'",
      'export default function Shelf() {',
      '  return <main><A /><B /><C /><D /><E /><F /><G /></main>',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page).sort()).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'eta', 'gamma', 'zeta'])
    // Every call site became an instance with the wrapped function's JSX under it.
    const instances = nodesOf(page).filter((n) => n.instanceOf)
    expect(instances).toHaveLength(7)
  })

  it('does NOT unwrap a memo that is not React\'s — a local function named memo could do anything', () => {
    write('ui/Cards.tsx', [
      'const memo = <T,>(component: T): T => component',
      'export const Own = memo(() => <p>own</p>)',
    ])
    write('pages/Shelf.tsx', [
      "import { Own } from '../ui/Cards'",
      'export default function Shelf() {',
      '  return <main><Own /></main>',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page)).toEqual([])
    const own = nodesOf(page).find((n) => n.name === 'Own')
    expect(own?.instanceOf).toBeUndefined()
  })

  it('reads a page whose own default export is memo(Page), with no wrapper note', () => {
    write('pages/Shelf.tsx', [
      "import { memo } from 'react'",
      'function Shelf() {',
      '  return <h1>Shelf</h1>',
      '}',
      'export default memo(Shelf)',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page)).toEqual(['Shelf'])
    expect(nodesOf(page)[0]?.resolution).toBeUndefined()
    expect(page.unreadableExport).toBeUndefined()
  })
})

describe('WB-4 — barrels and namespaces are followed to the declaring file', () => {
  beforeEach(() => {
    write('ui/Spine.tsx', ['const Spine = () => <b>spine</b>', 'export default Spine'])
    write('ui/Jacket.tsx', ["import { memo } from 'react'", 'export default memo(() => <i>jacket</i>)'])
    write('ui/Page.tsx', ['export function Leaf() { return <small>leaf</small> }'])
    write('ui/inner.ts', ["export * from './Page'"])
    write('ui/index.ts', [
      "export { default as Spine } from './Spine'",
      "export { default as Jacket } from './Jacket'",
      "export * from './inner'",
    ])
  })

  it('renders a default export re-exported by name, including an anonymous memo() default', () => {
    write('pages/Shelf.tsx', [
      "import { Spine, Jacket } from '../ui'",
      'export default function Shelf() {',
      '  return <main><Spine /><Jacket /></main>',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page).sort()).toEqual(['jacket', 'spine'])
    const spine = nodesOf(page).find((n) => n.text === 'spine')!
    expect(spine.loc.file).toBe('ui/Spine.tsx')
    expect(spine.id).toContain('~ui/Spine.tsx:')
  })

  it('renders a namespace member through two barrel hops, and records every hop as a dependency', () => {
    write('pages/Shelf.tsx', [
      "import * as UI from '../ui'",
      'export default function Shelf() {',
      '  return <main><UI.Leaf /></main>',
      '}',
    ])
    const dependencies = new Set<string>()
    const page = load('pages/Shelf.tsx', dependencies)
    expect(texts(page)).toEqual(['leaf'])
    const rel = [...dependencies].map((abs) => path.relative(tmpDir, abs).split(path.sep).join('/')).sort()
    // The declaring file, and each barrel between it and the page — re-pointing
    // any of them changes what renders here.
    expect(rel).toEqual(['ui/Page.tsx', 'ui/index.ts', 'ui/inner.ts'])
  })

  it('declines a member tag on a DEFAULT import — Card.Header is not Card', () => {
    write('ui/Card.tsx', [
      'function Card() { return <article>whole card</article> }',
      'Card.Header = function Header() { return <header>header only</header> }',
      'export default Card',
    ])
    write('pages/Shelf.tsx', [
      "import Card from '../ui/Card'",
      'export default function Shelf() {',
      '  return <main><Card.Header /></main>',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    // Before P3-B this rendered "whole card" at the Card.Header call site.
    expect(texts(page)).not.toContain('whole card')
    expect(nodesOf(page).find((n) => n.name === 'Card.Header')?.instanceOf).toBeUndefined()
  })

  it('names each file on the route a re-exported name takes', () => {
    const project = createWorkspaceProject(tmpDir)
    const barrel = project.getSourceFileOrThrow(path.join(tmpDir, 'ui', 'index.ts'))
    const hops = (name: string) =>
      reexportChainFiles(barrel, name).map((file) => path.relative(tmpDir, file.getFilePath()).split(path.sep).join('/'))
    expect(hops('Leaf')).toEqual(['ui/index.ts', 'ui/inner.ts', 'ui/Page.tsx'])
    expect(hops('Spine')).toEqual(['ui/index.ts', 'ui/Spine.tsx'])
    // A name nobody exports stops at the barrel itself.
    expect(hops('Missing')).toEqual(['ui/index.ts'])
  })
})

describe('WB-26 — React.Fragment is a fragment', () => {
  it('flattens React.Fragment, Fragment and an alias of it, keyed or not, into the parent', () => {
    write('pages/Shelf.tsx', [
      "import React, { Fragment, Fragment as Group } from 'react'",
      "const ROWS = ['one', 'two']",
      'export default function Shelf() {',
      '  return (',
      '    <ul>',
      '      <React.Fragment><li>first</li></React.Fragment>',
      '      <Fragment><li>second</li></Fragment>',
      '      <Group><li>third</li></Group>',
      '      {ROWS.map((row) => <React.Fragment key={row}><li>{row}</li></React.Fragment>)}',
      '      <React.Fragment />',
      '    </ul>',
      '  )',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(names(page).filter((name) => name.includes('Fragment') || name === 'Group')).toEqual([])
    const list = nodesOf(page).find((n) => n.name === 'ul')!
    expect(list.children.map((id) => page.nodes[id]!.text)).toEqual(['first', 'second', 'third', 'one', 'two'])
  })

  it('does NOT flatten a project component that happens to be called Fragment', () => {
    write('ui/Fragment.tsx', ['export function Fragment() { return <aside>own fragment</aside> }'])
    write('pages/Shelf.tsx', [
      "import { Fragment } from '../ui/Fragment'",
      'export default function Shelf() {',
      '  return <main><Fragment /></main>',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page)).toEqual(['own fragment'])
    expect(nodesOf(page).find((n) => n.name === 'Fragment')?.instanceOf?.componentName).toBe('Fragment')
  })
})

describe('WB-5 — a page renders from a class or through an unknown HOC, or names its shape', () => {
  it('reads a class page from render(), leaving this.props values code-valued rather than guessed', () => {
    write('pages/Shelf.tsx', [
      "import React from 'react'",
      'export default class Shelf extends React.Component<{ owner: string }> {',
      '  render() {',
      "    const heading = 'New arrivals'",
      '    return <section><h1>{heading}</h1><p>{this.props.owner}</p></section>',
      '  }',
      '}',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page)).toEqual(['New arrivals'])
    const owner = nodesOf(page).find((n) => n.name === 'p')!
    expect(owner.text).toBeUndefined()
    expect(owner.codeText).toBe(true)
  })

  it('reads the component an unknown HOC wraps, however the wrappers are stacked, and names them', () => {
    const shapes: Array<[string, string[], string]> = [
      ['connect(mapState)(Shelf)', ["const mapState = (s: unknown) => s"], 'connect(mapState)()'],
      ['withA(withB(Shelf))', [], 'withA() and withB()'],
      ['withData(loadBooks, Shelf)', ['function loadBooks() { return [] }'], 'withData()'],
    ]
    for (const [expr, extra, named] of shapes) {
      write('pages/Shelf.tsx', [
        "import { connect, withA, withB, withData } from '../lib/hoc'",
        ...extra,
        'function Shelf() {',
        '  return <h1>Shelf</h1>',
        '}',
        `export default ${expr}`,
      ])
      const page = load('pages/Shelf.tsx')
      expect(texts(page)).toEqual(['Shelf'])
      expect(nodesOf(page)[0]!.resolution?.note).toContain(named)
      // Structure is not in question — the markup is written right there.
      expect(nodesOf(page)[0]!.locked).toBe(false)
    }
  })

  it('reads a HOC applied one name away', () => {
    write('pages/Shelf.tsx', [
      "import { withLayout } from '../lib/hoc'",
      'const Shelf = () => <h1>Shelf</h1>',
      'const Wrapped = withLayout(Shelf)',
      'export default Wrapped',
    ])
    const page = load('pages/Shelf.tsx')
    expect(texts(page)).toEqual(['Shelf'])
    expect(nodesOf(page)[0]!.resolution?.note).toContain('withLayout()')
  })

  it('names every shape it cannot read, pointing at the default export', () => {
    const cases: Array<[string[], string, number]> = [
      [["import { lazy } from 'react'", "export default lazy(() => import('./Other'))"], 'a call to lazy()', 2],
      [["import Other from './Other'", 'export default Other'], "'Other', which is not a component declared in this file", 2],
      [["export { default } from './Other'"], "re-exported from './Other'", 1],
      [['export default class Shelf { toString() { return "shelf" } }'], 'a class with no render() that returns JSX', 1],
      [['export const books = []'], 'the file exports no React component', 1],
      [["export default { title: 'Shelf' }"], 'not a function or class component', 1],
    ]
    write('pages/Other.tsx', ['export default function Other() { return <p>other</p> }'])
    for (const [lines, shape, line] of cases) {
      write('pages/Shelf.tsx', lines)
      const page = load('pages/Shelf.tsx')
      expect(page.rootIds).toEqual([])
      expect(page.unreadableExport?.message).toContain('The default export of pages/Shelf.tsx is')
      expect(page.unreadableExport?.message).toContain(shape)
      expect(page.unreadableExport?.line).toBe(line)
    }
  })

  it('does not flag a readable component that simply renders nothing', () => {
    write('pages/Shelf.tsx', ['export default function Shelf() {', '  return null', '}'])
    const page = load('pages/Shelf.tsx')
    expect(page.rootIds).toEqual([])
    expect(page.unreadableExport).toBeUndefined()
  })

  it('never reaches for a component in another file through a wrapper — ids would name the wrong file', () => {
    write('ui/Inner.tsx', ['export default function Inner() { return <p>inner</p> }'])
    write('pages/Shelf.tsx', [
      "import { memo } from 'react'",
      "import Inner from '../ui/Inner'",
      'export default memo(Inner)',
    ])
    const project = createWorkspaceProject(tmpDir)
    const component = readPageComponent(project.getSourceFileOrThrow(path.join(tmpDir, 'pages', 'Shelf.tsx')))
    expect(component.kind).toBe('unreadable')
    // …and says so without claiming memo() needs running.
    expect(component.kind === 'unreadable' ? component.shape : '').toContain('memo() around a component that is not declared in this file')
  })
})
