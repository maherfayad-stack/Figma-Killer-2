/**
 * `store-13` — `applyStudioEditBatch` reports the node ids a batch CREATED.
 *
 * The contract under test is narrow and load-bearing: every id in
 * `createdNodeIds` must be the id the PARSER would mint for that element on
 * its next read of the file the batch left behind. So every assertion here
 * re-derives the expectation from the post-batch file rather than pinning a
 * literal — an id that is merely plausible is exactly the failure mode this
 * feature has to avoid, because the editor then selects, and lets the user
 * edit, an element they never made.
 *
 * The multi-edit case is the one worth reading. `orderStudioEditsForApply`
 * applies a batch BOTTOM-TO-TOP, so an edit that runs late sits above an
 * element an earlier edit already created and pushes it down the file. A
 * created id recorded as an absolute line would be stale for every element but
 * the last; `applyStudioEditBatch` pins each one to its distance from the END
 * of the file instead, and this is the test that holds that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-created-ids-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const REL = 'src/Page.tsx'

const PAGE = `export default function Page() {
  return (
    <section className="list">
      <p>first</p>
      <p>second</p>
    </section>
  )
}
`

function writePage(source = PAGE): void {
  const full = path.join(tmpDir, ...REL.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, source, 'utf8')
}

const readPage = (): string => fs.readFileSync(path.join(tmpDir, ...REL.split('/')), 'utf8')

/** The id the parser will mint for the Nth `<tag` in the file as it now stands. */
function idOfTag(tag: string, occurrence = 1): string {
  const { line, col } = locateTag(readPage(), tag, occurrence)
  return `${REL}:${line}:${col}`
}

/** The node id naming the Nth `<tag` in the file as it stands BEFORE the batch. */
function idIn(source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${REL}:${line}:${col}`
}

describe('applyStudioEditBatch — createdNodeIds', () => {
  it('names the child an insert wrote, not the container it was written into', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'insert', nodeId: idIn(PAGE, 'section'), name: 'span', children: 'third' },
    ])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([idOfTag('span')])
  })

  it('accounts for the import line an insert writes above the JSX', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'insert',
        nodeId: idIn(PAGE, 'section'),
        name: 'Chip',
        importSpecifier: '../design-system',
      },
    ])

    expect(result.written).toBe(1)
    expect(readPage().startsWith("import { Chip } from '../design-system'")).toBe(true)
    expect(result.createdNodeIds).toEqual([idOfTag('Chip')])
  })

  it('P5-B IMG-2 — names EVERY element of a one-edit sibling run, in order, in one write', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'insert',
        nodeId: idIn(PAGE, 'section'),
        anchorNodeId: idIn(PAGE, 'p', 1),
        position: 'after',
        name: 'img',
        props: { src: '/a.png', alt: 'a' },
        siblings: [
          { name: 'img', props: { src: '/b.png', alt: 'b' } },
          { name: 'img', props: { src: '/c.png', alt: 'c' } },
        ],
      },
    ])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([idOfTag('img', 1), idOfTag('img', 2), idOfTag('img', 3)])
    expect(readPage()).toContain('<p>first</p>\n      <img src="/a.png" alt="a" />\n      <img src="/b.png" alt="b" />\n      <img src="/c.png" alt="c" />\n      <p>second</p>')
  })

  it('names the COPY a duplicate wrote, never the original', () => {
    writePage()
    const original = idIn(PAGE, 'p')
    const result = applyStudioEditBatch(tmpDir, [{ kind: 'duplicate', nodeId: original }])

    expect(result.written).toBe(1)
    // Three `<p>`s now: first, its copy, second.
    expect(result.createdNodeIds).toEqual([idOfTag('p', 2)])
    expect(result.createdNodeIds).not.toContain(original)
  })

  it('names the wrapper a wrap wrote', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'wrap', nodeId: idIn(PAGE, 'p'), name: 'div' },
    ])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([idOfTag('div')])
  })

  it('names the one container a group wrote around a run of siblings', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'group',
        nodeId: idIn(PAGE, 'p', 1),
        siblingNodeIds: [idIn(PAGE, 'p', 2)],
        name: 'div',
      },
    ])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([idOfTag('div')])
  })

  it('keeps every created id honest when one batch creates several, bottom-to-top', () => {
    writePage()
    // A multi-selection ⌘D. The batch applies the LOWER `<p>` first, so the
    // upper one's copy is written afterwards and pushes the first copy down.
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'duplicate', nodeId: idIn(PAGE, 'p', 1) },
      { kind: 'duplicate', nodeId: idIn(PAGE, 'p', 2) },
    ])

    expect(result.written).toBe(2)
    // Four `<p>`s now: first, its copy, second, its copy. The batch ran
    // bottom-to-top, so the ids come back in that order.
    expect([...result.createdNodeIds].sort()).toEqual([idOfTag('p', 2), idOfTag('p', 4)].sort())
    // The stale reading — recording an absolute line at the time each edit ran
    // — would report the lower copy one line too high.
    expect(result.createdNodeIds).not.toContain(idOfTag('p', 3))
  })

  it('reports nothing for the kinds that create nothing', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [{ kind: 'delete', nodeId: idIn(PAGE, 'p', 2) }])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([])
  })

  it('reports nothing when the write was refused', () => {
    writePage()
    const result = applyStudioEditBatch(tmpDir, [
      // The component's own returned root has no siblings to be copied among.
      { kind: 'duplicate', nodeId: idIn(PAGE, 'section') },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.createdNodeIds).toEqual([])
  })
})
