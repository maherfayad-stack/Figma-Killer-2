/**
 * studioRestyleBatch - CT-5's server half: a restyle (apply / create / detach a
 * text or effect style) is a `class` edit marked `restyle`, posted with the
 * inline-style strip/set and, for a create, the `css` insert. The batch is
 * journaled (one `restore` puts every file back, a created stylesheet
 * included) and ALL OR NOTHING (a refusal anywhere writes nothing).
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
const EDITOR = { journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

const PAGE = [
  "import './styles.css'",
  '',
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <h1 className="hero" style={{ fontSize: 40, color: "red" }}>Title</h1>',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')
const CSS = '.hero {\n  margin: 0;\n}\n'
const H1 = 'pages/Home.tsx:6:8'

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restyle-batch-')))
  write('pages/Home.tsx', PAGE)
  write('pages/styles.css', CSS)
  write('index.html', '<script type="module" src="/pages/Home.tsx"></script>')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** `removed` names a token the class edit takes off - against `className={getCls()}` that is a refusal (`unsupported-call`). */
const createEdits = (removed: string[] = []): StudioEdit[] => [
  { kind: 'css', op: 'insert', nodeId: 'css:insert:pages/styles.css#.text-title', file: 'pages/styles.css', selector: '.text-title', declarations: { 'font-size': '40px' } },
  { kind: 'class', nodeId: H1, add: [{ kind: 'literal', token: 'text-title' }], remove: removed.map((token) => ({ kind: 'literal' as const, token })), restyle: true },
  { kind: 'style', nodeId: H1, style: {}, remove: ['fontSize'] },
]

describe('a restyle batch', () => {
  it('journals the stylesheet its rule lands in and undoes every file byte for byte', () => {
    const result = applyStudioEditBatch(dir, createEdits(), {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(3)
    expect(read('pages/styles.css')).toContain('.text-title')
    expect(read('pages/Home.tsx')).toContain('text-title')
    expect(read('pages/Home.tsx')).not.toContain('fontSize')
    expect(result.undoToken).toMatch(/^[0-9a-f]{32}$/)

    const back = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toBe(PAGE)
    expect(read('pages/styles.css')).toBe(CSS)
  })

  it('is all or nothing: a refused class edit takes the inline strip and the rule back', () => {
    const spread = PAGE.replace('<h1 className="hero"', '<h1 className={getCls()}')
    write('pages/Home.tsx', spread)
    const result = applyStudioEditBatch(dir, createEdits(['old']), {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.undoToken).toBeUndefined()
    expect(result.refusals.map((r) => r.reason)).toContain('unsupported-call')
    // The two edits that ran are reported rolled back, so skipped counts every edit.
    expect(result.skipped).toBe(3)
    expect(result.refusals.filter((r) => r.reason === 'restyle-rolled-back')).toHaveLength(2)
    expect(read('pages/Home.tsx')).toBe(spread)
    expect(read('pages/styles.css')).toBe(CSS)
  })

  it('rolls back and removes a stylesheet the batch created', () => {
    fs.rmSync(abs('pages/styles.css'))
    write('pages/Home.tsx', PAGE.replace("import './styles.css'\n\n", '').replace('<h1 className="hero"', '<h1 className={getCls()}'))
    const before = read('pages/Home.tsx')
    const edits: StudioEdit[] = [
      { kind: 'css', op: 'create', nodeId: 'css:create:x', selector: '.text-title', declarations: { 'font-size': '40px' } },
      { kind: 'class', nodeId: H1.replace(':6:', ':4:'), add: [{ kind: 'literal', token: 'text-title' }], remove: [{ kind: 'literal', token: 'old' }], restyle: true },
    ]
    const result = applyStudioEditBatch(dir, edits, {}, EDITOR)
    expect(result.written).toBe(0)
    expect(read('pages/Home.tsx')).toBe(before)
    expect(fs.readdirSync(abs('pages')).filter((name) => name.endsWith('.css'))).toEqual([])
  })

  it('an agent batch (no journal) still rolls back, and records nothing', () => {
    write('pages/Home.tsx', PAGE.replace('<h1 className="hero"', '<h1 className={getCls()}'))
    const result = applyStudioEditBatch(dir, createEdits(['old']), {}, {})
    expect(result.written).toBe(0)
    expect(read('pages/styles.css')).toBe(CSS)
    expect(fs.existsSync(abs('.studio/undo-journal'))).toBe(false)
  })

  it('a plain class edit is neither journaled nor atomic', () => {
    const result = applyStudioEditBatch(
      dir,
      [{ kind: 'class', nodeId: H1, add: [{ kind: 'literal', token: 'x' }], remove: [] }],
      {},
      EDITOR,
    )
    expect(result.written).toBe(1)
    expect(result.undoToken).toBeUndefined()
  })
})
