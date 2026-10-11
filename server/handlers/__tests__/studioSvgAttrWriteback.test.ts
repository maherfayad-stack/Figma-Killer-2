/**
 * The `svg-attr` kind through the real batch engine (P5-D, SVG-4): schema,
 * dispatch, ordering by part, the refusal channel, and the parse ⇄ write
 * round trip that makes a stamped part the exact place a write lands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Value } from '@core/utils/typeboxHelpers'
import { createPageEvalBudget, parsePageFile } from '@core/page-parser'
import { applyStudioEditBatch, orderStudioEditsForApply, StudioEditSchema, type StudioEdit } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-svg-attr-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const REL = 'src/Icon.tsx'

function write(source: string): void {
  const full = path.join(tmpDir, ...REL.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, source, 'utf8')
}

const read = (): string => fs.readFileSync(path.join(tmpDir, ...REL.split('/')), 'utf8')

/** The parsed svg node's id and its stamped parts, as the canvas would read them. */
function parseSvg(): { hostId: string; parts: { part: string; tag: string }[] } {
  const page = parsePageFile(path.join(tmpDir, ...REL.split('/')), tmpDir, undefined, {
    pageBudget: createPageEvalBudget(),
    workspaceRoot: tmpDir,
  })
  const svg = Object.values(page.nodes).find((node) => node.name === 'svg')!
  const parts = [...String(svg.props.svg).matchAll(/<(\w+) data-studio-svg-part="(\d+:\d+)"/g)].map((m) => ({ tag: m[1]!, part: m[2]! }))
  return { hostId: svg.id, parts }
}

const SOURCE = [
  'export default function Icon() {',
  '  return (',
  '    <svg viewBox="0 0 24 24">',
  '      <path',
  '        d="M4 4h16"',
  '      />',
  '      <path d="M4 12h16" />',
  '    </svg>',
  '  )',
  '}',
  '',
].join('\n')

describe('svg-attr through the batch', () => {
  it('is a valid wire edit', () => {
    const edit = { kind: 'svg-attr', nodeId: `${REL}:3:6`, part: '7:8', partTag: 'path', set: { d: 'M0 0', strokeWidth: 2 }, remove: ['fill'] }
    expect(Value.Check(StudioEditSchema, edit)).toBe(true)
    expect(Value.Check(StudioEditSchema, { ...edit, set: { d: { nested: 1 } } })).toBe(false)
  })

  it('writes the part the parser stamped, and re-parses to the same stamps', () => {
    write(SOURCE)
    const { hostId, parts } = parseSvg()
    expect(parts.map((p) => p.part)).toEqual(['4:8', '7:8'])
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'svg-attr', nodeId: hostId, part: parts[1]!.part, partTag: 'path', set: { d: 'M4 12h20' } },
    ])
    expect(result.written).toBe(1)
    expect(result.refusals).toEqual([])
    expect(read()).toBe(SOURCE.replace('d="M4 12h16"', 'd="M4 12h20"'))
    expect(parseSvg().parts).toEqual(parts)
  })

  it('orders two parts of one svg bottom-to-top, so a write that wraps a line cannot move the other', () => {
    const edits: StudioEdit[] = [
      { kind: 'svg-attr', nodeId: `${REL}:3:6`, part: '4:8', partTag: 'path', set: {} },
      { kind: 'svg-attr', nodeId: `${REL}:3:6`, part: '7:8', partTag: 'path', set: {} },
      { kind: 'prop', nodeId: `${REL}:3:6`, prop: 'id', value: 'x' },
    ]
    expect(orderStudioEditsForApply(edits).map((e) => ('part' in e ? e.part : 'host'))).toEqual(['7:8', '4:8', 'host'])
  })

  it('applies both parts of one batch (no collapse onto the shared host id)', () => {
    write(SOURCE)
    const { hostId, parts } = parseSvg()
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'svg-attr', nodeId: hostId, part: parts[0]!.part, partTag: 'path', set: { fill: 'red' } },
      { kind: 'svg-attr', nodeId: hostId, part: parts[1]!.part, partTag: 'path', set: { fill: 'blue' } },
    ])
    expect(result.written).toBe(2)
    const written = read()
    expect(written).toContain('fill="red"')
    expect(written).toContain('<path d="M4 12h16" fill="blue" />')
  })

  it('reports a refusal by name and writes nothing', () => {
    write(SOURCE)
    const { hostId, parts } = parseSvg()
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'svg-attr', nodeId: hostId, part: parts[0]!.part, partTag: 'path', set: { onLoad: 'x' } },
      { kind: 'svg-attr', nodeId: hostId, part: 'nonsense', partTag: 'path', set: { d: 'M0 0' } },
    ])
    expect(result.written).toBe(0)
    expect(result.refusals.map((r) => r.reason).sort()).toEqual(['svg-attr-name', 'svg-part-outside-host'])
    expect(read()).toBe(SOURCE)
  })

  it('refuses a host that moved in its file rather than writing a stale part (P1-D)', () => {
    write(SOURCE)
    const { hostId, parts } = parseSvg()
    const page = parsePageFile(path.join(tmpDir, ...REL.split('/')), tmpDir, undefined, {
      pageBudget: createPageEvalBudget(),
      workspaceRoot: tmpDir,
    })
    const fingerprint = page.nodes[hostId]!.sourceFingerprint!
    // An outside editor adds a line above the graphic: the host moves down by one.
    write(`// moved\n${SOURCE}`)
    const result = applyStudioEditBatch(
      tmpDir,
      [{ kind: 'svg-attr', nodeId: hostId, part: parts[1]!.part, partTag: 'path', set: { d: 'M0 0' } }],
      { [hostId]: fingerprint },
    )
    expect(result.written).toBe(0)
    expect(result.refusals[0]?.reason).toBe('element-moved')
    expect(read()).toBe(`// moved\n${SOURCE}`)
  })
})
