/**
 * P1-A — the element identity guard, server half (WB-1's guard, WB-11).
 *
 * WB-1's probe, committed: the board parses a list, then an OUTSIDE writer (the
 * agent's own Edit tool, VS Code, `git pull`) inserts one line above it. Every
 * `line:col` the board holds now names the element one line up. Before the
 * guard, a prop and a text edit aimed at "Two" rewrote "One", and a delete
 * aimed at "One" removed "Zero" — each reporting `written: 1`. With the
 * identity the parser recorded sent along as `expect`, each refuses
 * `element-moved` and the file is left exactly as the outside writer left it.
 *
 * The expectations come from the REAL parser (`parsePageFile`), not from a
 * hand-built fingerprint: the contract under test is "what the board read is
 * what the guard checks", end to end.
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
} from '@core/page-parser'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-identity-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const write = (rel: string, contents: string) => {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}
const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')

/** What the board holds after a load: every parsed node, by the text it shows. */
function board(rel: string): Map<string, ParsedNode> {
  const file = path.join(tmpDir, ...rel.split('/'))
  const parsed = parsePageFile(file, tmpDir, createWorkspaceProject(tmpDir), {
    pageBudget: createPageEvalBudget(),
    workspaceRoot: tmpDir,
  })
  const byText = new Map<string, ParsedNode>()
  for (const node of Object.values(parsed.nodes)) byText.set(node.text ?? node.name, node)
  return byText
}

const LIST = [
  'export default function Home() {',
  '  return (',
  '    <ul>',
  '      <li title="a">One</li>',
  '      <li title="b">Two</li>',
  '    </ul>',
  '  )',
  '}',
  '',
].join('\n')

/** The outside writer: one new line above the list the board already read. */
function insertLineAbove(): string {
  const shifted = read('pages/Home.tsx').replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n')
  write('pages/Home.tsx', shifted)
  return shifted
}

describe('WB-1 — an edit whose file changed under the board refuses instead of writing a neighbour', () => {
  it('refuses a prop and a text edit aimed at "Two" after a line was inserted above it', () => {
    write('pages/Home.tsx', LIST)
    const two = board('pages/Home.tsx').get('Two')!
    const afterOutsideEdit = insertLineAbove()

    const edits: StudioEdit[] = [
      { kind: 'prop', nodeId: two.id, prop: 'title', value: 'EDITED-b' },
      { kind: 'text', nodeId: two.id, text: 'Two (edited)' },
    ]
    const result = applyStudioEditBatch(tmpDir, edits, { [two.id]: two.fingerprint! })

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => [refusal.kind, refusal.reason])).toEqual([
      ['prop', 'element-moved'],
      ['text', 'element-moved'],
    ])
    expect(result.refusals[0]!.message).toContain('pages/Home.tsx')
    // Byte-identical to what the outside writer left: "One" was not rewritten.
    expect(read('pages/Home.tsx')).toBe(afterOutsideEdit)
  })

  it('refuses a delete aimed at "One" instead of removing "Zero"', () => {
    write('pages/Home.tsx', LIST)
    const one = board('pages/Home.tsx').get('One')!
    const afterOutsideEdit = insertLineAbove()

    const result = applyStudioEditBatch(tmpDir, [{ kind: 'delete', nodeId: one.id }], { [one.id]: one.fingerprint! })

    expect(result.written).toBe(0)
    expect(result.refusals).toEqual([
      expect.objectContaining({ kind: 'delete', reason: 'element-moved', nodeId: one.id }),
    ])
    expect(read('pages/Home.tsx')).toBe(afterOutsideEdit)
    expect(read('pages/Home.tsx')).toContain('<li>Zero</li>')
  })

  it('refuses a move whose ANCHOR moved, even when the element itself did not', () => {
    write('pages/Home.tsx', LIST)
    const nodes = board('pages/Home.tsx')
    const one = nodes.get('One')!
    const two = nodes.get('Two')!
    // Shift only what is BELOW "One": the anchor's position now names "Extra".
    write('pages/Home.tsx', read('pages/Home.tsx').replace('      <li title="b">', '      <li>Extra</li>\n      <li title="b">'))
    const before = read('pages/Home.tsx')

    const result = applyStudioEditBatch(
      tmpDir,
      [{ kind: 'move', nodeId: one.id, anchorNodeId: two.id, position: 'after' }],
      { [one.id]: one.fingerprint!, [two.id]: two.fingerprint! },
    )

    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('pages/Home.tsx')).toBe(before)
  })

  it('refuses a literal edit whose dictionary key shifted under it', () => {
    write('i18n/copy.ts', ["export const copy = {", "  title: 'Welcome',", '}', ''].join('\n'))
    write('pages/Home.tsx', ["import { copy } from '../i18n/copy'", 'export default function Home() {', '  return <h1>{copy.title}</h1>', '}', ''].join('\n'))
    const origin = board('pages/Home.tsx').get('Welcome')!.textOrigin!
    const originId = `${origin.rel}:${origin.line}:${origin.col}`
    // Another key lands above, with its string at the column the board read.
    write('i18n/copy.ts', ["export const copy = {", "  intro: 'Hi there',", "  title: 'Welcome',", '}', ''].join('\n'))
    const before = read('i18n/copy.ts')

    const result = applyStudioEditBatch(tmpDir, [{ kind: 'literal', nodeId: originId, text: 'Hello' }], {
      [originId]: origin.fingerprint!,
    })

    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('i18n/copy.ts')).toBe(before)
  })
})

