/**
 * `prop` / `text` with `unbind: true` on the wire (G-6, OD-20): typing over a
 * code-bound value replaces the code with the literal, in the editor's journaled
 * batch only, never through an inlined id, and one restore puts the bytes back.
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

const HOME = [
  "import { Badge } from '../components/Badge'",
  'export default function Home({ count }: { count: number }) {',
  '  return (',
  '    <main>',
  '      <h1 title={count}>{count}</h1>',
  '      <Badge />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')
const BADGE = 'export function Badge({ label }: { label: string }) {\n  return <span>{label}</span>\n}\n'

/** `<h1>`'s tag-name position: line 5, column 8 (after 6 spaces and `<`). */
const H1 = 'pages/Home.tsx:5:8'
/** `<span>` inside Badge, seen through the `<Badge />` call site on line 6. */
const SPAN = `pages/Home.tsx:6:8~components/Badge.tsx:2:11`

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unbind-')))
  write('pages/Home.tsx', HOME)
  write('components/Badge.tsx', BADGE)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('unbind on type - the editor batch', () => {
  it('replaces a code-bound attribute and its text, reports the file, and one restore brings every byte back', () => {
    const result = applyStudioEditBatch(
      dir,
      [
        { kind: 'prop', nodeId: H1, prop: 'title', value: 'Hello', unbind: true },
        { kind: 'text', nodeId: H1, text: 'Hello there', unbind: true },
      ],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    expect(read('pages/Home.tsx')).toBe(HOME.replace('<h1 title={count}>{count}</h1>', '<h1 title="Hello">Hello there</h1>'))
    expect(result.undoToken).toMatch(/^[0-9a-f]{32}$/)

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toBe(HOME)
    expect(read('components/Badge.tsx')).toBe(BADGE)
  })

  it('without the flag the same edits still refuse and write nothing', () => {
    const result = applyStudioEditBatch(
      dir,
      [
        { kind: 'prop', nodeId: H1, prop: 'title', value: 'Hello' },
        { kind: 'text', nodeId: H1, text: 'Hello there' },
      ],
      {},
      EDITOR,
    )
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason).sort()).toEqual(['binding-overwrite', 'mixed-children'])
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('an agent batch (no journal, so no Undo) cannot unbind', () => {
    const result = applyStudioEditBatch(dir, [{ kind: 'prop', nodeId: H1, prop: 'title', value: 'Hello', unbind: true }], {})
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['unbind-editor-only'])
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('refuses an inlined id: the binding in a shared component is what every other instance reads through', () => {
    const result = applyStudioEditBatch(dir, [{ kind: 'text', nodeId: SPAN, text: 'Static', unbind: true }], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['unbind-shared'])
    expect(read('components/Badge.tsx')).toBe(BADGE)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('refuses markup in the position, naming it, and writes nothing', () => {
    write('pages/Home.tsx', HOME.replace('{count}</h1>', '{count > 1 && <b>many</b>}</h1>'))
    const before = read('pages/Home.tsx')
    const result = applyStudioEditBatch(dir, [{ kind: 'text', nodeId: H1, text: 'x', unbind: true }], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['mixed-children'])
    expect(read('pages/Home.tsx')).toBe(before)
  })
})
