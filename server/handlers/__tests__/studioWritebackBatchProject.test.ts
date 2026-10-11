/**
 * WB-25 — a batch of edits shares ONE ts-morph project per file.
 *
 * Every value codemod used to create its own project and parse its file from
 * scratch, and the identity guard parsed it once more after every write: 40
 * prop edits to a 1,500-element page cost 3.8 s in the audit's probe (about
 * 17 s on the machine this was fixed on), all of it inside the project write
 * lock. `applyStudioEditBatch` now opens the file once and re-syncs the shared
 * project with the disk before each edit (`syncProjectWithDisk`).
 *
 * The count below is the regression pin: a file load per edit is exactly what
 * made the batch O(edits × parse). The other two cases pin what sharing must
 * NOT change — every edit still lands, and a codemod that declines halfway
 * through its own tree leaves nothing behind for the next edit to save.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project } from 'ts-morph'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-batch-project-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ROWS = 60
/** `<li>` N sits on line N + 3, its tag name at column 8. */
function writeList(): string {
  const rows = Array.from({ length: ROWS }, (_, i) => `      <li title="t${i}" style={{ color: 'red' }}>Item ${i}</li>`)
  const source = ['export default function Page() {', '  return (', '    <ul>', ...rows, '    </ul>', '  )', '}', ''].join('\n')
  fs.writeFileSync(path.join(tmpDir, 'page.tsx'), source, 'utf8')
  return source
}
const rowId = (i: number): string => `page.tsx:${i + 4}:8`
const read = (): string => fs.readFileSync(path.join(tmpDir, 'page.tsx'), 'utf8')

describe('applyStudioEditBatch — one project per batch (WB-25)', () => {
  it('opens a file once for a whole batch of edits to it, not once per edit', () => {
    writeList()
    const loads = spyOn(Project.prototype, 'addSourceFileAtPath')
    try {
      const edits: StudioEdit[] = Array.from({ length: 40 }, (_, i) => ({
        kind: 'prop',
        nodeId: rowId(i),
        prop: 'title',
        value: `x${i}`,
      }))
      const result = applyStudioEditBatch(tmpDir, edits)
      expect(result.written).toBe(40)
      expect(loads).toHaveBeenCalledTimes(1)
    } finally {
      loads.mockRestore()
    }
  })

  it('lands every kind in a mixed batch exactly as each would alone', () => {
    const source = writeList()
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'prop', nodeId: rowId(1), prop: 'title', value: 'one' },
      { kind: 'text', nodeId: rowId(2), text: 'Second' },
      { kind: 'style', nodeId: rowId(3), style: { color: 'blue' } },
      { kind: 'tag', nodeId: rowId(4), tag: 'ol' },
    ])
    expect(result.written).toBe(4)
    expect(result.shifted).toBe(false)
    expect(read()).toBe(
      source
        .replace('title="t1"', 'title="one"')
        .replace('>Item 2<', '>Second<')
        .replace(`<li title="t3" style={{ color: 'red' }}>`, `<li title="t3" style={{ color: 'blue' }}>`)
        .replace(`<li title="t4" style={{ color: 'red' }}>Item 4</li>`, `<ol title="t4" style={{ color: 'red' }}>Item 4</ol>`),
    )
  })

  it("never saves the half-changed tree an earlier edit's refusal left behind", () => {
    const rows = [
      '      <li title="a">A</li>',
      "      <li style={{ padding: 4, color }}>B</li>",
    ]
    const source = ['export const Page = ({ color }: { color: string }) => (', '    <ul>', ...rows, '    </ul>', ')', ''].join('\n')
    fs.writeFileSync(path.join(tmpDir, 'page.tsx'), source, 'utf8')
    // The bottom edit runs first (bottom-to-top): it removes `padding` from
    // the shared tree and only THEN refuses on the shorthand `color`. The edit
    // above it saves the same file next — and must save the disk's version.
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'prop', nodeId: 'page.tsx:3:8', prop: 'title', value: 'ay' },
      { kind: 'style', nodeId: 'page.tsx:4:8', style: { color: 'blue' }, remove: ['padding'] },
    ])
    expect(result.written).toBe(1)
    expect(result.refusals.map((refusal) => refusal.nodeId)).toEqual(['page.tsx:4:8'])
    expect(read()).toBe(source.replace('title="a"', 'title="ay"'))
  })
})
