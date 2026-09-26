/**
 * OD-8 — every `.map` row ROOT is stamped with the array element it renders
 * (`ParsedNode.listRow`), or with why there is no array Studio can edit.
 *
 * A kanban board and a settings page: nothing from the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline). The refusals are asserted as
 * carefully as the successes — a row stamped `array` is a row the editor
 * will WRITE through, so a wrong stamp is a write into the wrong place.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPageEvalBudget, createWorkspaceProject, parsePageFile, type ParsedNode } from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-row-source-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function parse(pageRel: string): ParsedNode[] {
  const project = createWorkspaceProject(tmpDir)
  const file = path.join(tmpDir, ...pageRel.split('/'))
  return Object.values(parsePageFile(file, tmpDir, project, { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }).nodes)
}

const rows = (nodes: ParsedNode[], tag: string) => nodes.filter((node) => node.name === tag)

describe('listRow — a row tied to its array element', () => {
  it('a module const: every row root names the literal, its index, the length and the key field', () => {
    write(
      'src/Board.tsx',
      [
        "import './board.css'",
        'const COLUMNS = [',
        "  { id: 'todo', title: 'To do' },",
        "  { id: 'doing', title: 'Doing' },",
        "  { id: 'done', title: 'Done' },",
        ']',
        'export default function Board() {',
        '  return (',
        '    <main>',
        '      {COLUMNS.map((column) => (',
        '        <section key={column.id}><h2>{column.title}</h2></section>',
        '      ))}',
        '    </main>',
        '  )',
        '}',
      ].join('\n'),
    )
    const nodes = parse('src/Board.tsx')
    const sections = rows(nodes, 'section')
    expect(sections.map((node) => node.listRow)).toEqual([0, 1, 2].map((index) => ({
      kind: 'array',
      array: 'src/Board.tsx:2:17',
      index,
      length: 3,
      key: { kind: 'field', field: 'id' },
      source: 'COLUMNS',
    })))
    // Only the ROOT stands for the element: what is inside a row is not stamped.
    expect(rows(nodes, 'h2').every((node) => node.listRow === undefined)).toBe(true)
  })

  it('an inline literal and a component-body const, with an index key and a destructured key', () => {
    write(
      'src/Settings.tsx',
      [
        'export default function Settings() {',
        "  const TABS = [{ slug: 'profile' }, { slug: 'billing' }]",
        '  return (',
        '    <div>',
        "      <nav>{['General', 'Security'].map((label, i) => <a key={i}>{label}</a>)}</nav>",
        '      <ul>{TABS.map(({ slug }) => <li key={slug}>{slug}</li>)}</ul>',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    )
    const nodes = parse('src/Settings.tsx')
    expect(rows(nodes, 'a').map((node) => node.listRow)).toEqual([0, 1].map((index) => ({
      kind: 'array',
      array: 'src/Settings.tsx:5:13',
      index,
      length: 2,
      key: { kind: 'none' },
      source: "['General', 'Security']",
    })))
    expect(rows(nodes, 'li').map((node) => node.listRow)).toEqual([0, 1].map((index) => ({
      kind: 'array',
      array: 'src/Settings.tsx:2:16',
      index,
      length: 2,
      key: { kind: 'field', field: 'slug' },
      source: 'TABS',
    })))
  })
})

describe('listRow — refusals, by name', () => {
  const refusalOf = (nodes: ParsedNode[], tag: string) => rows(nodes, tag).map((node) => node.listRow?.kind === 'refused' ? node.listRow.reason : node.listRow?.kind)

  it('imported: the items are written in another file', () => {
    write('src/data.ts', "export const LANES = ['a', 'b']\n")
    write(
      'src/Lanes.tsx',
      "import { LANES } from './data'\nexport default function Lanes() {\n  return <ol>{LANES.map((lane) => <li key={lane}>{lane}</li>)}</ol>\n}\n",
    )
    expect(refusalOf(parse('src/Lanes.tsx'), 'li')).toEqual(['imported', 'imported'])
  })

  it('computed: a `.filter()`, and a `let` that may be reassigned', () => {
    write(
      'src/Open.tsx',
      [
        "const CARDS = [{ id: 1, open: true }, { id: 2, open: true }]",
        "let TAGS = ['x', 'y']",
        'export default function Open() {',
        '  return (',
        '    <div>',
        '      {CARDS.filter((card) => card.open).map((card) => <p key={card.id}>{card.id}</p>)}',
        '      {TAGS.map((tag) => <b key={tag}>{tag}</b>)}',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    )
    const nodes = parse('src/Open.tsx')
    // A `.filter()` is not expanded at all today (not a Tier C call); were it
    // ever, it must never claim the source array.
    expect(refusalOf(nodes, 'p').every((reason) => reason !== 'array')).toBe(true)
    expect(refusalOf(nodes, 'b')).toEqual(['computed', 'computed'])
  })

  it('spread: a row position is not an element position, so no row claims the array', () => {
    write(
      'src/Mixed.tsx',
      "const BASE = ['a']\nconst ALL = [...BASE, 'b']\nexport default function Mixed() {\n  return <ul>{ALL.map((x) => <li key={x}>{x}</li>)}</ul>\n}\n",
    )
    expect(refusalOf(parse('src/Mixed.tsx'), 'li').every((reason) => reason !== 'array')).toBe(true)
  })

  it('nested: a list inside another list row shares its array with every outer row', () => {
    write(
      'src/Grid.tsx',
      [
        "const ROWS = ['r1', 'r2']",
        "const CELLS = ['c1', 'c2']",
        'export default function Grid() {',
        '  return (',
        '    <table><tbody>',
        '      {ROWS.map((row) => <tr key={row}>{CELLS.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}',
        '    </tbody></table>',
        '  )',
        '}',
      ].join('\n'),
    )
    const nodes = parse('src/Grid.tsx')
    expect(refusalOf(nodes, 'td')).toEqual(['nested', 'nested', 'nested', 'nested'])
    expect(refusalOf(nodes, 'tr')).toEqual(['array', 'array'])
  })

  it('multi-root: an item that renders two elements', () => {
    write(
      'src/Glossary.tsx',
      [
        "const TERMS = [{ term: 'A', def: 'first' }, { term: 'B', def: 'second' }]",
        'export default function Glossary() {',
        '  return <dl>{TERMS.map((t) => <><dt>{t.term}</dt><dd>{t.def}</dd></>)}</dl>',
        '}',
      ].join('\n'),
    )
    const nodes = parse('src/Glossary.tsx')
    expect(refusalOf(nodes, 'dt')).toEqual(['multi-root', 'multi-root'])
    expect(refusalOf(nodes, 'dd')).toEqual(['multi-root', 'multi-root'])
  })

  it('prop: a list a component was handed maps over its parameter', () => {
    write('src/Chips.tsx', 'export function Chips({ items }: { items: string[] }) {\n  return <div>{items.map((item) => <span key={item}>{item}</span>)}</div>\n}\n')
    write(
      'src/Page.tsx',
      "import { Chips } from './Chips'\nexport default function Page() {\n  return <main><Chips items={['one', 'two']} /></main>\n}\n",
    )
    const nodes = parse('src/Page.tsx')
    const spans = rows(nodes, 'span')
    // The component parse runs before the call site's values are bound, so
    // this list is either not expanded or stamped as not editable here —
    // never as an array in the component file.
    expect(spans.every((node) => node.listRow?.kind !== 'array')).toBe(true)
  })
})