describe('the guard never blocks an honest write', () => {
  it('writes when the file is as the board read it, and reports the new identity', () => {
    write('pages/Home.tsx', LIST)
    const two = board('pages/Home.tsx').get('Two')!

    const result = applyStudioEditBatch(
      tmpDir,
      [
        // Two value edits on ONE element in one batch: each is checked against
        // the file BEFORE the batch, so the first write is not mistaken for a move.
        { kind: 'prop', nodeId: two.id, prop: 'title', value: 'EDITED-b' },
        { kind: 'style', nodeId: two.id, style: { color: 'red' } },
      ],
      { [two.id]: two.fingerprint! },
    )

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    expect(read('pages/Home.tsx')).toContain('<li title="EDITED-b" style={{ color: "red" }}>Two</li>')
    // The identity after the write is what the NEXT edit must expect.
    const now = board('pages/Home.tsx').get('Two')!
    expect(result.fingerprints.at(-1)).toEqual({ nodeId: two.id, fingerprint: now.fingerprint! })
    expect(now.fingerprint).not.toBe(two.fingerprint)
  })

  it('a follow-up edit that carries the reported identity writes; one still carrying the stale identity refuses', () => {
    write('pages/Home.tsx', LIST)
    const two = board('pages/Home.tsx').get('Two')!
    const first = applyStudioEditBatch(tmpDir, [{ kind: 'prop', nodeId: two.id, prop: 'title', value: 'x' }], {
      [two.id]: two.fingerprint!,
    })
    const reported = first.fingerprints[0]!.fingerprint

    const stale = applyStudioEditBatch(tmpDir, [{ kind: 'prop', nodeId: two.id, prop: 'title', value: 'y' }], {
      [two.id]: two.fingerprint!,
    })
    expect(stale.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])

    const fresh = applyStudioEditBatch(tmpDir, [{ kind: 'prop', nodeId: two.id, prop: 'title', value: 'y' }], {
      [two.id]: reported,
    })
    expect(fresh.written).toBe(1)
    expect(read('pages/Home.tsx')).toContain('<li title="y">Two</li>')
  })

  it('checks nothing for an id the caller sent no expectation for (the guard is opt-in per id)', () => {
    write('pages/Home.tsx', LIST)
    const two = board('pages/Home.tsx').get('Two')!
    const result = applyStudioEditBatch(tmpDir, [{ kind: 'prop', nodeId: two.id, prop: 'title', value: 'z' }])
    expect(result.written).toBe(1)
  })
})

describe('WB-11 — a prop edit never bakes a literal over a binding', () => {
  const PAGE = [
    "const c = { heading: 'Where to?' }",
    'export default function Home() {',
    '  return (',
    '    <main>',
    '      <h2 title={c.heading}>A</h2>',
    "      <h3 title={'plain'} tabIndex={-1} hidden>B</h3>",
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n')

  it('refuses binding-overwrite on an expression initializer and leaves the file byte-identical', () => {
    write('pages/Home.tsx', PAGE)
    const h2 = board('pages/Home.tsx').get('A')!

    const result = applyStudioEditBatch(tmpDir, [{ kind: 'prop', nodeId: h2.id, prop: 'title', value: 'Where to?' }])

    expect(result.written).toBe(0)
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'prop', reason: 'binding-overwrite' })])
    expect(read('pages/Home.tsx')).toBe(PAGE)
  })

  it('still rewrites a literal in braces, a signed number, and a bare boolean attribute', () => {
    write('pages/Home.tsx', PAGE)
    const h3 = board('pages/Home.tsx').get('B')!

    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'prop', nodeId: h3.id, prop: 'title', value: 'changed' },
      { kind: 'prop', nodeId: h3.id, prop: 'tabIndex', value: 0 },
      { kind: 'prop', nodeId: h3.id, prop: 'hidden', value: false },
    ])

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(3)
    expect(read('pages/Home.tsx')).toContain('<h3 title="changed" tabIndex={0} hidden={false}>B</h3>')
  })
})
