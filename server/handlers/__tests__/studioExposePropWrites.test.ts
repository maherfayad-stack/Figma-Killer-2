/**
 * `expose-prop` on the wire (P5-C, DET-7): the literal of an element inside a
 * component becomes an optional prop whose default is that literal, and this
 * call site passes its own value — two files, ONE journal entry, one ⌘Z.
 *
 * The call site is the id's HEAD, never a field the client sends; an id that
 * is not exactly one call site deep refuses, because a deeper element's
 * nearest call site sits in a shared component's own file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

const CARD = 'export function Card({ title }: { title: string }) {\n  return (\n    <article>\n      <h2>Current text</h2>\n      <p>{title}</p>\n    </article>\n  )\n}\n'
const HOME = "import { Card } from '../components/Card'\nexport default function Home() {\n  return (\n    <main>\n      <Card title=\"One\" />\n      <Card title=\"Two\" />\n    </main>\n  )\n}\n"
/** `<Card title="One" />`'s tag name, and `<h2>`'s inside Card — the ids the parser mints for them. */
const CALL_SITE = 'pages/Home.tsx:5:8'
const HEADING = `${CALL_SITE}~components/Card.tsx:4:8`

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-expose-prop-')))
  write('components/Card.tsx', CARD)
  write('pages/Home.tsx', HOME)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('expose-prop — one gesture, two files, one ⌘Z', () => {
  it('writes the component and this call site, reports both files, and one restore puts both back', () => {
    const result = applyStudioEditBatch(
      dir,
      [{ kind: 'expose-prop', nodeId: HEADING, target: { kind: 'text' }, propName: 'heading', value: 'New text' }],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('components/Card.tsx')).toContain("{ title, heading = 'Current text' }")
    expect(read('components/Card.tsx')).toContain('<h2>{heading}</h2>')
    expect(read('pages/Home.tsx')).toContain('<Card title="One" heading="New text" />')
    expect(read('pages/Home.tsx')).toContain('<Card title="Two" />')
    expect(result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')).sort()).toEqual(['components/Card.tsx', 'pages/Home.tsx'])
    expect(result.sharedComponents).toBe(true)

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Card.tsx')).toBe(CARD)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('refuses, writing nothing, an id that is not exactly one call site deep', () => {
    for (const nodeId of ['components/Card.tsx:4:8', `${HEADING}~components/Icon.tsx:1:1`]) {
      const result = applyStudioEditBatch(dir, [{ kind: 'expose-prop', nodeId, target: { kind: 'text' }, propName: 'heading', value: 'x' }], {}, EDITOR)
      expect(result.written).toBe(0)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['not-in-component'])
    }
    expect(read('components/Card.tsx')).toBe(CARD)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('refuses a binding, writing nothing — a resolved value is never baked', () => {
    const result = applyStudioEditBatch(
      dir,
      [{ kind: 'expose-prop', nodeId: `${CALL_SITE}~components/Card.tsx:5:8`, target: { kind: 'text' }, propName: 'body', value: 'x' }],
      {},
      EDITOR,
    )
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['not-a-literal'])
    expect(read('components/Card.tsx')).toBe(CARD)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })
})
