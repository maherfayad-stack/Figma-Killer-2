/**
 * promoteOverrideToDefault — OD-19's "Apply to all": the value one instance
 * overrides becomes the component's default and the call site stops passing
 * it. Driven through `exposeLiteralAsProp` first, so the starting state is
 * exactly what Studio writes, not a hand-built imitation of it.
 *
 * Every refusal asserts that EVERY file in the workspace is byte-identical.
 * The second fixture (a village-hall booking app, a `.jsx` arrow component
 * with a default export and no types) shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exposeLiteralAsProp } from '../exposeLiteralAsProp'
import { promoteOverrideToDefault, type PromoteOverrideRefusalReason } from '../promoteOverrideToDefault'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-override-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const abs = (rel: string) => path.join(tmpDir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text, 'utf8')
}

function snapshot(): Map<string, string> {
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

const CARD = [
  'export function Card({ title }: { title: string }) {',
  '  return (',
  '    <article>',
  '      <h2>Current text</h2>',
  '      <p>{title}</p>',
  '    </article>',
  '  )',
  '}',
  '',
].join('\n')

const HOME = [
  "import { Card } from '../components/Card'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Card title="One" />',
  '      <Card title="Two" />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

function promote(input: { pageRel: string; callTag: string; occurrence?: number; componentRel: string; propNames: readonly string[] }) {
  const call = locateTag(read(input.pageRel), input.callTag, input.occurrence ?? 1)
  return promoteOverrideToDefault({
    callSiteFile: abs(input.pageRel),
    callSiteLine: call.line,
    callSiteCol: call.col,
    componentFile: abs(input.componentRel),
    workspaceRoot: tmpDir,
    propNames: input.propNames,
  })
}

function expectRefused(input: Parameters<typeof promote>[0], reason: PromoteOverrideRefusalReason): void {
  const before = snapshot()
  const result = promote(input)
  if (result.ok) throw new Error(`expected ${reason}, got a success`)
  expect(result.refusal.reason).toBe(reason)
  expect(snapshot()).toEqual(before)
}

/** Overrides the first `<Card>`'s heading, the way the editor does: returns the files as that left them. */
function overrideHeading(value: string): void {
  const call = locateTag(read('pages/Home.tsx'), 'Card')
  const element = locateTag(read('components/Card.tsx'), 'h2')
  const result = exposeLiteralAsProp({
    callSiteFile: abs('pages/Home.tsx'),
    callSiteLine: call.line,
    callSiteCol: call.col,
    elementFile: abs('components/Card.tsx'),
    line: element.line,
    col: element.col,
    workspaceRoot: tmpDir,
    overrides: [{ target: { kind: 'text' }, propName: 'heading', value }],
  })
  if (!result.ok) throw new Error(result.refusal.message)
}

