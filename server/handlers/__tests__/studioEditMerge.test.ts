/**
 * WB-7 — two instances of one shared component, edited in one save batch.
 *
 * Every instance writes back to the same `line:col` in the component's own
 * file, so `dedupeStudioEdits` collapses their edits to one. It used to keep
 * only the LAST: instance A's `{ padding }` and `+a` were dropped, instance B's
 * `{ margin }` and `+b` written, and the batch still reported `written: 2` —
 * so the client adopted both baselines and A's changes vanished on the next
 * reload. A `style` or `class` edit is a SET of changes; two instances' sets
 * are both wanted and are merged. A genuine conflict (one prop, two values)
 * stays last-wins — the file can only hold one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { INLINE_ID_SEPARATOR } from '@core/page-parser'
import { applyStudioEditBatch, dedupeStudioEdits } from '../studioWriteback'
import type { StudioEdit } from '../studioEditSchemas'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

const CARD = [
  'export default function Card() {',
  "  return <div className=\"card\" style={{ color: 'red' }}>Card</div>",
  '}',
  '',
].join('\n')

const PAGE = [
  "import Card from '../components/Card'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Card />',
  '      <Card />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

/** The composite id of the Card root rendered at the `n`th call site on the page. */
function instanceId(n: number): string {
  const call = locateTag(PAGE, 'Card', n)
  const root = locateTag(CARD, 'div')
  return `pages/Home.tsx:${call.line}:${call.col}${INLINE_ID_SEPARATOR}components/Card.tsx:${root.line}:${root.col}`
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-edit-merge-'))
  write('components/Card.tsx', CARD)
  write('pages/Home.tsx', PAGE)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('dedupeStudioEdits — merges instead of dropping', () => {
  it('unions two instances\' style patches into one edit, and remembers the absorbed node', () => {
    const [merged, ...rest] = dedupeStudioEdits(tmpDir, [
      { kind: 'style', nodeId: instanceId(1), style: { padding: '8px' } },
      { kind: 'style', nodeId: instanceId(2), style: { margin: '4px' } },
    ])
    expect(rest).toHaveLength(0)
    expect(merged).toMatchObject({ kind: 'style', nodeId: instanceId(2), style: { padding: '8px', margin: '4px' } })
    expect(merged!.absorbedNodeIds).toEqual([instanceId(1)])
  })

  it('unions class add/remove sets, and resolves a token both added and removed by order', () => {
    const [merged] = dedupeStudioEdits(tmpDir, [
      { kind: 'class', nodeId: instanceId(1), add: [{ kind: 'literal', token: 'a' }, { kind: 'literal', token: 'x' }], remove: [] },
      { kind: 'class', nodeId: instanceId(2), add: [{ kind: 'literal', token: 'b' }], remove: [{ kind: 'literal', token: 'x' }] },
    ])
    expect(merged).toMatchObject({
      add: [{ kind: 'literal', token: 'a' }, { kind: 'literal', token: 'b' }],
      remove: [{ kind: 'literal', token: 'x' }],
    })
  })

  it('a property set by one instance and removed by a later one ends removed — and the reverse ends set', () => {
    const [removedLast] = dedupeStudioEdits(tmpDir, [
      { kind: 'style', nodeId: instanceId(1), style: { gap: '2px' } },
      { kind: 'style', nodeId: instanceId(2), style: {}, remove: ['gap'] },
    ])
    expect(removedLast).toMatchObject({ style: {}, remove: ['gap'] })

    const [setLast] = dedupeStudioEdits(tmpDir, [
      { kind: 'style', nodeId: instanceId(1), style: {}, remove: ['gap'] },
      { kind: 'style', nodeId: instanceId(2), style: { gap: '2px' } },
    ])
    expect(setLast).toMatchObject({ style: { gap: '2px' } })
    expect((setLast as { remove?: string[] }).remove).toBeUndefined()
  })

  it('keeps a genuine conflict last-wins: one prop, two values', () => {
    const deduped = dedupeStudioEdits(tmpDir, [
      { kind: 'prop', nodeId: instanceId(1), prop: 'title', value: 'First' },
      { kind: 'prop', nodeId: instanceId(2), prop: 'title', value: 'Second' },
    ])
    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toMatchObject({ value: 'Second', absorbedNodeIds: [instanceId(1)] })
  })
})

describe('applyStudioEditBatch — two instances, one file, every change lands', () => {
  it('writes both instances\' style declarations and both class tokens', () => {
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'style', nodeId: instanceId(1), style: { padding: '8px' } },
      { kind: 'class', nodeId: instanceId(1), add: [{ kind: 'literal', token: 'a' }], remove: [] },
      { kind: 'style', nodeId: instanceId(2), style: { margin: '4px' } },
      { kind: 'class', nodeId: instanceId(2), add: [{ kind: 'literal', token: 'b' }], remove: [] },
    ])

    const card = read('components/Card.tsx')
    expect(card).toContain('padding')
    expect(card).toContain('margin')
    expect(card).toContain('color')
    expect(card).toMatch(/className="card a b"/)
    expect(result.skipped).toBe(0)
    expect(result.refusals).toEqual([])
  })

  it('a refused merged edit is reported refused for EVERY instance behind it, never as written', () => {
    // `className={tone}` is a bare identifier. An ADD wraps it (P3-C, WB-18);
    // a REMOVE refuses by name (`unsupported-expression`) — the token is
    // produced by `tone`, and there is no text in the file to delete it from.
    const dynamicCard = [
      "const tone = 'card'",
      'export default function Card() {',
      '  return <div className={tone}>Card</div>',
      '}',
      '',
    ].join('\n')
    write('components/Card.tsx', dynamicCard)
    const root = locateTag(dynamicCard, 'div')
    const idAt = (n: number): string => {
      const call = locateTag(PAGE, 'Card', n)
      return `pages/Home.tsx:${call.line}:${call.col}${INLINE_ID_SEPARATOR}components/Card.tsx:${root.line}:${root.col}`
    }
    const edits: StudioEdit[] = [
      { kind: 'class', nodeId: idAt(1), add: [], remove: [{ kind: 'literal', token: 'card' }] },
      { kind: 'class', nodeId: idAt(2), add: [], remove: [{ kind: 'literal', token: 'card' }] },
    ]

    const result = applyStudioEditBatch(tmpDir, edits)
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.refusals.map((refusal) => refusal.nodeId).sort()).toEqual([idAt(1), idAt(2)].sort())
    expect(new Set(result.refusals.map((refusal) => refusal.reason))).toEqual(new Set(['unsupported-expression']))
    expect(read('components/Card.tsx')).toBe(dynamicCard)
  })
})
