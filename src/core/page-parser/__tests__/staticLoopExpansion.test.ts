/**
 * `.map` over a statically-resolved array becomes one node per item.
 *
 * A real screen is mostly lists. Before this, a package picker rendered ONE
 * empty row instead of four, and 96 nodes across the eSIM corpus were a single
 * `dynamic — rendered in code` placeholder standing in for a whole section.
 *
 * The line this must not cross: nothing is expanded unless the array and every
 * item already resolved. An unresolvable loop stays opaque — see
 * `staticLoopExpansion`'s header on why bounded materialisation is not the
 * banned "execute the code" tier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  parsePageFile,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-expand-'))
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

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** `opts` is explicit — passing `undefined` to a defaulted param would silently re-enable the evaluator. */
function loadNodes(pageRel: string, opts: StaticEvalOptions | undefined): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  return Object.values(parsePageFile(file, tmpDir, project, opts).nodes)
}

const textsOf = (nodes: ParsedNode[], tag: string): (string | undefined)[] =>
  nodes.filter((n) => n.name === tag).map((n) => n.text)

describe('static loop expansion', () => {
  it('renders one node per item, with the item\'s fields resolved', () => {
    write(
      'pages/Packages.jsx',
      [
        'const PACKAGES = [',
        '  { gb: 1, price: 20 },',
        '  { gb: 3, price: 45 },',
        '  { gb: 5, price: 70 },',
        ']',
        'export default function Packages() {',
        '  return (',
        '    <div className="list">',
        '      {PACKAGES.map((pkg) => (',
        '        <span key={pkg.gb} className="row" data-price={pkg.price}>{pkg.gb}</span>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Packages.jsx', evalOptions())
    const rows = nodes.filter((n) => n.props.className === 'row')
    expect(rows).toHaveLength(3)
    expect(textsOf(nodes, 'span')).toEqual(['1', '3', '5'])
    expect(rows.map((r) => r.props['data-price'])).toEqual([20, 45, 70])
  })

  it('gives each iteration a distinct id that no writeback can target', () => {
    write(
      'pages/Packages.jsx',
      [
        'const GBS = [1, 2]',
        'export default function Packages() {',
        '  return <div>{GBS.map((gb) => <span key={gb}>{gb}</span>)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const ids = loadNodes('pages/Packages.jsx', evalOptions())
      .filter((n) => n.name === 'span')
      .map((n) => n.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    // One piece of source JSX backs both rows, so an edit to row 2 has nowhere
    // isolated to land. The id carrying `#` is what makes the writeback guards
    // refuse it — a plain `path:line:col` would have been accepted.
    for (const id of ids) expect(id).toContain('#')
    expect(/^[^:]+:\d+:\d+$/.test(ids[0]!)) .toBe(false)
  })

  it('keeps the real source location on every iteration', () => {
    write(
      'pages/Packages.jsx',
      [
        'const GBS = [1, 2]',
        'export default function Packages() {',
        '  return <div>{GBS.map((gb) => <span key={gb}>{gb}</span>)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const spans = loadNodes('pages/Packages.jsx', evalOptions()).filter((n) => n.name === 'span')
    // Same location, because that IS where both are written.
    expect(spans[0]!.loc).toEqual(spans[1]!.loc)
    expect(spans[0]!.loc.line).toBe(3)
  })

  it('locks each row, naming the array it came from', () => {
    write(
      'pages/Packages.jsx',
      [
        'const GBS = [1, 2]',
        'export default function Packages() {',
        '  return <div>{GBS.map((gb) => <span key={gb}>{gb}</span>)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const spans = loadNodes('pages/Packages.jsx', evalOptions()).filter((n) => n.name === 'span')
    expect(spans.every((s) => s.locked)).toBe(true)
    expect(spans[0]!.lockReason).toBe('item 1 of GBS')
    expect(spans[1]!.lockReason).toBe('item 2 of GBS')
  })

  it('binds the index parameter too', () => {
    write(
      'pages/Steps.jsx',
      [
        "const STEPS = ['a', 'b', 'c']",
        'export default function Steps() {',
        '  return <ol>{STEPS.map((label, i) => <li key={label} data-index={i}>{label}</li>)}</ol>',
        '}',
        '',
      ].join('\n'),
    )

    const items = loadNodes('pages/Steps.jsx', evalOptions()).filter((n) => n.name === 'li')
    expect(items.map((n) => n.props['data-index'])).toEqual([0, 1, 2])
    expect(items.map((n) => n.text)).toEqual(['a', 'b', 'c'])
  })

  it('expands nested loops without id collisions', () => {
    write(
      'pages/Grid.jsx',
      [
        'const ROWS = [[1, 2], [3, 4]]',
        'export default function Grid() {',
        '  return (',
        '    <div>',
        '      {ROWS.map((row, r) => (',
        '        <div key={r} className="row">{row.map((cell) => <span key={cell}>{cell}</span>)}</div>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Grid.jsx', evalOptions())
    const cells = nodes.filter((n) => n.name === 'span')
    expect(cells).toHaveLength(4)
    expect(new Set(cells.map((c) => c.id)).size).toBe(4)
    expect(cells.map((c) => c.text)).toEqual(['1', '2', '3', '4'])
  })

  it('leaves the loop opaque when the array does not resolve', () => {
    write(
      'pages/Remote.jsx',
      [
        'export default function Remote({ items }) {',
        '  return <ul>{items.map((it) => <li key={it}>{it}</li>)}</ul>',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Remote.jsx', evalOptions())
    const items = nodes.filter((n) => n.name === 'li')
    // Exactly today's behaviour: one locked placeholder for the whole list.
    expect(items).toHaveLength(1)
    expect(items[0]!.locked).toBe(true)
    expect(items[0]!.lockReason).toBe('dynamic — rendered in code')
    expect(items[0]!.id).not.toContain('#')
  })

  it('leaves the loop opaque when any single item does not resolve', () => {
    write(
      'pages/Mixed.jsx',
      [
        'export default function Mixed({ extra }) {',
        "  const items = ['a', extra]",
        '  return <ul>{items.map((it) => <li key={it}>{it}</li>)}</ul>',
        '}',
        '',
      ].join('\n'),
    )

    // Rendering only the resolvable half would silently DROP a row rather than
    // showing the list as unresolved.
    const items = loadNodes('pages/Mixed.jsx', evalOptions()).filter((n) => n.name === 'li')
    expect(items).toHaveLength(1)
    expect(items[0]!.id).not.toContain('#')
  })

  it('does not expand anything when the evaluator is off', () => {
    write(
      'pages/Packages.jsx',
      [
        'const GBS = [1, 2, 3]',
        'export default function Packages() {',
        '  return <div>{GBS.map((gb) => <span key={gb}>{gb}</span>)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    const items = loadNodes('pages/Packages.jsx', undefined).filter((n) => n.name === 'span')
    expect(items).toHaveLength(1)
  })

  it('declines a callback that is not an inline function', () => {
    write(
      'pages/Indirect.jsx',
      [
        'const GBS = [1, 2]',
        'const renderGb = (gb) => <span key={gb}>{gb}</span>',
        'export default function Indirect() {',
        '  return <div>{GBS.map(renderGb)}</div>',
        '}',
        '',
      ].join('\n'),
    )

    // The callback's JSX is not syntactically inside the `.map`, so there is
    // nothing to walk per iteration here.
    const items = loadNodes('pages/Indirect.jsx', evalOptions()).filter((n) => n.name === 'span')
    expect(items.length).toBeLessThanOrEqual(1)
  })

  it('reads a block-bodied callback\'s return', () => {
    write(
      'pages/Block.jsx',
      [
        'const GBS = [1, 2]',
        'export default function Block() {',
        '  return (',
        '    <div>',
        '      {GBS.map((gb) => {',
        '        return <span key={gb}>{gb}</span>',
        '      })}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const items = loadNodes('pages/Block.jsx', evalOptions()).filter((n) => n.name === 'span')
    expect(items.map((n) => n.text)).toEqual(['1', '2'])
  })
})

/**
 * parser-08 — a conditional INSIDE an expanded row resolves per row.
 *
 * `iterationEvalContext` already bound the callback's parameters, and
 * `selectJsxBranch` already consulted them; what was missing is that a property
 * the row's object does NOT have evaluated to `unresolved` ("we could not read
 * this") rather than `undefined` ("the source says there is nothing here"). So
 * every row after the first threw away a Tier A answer and fell back to the
 * positional heuristic — on the real eSIM board that painted a broken
 * `<img src>` placeholder on top of the icon of two of three add-on rows.
 */
describe('a branch inside an expanded loop row', () => {
  it('picks a DIFFERENT ternary side per row from the iteration variable', () => {
    write(
      'pages/AddOns.jsx',
      [
        "const ADD_ONS = [",
        "  { key: 'esim', image: 'chip.png' },",
        "  { key: 'checkin', icon: 'check.svg' },",
        "  { key: 'baggage', icon: 'bag.svg' },",
        ']',
        'export default function AddOns() {',
        '  return (',
        '    <div>',
        '      {ADD_ONS.map((addOn) => (',
        '        <div key={addOn.key}>',
        '          {addOn.image ? (',
        '            <img src={addOn.image} alt="" />',
        '          ) : (',
        '            <span data-icon={addOn.icon} />',
        '          )}',
        '        </div>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/AddOns.jsx', evalOptions())
    // Exactly one branch per row: the image row gets the <img>, the two
    // icon rows get the <span>. Never both, and never three of either.
    expect(nodes.filter((n) => n.name === 'img')).toHaveLength(1)
    expect(nodes.filter((n) => n.name === 'span')).toHaveLength(2)
  })

  it('drops a `&&` whose guard is a property the row does not have', () => {
    write(
      'pages/Subtext.jsx',
      [
        "const COPY = { a: { title: 'A', subtext: 'more' }, b: { title: 'B' } }",
        "const ROWS = [{ key: 'a' }, { key: 'b' }]",
        'export default function Subtext() {',
        '  return (',
        '    <div>',
        '      {ROWS.map((row) => (',
        '        <div key={row.key}>',
        '          <p>{COPY[row.key].title}</p>',
        '          {COPY[row.key].subtext && <em>{COPY[row.key].subtext}</em>}',
        '        </div>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Subtext.jsx', evalOptions())
    expect(textsOf(nodes, 'p')).toEqual(['A', 'B'])
    expect(textsOf(nodes, 'em')).toEqual(['more'])
  })

  it('resolves `i < items.length - 1` from the bound index parameter', () => {
    write(
      'pages/Rules.jsx',
      [
        "const ROWS = ['a', 'b', 'c']",
        'export default function Rules() {',
        '  return (',
        '    <div>',
        '      {ROWS.map((row, i) => (',
        '        <div key={row}>',
        '          <p>{row}</p>',
        '          {i < ROWS.length - 1 && <hr />}',
        '        </div>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Rules.jsx', evalOptions())
    expect(textsOf(nodes, 'p')).toEqual(['a', 'b', 'c'])
    // A separator between rows, not after the last one.
    expect(nodes.filter((n) => n.name === 'hr')).toHaveLength(2)
  })

  it('still declines when a SPREAD could have supplied the missing key', () => {
    write(
      'pages/Spread.jsx',
      [
        "const BASE = { image: 'fallback.png' }",
        "const ROWS = [{ ...BASE, key: 'a' }, { key: 'b' }]",
        'export default function Spread() {',
        '  return (',
        '    <div>',
        '      {ROWS.map((row) => (',
        '        <div key={row.key}>{row.image ? <img alt="" /> : <span />}</div>',
        '      ))}',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // Row `b` is a complete literal with no `image`, so it resolves to the
    // <span>. Row `a` carries a spread this evaluator did not read, so its
    // `image` stays genuinely unknown and the heuristic (prefer the consequent)
    // renders the <img>. The point is that an INCOMPLETE object never claims
    // a key is absent.
    const nodes = loadNodes('pages/Spread.jsx', evalOptions())
    expect(nodes.filter((n) => n.name === 'img')).toHaveLength(1)
    expect(nodes.filter((n) => n.name === 'span')).toHaveLength(1)
  })
})