describe('apply an override to every instance', () => {
  it('the override becomes the default and the call site stops passing it', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    expect(read('pages/Home.tsx')).toContain('<Card title="One" heading="New text" />')

    const result = promote({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', propNames: ['heading'] })
    expect(result).toEqual({ ok: true })
    expect(read('components/Card.tsx')).toContain("{ title, heading = 'New text' }")
    // The call site is back to what it was before the override: `<Card title="One" />`.
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('an instance that passes its OWN value keeps it, and an attribute next to the removed one is untouched', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    // The second instance overrode the same prop on its own.
    write('pages/Home.tsx', read('pages/Home.tsx').replace('<Card title="Two" />', '<Card title="Two" heading="Mine" />'))
    expect(promote({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', propNames: ['heading'] }).ok).toBe(true)
    const home = read('pages/Home.tsx')
    expect(home).toContain('<Card title="One" />')
    expect(home).toContain('<Card title="Two" heading="Mine" />')
  })

  it('a value that is not a plain JSX string (an entity-bearing one) is left alone', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    // A hand edit turned the override into an entity: as a JS default it would mean something else.
    write('pages/Home.tsx', read('pages/Home.tsx').replace('heading="New text"', 'heading="Tom &amp; Jerry"'))
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', propNames: ['heading'] }, 'not-an-override')
  })
})

const NL = String.fromCharCode(10)

describe('apply several overrides of one instance at once', () => {
  it('every named prop becomes its default and leaves the call site in one write; one that cannot refuses all', () => {
    const card = ['export function Badge({ tone }: { tone: string }) {', '  return <span className={tone} title="Status">Active</span>', '}', ''].join(NL)
    const home = ["import { Badge } from '../components/Badge'", 'export default function Home() {', '  return <Badge tone="ok" />', '}', ''].join(NL)
    write('components/Badge.tsx', card)
    write('pages/Home.tsx', home)
    const call = locateTag(home, 'Badge')
    const element = locateTag(card, 'span')
    const exposed = exposeLiteralAsProp({
      callSiteFile: abs('pages/Home.tsx'), callSiteLine: call.line, callSiteCol: call.col,
      elementFile: abs('components/Badge.tsx'), line: element.line, col: element.col, workspaceRoot: tmpDir,
      overrides: [
        { target: { kind: 'text' }, propName: 'label', value: 'Paused' },
        { target: { kind: 'attribute', name: 'title' }, propName: 'titleText', value: 'On hold' },
      ],
    })
    if (!exposed.ok) throw new Error(exposed.refusal.message)
    expect(read('pages/Home.tsx')).toContain('<Badge tone="ok" label="Paused" titleText="On hold" />')

    // One of the two names is not an override: nothing is written for either.
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Badge', componentRel: 'components/Badge.tsx', propNames: ['label', 'tone'] }, 'no-default')

    expect(promote({ pageRel: 'pages/Home.tsx', callTag: 'Badge', componentRel: 'components/Badge.tsx', propNames: ['label', 'titleText'] })).toEqual({ ok: true })
    expect(read('components/Badge.tsx')).toContain("{ tone, label = 'Paused', titleText = 'On hold' }")
    expect(read('pages/Home.tsx')).toBe(home)
  })
})

describe('apply to all — refusals, every file byte-identical', () => {
  it('a call site that does not pass the prop has nothing to apply', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', occurrence: 2, componentRel: 'components/Card.tsx', propNames: ['heading'] }, 'not-an-override')
  })

  it('a binding at the call site is never baked into the default', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    write('pages/Home.tsx', read('pages/Home.tsx').replace('heading="New text"', 'heading={copy.title}'))
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', propNames: ['heading'] }, 'not-an-override')
  })

  it('a default that has since become an expression is not rewritten', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    write('components/Card.tsx', read('components/Card.tsx').replace("heading = 'Current text'", 'heading = DEFAULT_HEADING'))
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', propNames: ['heading'] }, 'no-default')
  })

  it('refuses a component file other than the one the call site resolves to', () => {
    write('components/Card.tsx', CARD)
    write('components/Other.tsx', CARD)
    write('pages/Home.tsx', HOME)
    overrideHeading('New text')
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Other.tsx', propNames: ['heading'] }, 'not-in-component')
  })

  it('an installed package is never rewritten', () => {
    write('pages/Home.tsx', "import { Chip } from 'some-ui-kit'\nexport default function Home() {\n  return <Chip label=\"x\" />\n}\n")
    write('node_modules/some-ui-kit/index.js', 'exports.Chip = () => null\n')
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Chip', componentRel: 'node_modules/some-ui-kit/index.js', propNames: ['label'] }, 'package-component')
  })
})

describe('apply to all — generic shape: a .jsx default-exported arrow component with a numeric style default (shares nothing with the eSIM corpus)', () => {
  it('writes the number, drops the attribute, and keeps the file valid', () => {
    write('hall/RoomTile.jsx', "export default ({ room }) => (\n  <li style={{ width: 120 }}>{room}</li>\n)\n")
    const page = "import RoomTile from './hall/RoomTile'\nexport function Rooms() {\n  return (\n    <ul>\n      <RoomTile room=\"Oak\" />\n    </ul>\n  )\n}\n"
    write('Rooms.jsx', page)
    const call = locateTag(page, 'RoomTile')
    const element = locateTag(read('hall/RoomTile.jsx'), 'li')
    const exposed = exposeLiteralAsProp({
      callSiteFile: abs('Rooms.jsx'), callSiteLine: call.line, callSiteCol: call.col,
      elementFile: abs('hall/RoomTile.jsx'), line: element.line, col: element.col, workspaceRoot: tmpDir,
      overrides: [{ target: { kind: 'style', property: 'width' }, propName: 'tileWidth', value: 200 }],
    })
    if (!exposed.ok) throw new Error(exposed.refusal.message)
    expect(read('Rooms.jsx')).toContain('<RoomTile room="Oak" tileWidth={200} />')

    const result = promote({ pageRel: 'Rooms.jsx', callTag: 'RoomTile', componentRel: 'hall/RoomTile.jsx', propNames: ['tileWidth'] })
    expect(result).toEqual({ ok: true })
    expect(read('hall/RoomTile.jsx')).toContain('({ room, tileWidth = 200 })')
    expect(read('Rooms.jsx')).toBe(page)
  })
})
