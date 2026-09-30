/**
 * `detach` on the wire (P5-C, DET-5): the editor's one `detachInstances`
 * action asks before it loses anything, detaches a multi-selection as ONE
 * gesture, and takes all of it back with ONE ⌘Z.
 *
 *   - `dryRun: 'if-lossy'` holds back a detach that would drop other rendered
 *     states, and reports why (`detachDetails`) — neither written nor
 *     skipped, the file byte-identical, no journal entry;
 *   - the same edit with nothing to lose writes in one round trip;
 *   - two detaches in ONE file are a `sequence`: each is written against the
 *     file the previous one left (both add an import above the other's call
 *     site, so a bottom-up batch would aim the second at a stale line), and
 *     the sequence records ONE journal entry whose `restore` puts the file
 *     back byte for byte;
 *   - a refused step takes the whole sequence back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'
import { applyStudioEditSequence } from '../studioEditSequence'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}
const journal = () => (fs.existsSync(abs('.studio/undo-journal')) ? fs.readdirSync(abs('.studio/undo-journal')) : [])

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

/** The node id of the `occurrence`-th `<name` in `source` — the column names the tag NAME. */
function nodeIdOf(source: string, name: string, occurrence = 1, file = 'pages/Home.tsx'): string {
  const lines = source.split('\n')
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    let from = 0
    for (;;) {
      const col = lines[i]!.indexOf(`<${name}`, from)
      if (col < 0) break
      seen += 1
      if (seen === occurrence) return `${file}:${i + 1}:${col + 2}`
      from = col + 1
    }
  }
  throw new Error(`no <${name} #${occurrence} in fixture`)
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-detach-writes-')))
  write('components/Icon.tsx', 'export function Icon({ name }: { name: string }) {\n  return <svg data-name={name} />\n}\n')
  // Each detach of a Card brings `Icon` into the page: an import line above every call site.
  write('components/Card.tsx', [
    "import { Icon } from './Icon'",
    'export function Card({ title }: { title: string }) {',
    '  return <div className="card"><Icon name="star" />{title}</div>',
    '}',
    '',
  ].join('\n'))
  write('components/Status.tsx', [
    'export function Status({ loading }: { loading?: boolean }) {',
    '  if (loading) return <p>Loading</p>',
    '  return <div className="ready">Ready</div>',
    '}',
    '',
  ].join('\n'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('detach dryRun — ask before losing anything', () => {
  const PAGE = [
    "import { Status } from '../components/Status'",
    'export default function Home() {',
    '  return <main><Status /></main>',
    '}',
    '',
  ].join('\n')

  it("'if-lossy' holds a detach that drops other rendered states: not written, not skipped, byte-identical, no journal", () => {
    write('pages/Home.tsx', PAGE)
    const nodeId = nodeIdOf(PAGE, 'Status')
    const result = applyStudioEditBatch(dir, [{ kind: 'detach', nodeId, dryRun: 'if-lossy' }], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.refusals).toEqual([])
    expect(result.detachDetails).toEqual([
      {
        nodeId,
        written: false,
        lossy: true,
        movedHooks: [],
        perRow: false,
        branchNote: 'Status has more than one rendered state — the currently-shown one was inlined.',
      },
    ])
    expect(result.undoToken).toBeUndefined()
    expect(read('pages/Home.tsx')).toBe(PAGE)
    expect(journal()).toEqual([])
  })

  it('the confirmed detach (no dryRun) writes, and its restore puts the page back', () => {
    write('pages/Home.tsx', PAGE)
    const result = applyStudioEditBatch(dir, [{ kind: 'detach', nodeId: nodeIdOf(PAGE, 'Status') }], {}, EDITOR)
    expect(result.written).toBe(1)
    expect(result.detachDetails[0]).toMatchObject({ written: true, lossy: true })
    expect(read('pages/Home.tsx')).toContain('<main><div className="ready">Ready</div></main>')
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.written).toBe(1)
    expect(read('pages/Home.tsx')).toBe(PAGE)
  })

  it("'if-lossy' writes a detach that loses nothing, in one round trip", () => {
    const page = PAGE.replaceAll('Status', 'Card').replace('<Card />', '<Card title="Hi" />')
    write('pages/Home.tsx', page)
    const result = applyStudioEditBatch(dir, [{ kind: 'detach', nodeId: nodeIdOf(page, 'Card'), dryRun: 'if-lossy' }], {}, EDITOR)
    expect(result.written).toBe(1)
    expect(result.detachDetails[0]).toMatchObject({ written: true, lossy: false })
    expect(result.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(read('pages/Home.tsx')).toContain('<div className="card"><Icon name="star" />Hi</div>')
  })
})

describe('a multi-selection detach is one sequence, and one ⌘Z', () => {
  const PAGE = [
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

  it('detaches both call sites in one file, each against the file the other left, and journals the whole gesture once', () => {
    write('pages/Home.tsx', PAGE)
    const edits: StudioEdit[] = [
      { kind: 'detach', nodeId: nodeIdOf(PAGE, 'Card', 2) },
      { kind: 'detach', nodeId: nodeIdOf(PAGE, 'Card', 1) },
    ]
    const result = applyStudioEditSequence(dir, edits, {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<div className="card"><Icon name="star" />One</div>')
    expect(text).toContain('<div className="card"><Icon name="star" />Two</div>')
    expect(text).not.toContain('<Card')
    expect(text.match(/import \{ Icon \}/g)).toHaveLength(1)
    expect(result.createdNodeIds).toHaveLength(2)
    expect(result.detachDetails.map((detail) => detail.written)).toEqual([true, true])

    expect(result.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(journal()).toHaveLength(1)
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toBe(PAGE)
  })

  it('takes the whole sequence back when one step refuses — nothing written, nothing journaled', () => {
    write('components/Counter.tsx', "import { useState } from 'react'\nexport function Counter() {\n  const [n] = useState(0)\n  return <b>{n}</b>\n}\n")
    const page = PAGE.replace("import { Card } from '../components/Card'", "import { Card } from '../components/Card'\nimport { Counter } from '../components/Counter'").replace('<Card title="Two" />', '<Counter />')
    write('pages/Home.tsx', page)
    const result = applyStudioEditSequence(
      dir,
      [
        { kind: 'detach', nodeId: nodeIdOf(page, 'Counter') },
        { kind: 'detach', nodeId: nodeIdOf(page, 'Card') },
      ],
      {},
      EDITOR,
    )
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['uses-hooks'])
    expect(result.undoToken).toBeUndefined()
    expect(read('pages/Home.tsx')).toBe(page)
    expect(journal()).toEqual([])
  })
})
