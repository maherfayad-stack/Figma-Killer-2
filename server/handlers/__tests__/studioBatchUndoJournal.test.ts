/**
 * studioBatchUndoJournal — the undo journal as the edit batch drives it
 * (P3-F; ERR-2, DET-4): each one-shot write (delete, detach, swap, extract a
 * subtree) reports a token, a `restore` naming it puts the files back byte for
 * byte, and the journal belongs to the editor's own batches only.
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

/** The node id of the first `<name` in `source` — the column names the tag NAME, as `buildSourceNodeId` mints it. */
function nodeIdOf(source: string, name: string, file = 'pages/Home.tsx'): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i]!.indexOf(`<${name}`)
    if (col >= 0) return `${file}:${i + 1}:${col + 2}`
  }
  throw new Error(`no <${name} in fixture`)
}

const PAGE = [
  "import { Card } from '../components/Card'",
  "import { Badge } from '../components/Badge'",
  '',
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <h1>Title</h1>',
  '      <Badge label="new" />',
  '      <Card title="Hi" />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-undo-journal-')))
  write('components/Card.tsx', 'export function Card({ title }: { title: string }) {\n  return <div className="card">{title}</div>\n}\n')
  write('components/Tile.tsx', 'export function Tile({ heading }: { heading: string }) {\n  return <div className="tile">{heading}</div>\n}\n')
  write('components/Badge.tsx', 'export function Badge({ label }: { label: string }) {\n  return <i>{label}</i>\n}\n')
  write('pages/Home.tsx', PAGE)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** One journaled one-shot write, then its restore: the page must come back exactly. */
function roundTrip(edits: StudioEdit[]): void {
  const forward = applyStudioEditBatch(dir, edits, {}, EDITOR)
  expect(forward.refusals).toEqual([])
  expect(forward.written).toBe(edits.length)
  expect(read('pages/Home.tsx')).not.toBe(PAGE)
  expect(forward.undoToken).toMatch(/^[0-9a-f]{32}$/)

  const back = applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
  expect(back.refusals).toEqual([])
  expect(back.written).toBe(1)
  // Every other frame reading the file is stale — the board re-reads it.
  expect(back.sharedComponents).toBe(true)
  expect(back.touchedFiles).toEqual([abs('pages/Home.tsx')])
  expect(read('pages/Home.tsx')).toBe(PAGE)
}

describe('each one-shot write is undone byte for byte', () => {
  it('delete — the element AND the import it was the last use of (ERR-2)', () => {
    roundTrip([{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }])
  })

  it('a multi-element delete is ONE token for the whole batch', () => {
    roundTrip([
      { kind: 'delete', nodeId: nodeIdOf(PAGE, 'h1') },
      { kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') },
    ])
  })

  it('detach (DET-4)', () => {
    roundTrip([{ kind: 'detach', nodeId: nodeIdOf(PAGE, 'Card') }])
  })

  it('swap (DET-4) — the dropped props come back too', () => {
    roundTrip([
      { kind: 'swap', nodeId: nodeIdOf(PAGE, 'Card'), newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' },
    ])
  })

  it('extract a subtree into a new component (DET-4) — the new file goes away again', () => {
    const forward = applyStudioEditBatch(dir, [{ kind: 'promote-component', nodeId: nodeIdOf(PAGE, 'h1'), componentName: 'Heading' }], {}, EDITOR)
    expect(forward.refusals).toEqual([])
    const [detail] = forward.promoteDetails
    expect(detail).toBeDefined()
    expect(fs.existsSync(abs(detail!.newFile))).toBe(true)

    const back = applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toBe(PAGE)
    expect(fs.existsSync(abs(detail!.newFile))).toBe(false)
  })
})

describe('refuses honestly', () => {
  it('a restore after an intervening edit refuses restore-stale and writes nothing', () => {
    const forward = applyStudioEditBatch(dir, [{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }], {}, EDITOR)
    const afterDelete = read('pages/Home.tsx')
    const edited = applyStudioEditBatch(dir, [{ kind: 'text', nodeId: nodeIdOf(afterDelete, 'h1'), text: 'Renamed' }], {}, EDITOR)
    expect(edited.written).toBe(1)
    const beforeRestore = read('pages/Home.tsx')

    const back = applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(back.written).toBe(0)
    expect(back.refusals.map((refusal) => refusal.reason)).toEqual(['restore-stale'])
    expect(back.refusals[0]!.message).toContain('pages/Home.tsx has changed since that edit')
    expect(read('pages/Home.tsx')).toBe(beforeRestore)
  })

  it('an agent batch (no `journal`) records nothing and may not restore', () => {
    const agent = applyStudioEditBatch(dir, [{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }])
    expect(agent.written).toBe(1)
    expect(agent.undoToken).toBeUndefined()
    expect(journal()).toEqual([])

    write('pages/Home.tsx', PAGE)
    const editor = applyStudioEditBatch(dir, [{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }], {}, EDITOR)
    const afterDelete = read('pages/Home.tsx')
    const refused = applyStudioEditBatch(dir, [restore(editor.undoToken!)])
    expect(refused.refusals.map((refusal) => refusal.reason)).toEqual(['restore-editor-only'])
    expect(read('pages/Home.tsx')).toBe(afterDelete)
  })

  it('a restore is refused unless it is the only edit in its batch', () => {
    const forward = applyStudioEditBatch(dir, [{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }], {}, EDITOR)
    const afterDelete = read('pages/Home.tsx')
    const mixed = applyStudioEditBatch(
      dir,
      [restore(forward.undoToken!), { kind: 'text', nodeId: nodeIdOf(afterDelete, 'h1'), text: 'Also' }],
      {},
      EDITOR,
    )
    expect(mixed.refusals.map((refusal) => refusal.reason)).toContain('restore-not-alone')
    expect(read('pages/Home.tsx')).not.toBe(PAGE)
  })

  it('a value edit records no journal entry — only the one-shot kinds do', () => {
    const value = applyStudioEditBatch(dir, [{ kind: 'text', nodeId: nodeIdOf(PAGE, 'h1'), text: 'Typed' }], {}, EDITOR)
    expect(value.written).toBe(1)
    expect(value.undoToken).toBeUndefined()
    expect(journal()).toEqual([])
  })

  it('a sequence records no journal entry for its steps', () => {
    const result = applyStudioEditSequence(dir, [{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }], {}, EDITOR)
    expect(result.written).toBe(1)
    expect(result.undoToken).toBeUndefined()
    expect(journal()).toEqual([])
  })
})
