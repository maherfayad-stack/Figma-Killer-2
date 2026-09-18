/**
 * `store-14` — `applyStudioEditBatch` reports the node ids a batch MOVED, and
 * an undo of a source-writing gesture is a real write that round-trips the
 * file.
 *
 * Two contracts, both narrow and both load-bearing.
 *
 * **`relocatedNodeIds`.** `store-13` covered what a batch CREATES; a
 * `move`/`reparent`/`ungroup` creates nothing while being exactly the kind
 * whose ids change, which is why the board dropped its selection across every
 * drag and why the family had no undo to address. Every assertion here
 * re-derives the expectation from the post-batch file rather than pinning a
 * literal, for `studioCreatedNodeIds.test.ts`'s reason: an id that is merely
 * plausible is the failure mode this has to avoid.
 *
 * **The revert.** `structuralUndoPlan.ts` expresses each gesture's inverse in
 * the edit kinds that already exist rather than inventing a `revert` kind, so
 * what proves the design is that applying the inverse gives the file back
 * BYTE FOR BYTE. That is asserted here for a group (undone by an ungroup), an
 * insert (undone by a delete, import and all) and a cross-frame transplant —
 * the two-file case, where the undo has to put markup back in one file and
 * take it out of another in a single batch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-relocated-ids-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const REL = 'src/Page.tsx'

const PAGE = `export default function Page() {
  return (
    <section className="list">
      <p>first</p>
      <b>second</b>
      <i>third</i>
    </section>
  )
}
`

function write(rel: string, source: string): void {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, source, 'utf8')
}

const read = (rel: string): string => fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')

/** The id the parser will mint for the Nth `<tag` in `rel` as it now stands. */
function idOf(rel: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(read(rel), tag, occurrence)
  return `${rel}:${line}:${col}`
}

/** The node id naming the Nth `<tag` in a source string. */
function idIn(rel: string, source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${rel}:${line}:${col}`
}

describe('applyStudioEditBatch — relocatedNodeIds', () => {
  it('names the element in its new slot after a sibling reorder', () => {
    write(REL, PAGE)
    const result = applyStudioEditBatch(tmpDir, [
      {
        kind: 'move',
        nodeId: idIn(REL, PAGE, 'p'),
        anchorNodeId: idIn(REL, PAGE, 'i'),
        position: 'after',
      },
    ])

    expect(result.written).toBe(1)
    expect(result.createdNodeIds).toEqual([])
    expect(result.relocatedNodeIds).toEqual([idOf(REL, 'p')])
    // It really moved — its id is not the one it had.
    expect(result.relocatedNodeIds[0]).not.toBe(idIn(REL, PAGE, 'p'))
  })

  it('names the element inside its new parent after a reparent', () => {
    const source = `export default function Page() {
  return (
    <section>
      <p>first</p>
      <aside></aside>
    </section>
  )
}
`
    write(REL, source)
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'reparent', nodeId: idIn(REL, source, 'p'), parentNodeId: idIn(REL, source, 'aside') },
    ])

    expect(result.written).toBe(1)
    expect(result.relocatedNodeIds).toEqual([idOf(REL, 'p')])
  })

  it('names every child an ungroup released, in source order', () => {
    const source = `export default function Page() {
  return (
    <section>
      <div>
        <p>first</p>
        <b>second</b>
      </div>
    </section>
  )
}
`
    write(REL, source)
    const result = applyStudioEditBatch(tmpDir, [{ kind: 'ungroup', nodeId: idIn(REL, source, 'div') }])

    expect(result.written).toBe(1)
    expect(result.relocatedNodeIds).toEqual([idOf(REL, 'p'), idOf(REL, 'b')])
  })
})

describe('the structural family undoes itself through ordinary edit kinds', () => {
  it('group → ungroup gives the file back byte for byte', () => {
    const source = `export default function Page() {
  return (
    <section>
      <p>first</p>
      <b>second</b>
    </section>
  )
}
`
    write(REL, source)

    const grouped = applyStudioEditBatch(tmpDir, [
      {
        kind: 'group',
        nodeId: idIn(REL, source, 'p'),
        siblingNodeIds: [idIn(REL, source, 'b')],
        name: 'div',
      },
    ])
    expect(grouped.written).toBe(1)
    expect(grouped.createdNodeIds).toHaveLength(1)

    // The inverse `structuralUndoPlan.ts` records for a group: dissolve what it
    // created.
    const undone = applyStudioEditBatch(tmpDir, [{ kind: 'ungroup', nodeId: grouped.createdNodeIds[0]! }])
    expect(undone.written).toBe(1)
    expect(read(REL)).toBe(source)
  })

  /**
   * Why `dissolveWrapperTemplate` records `unsupported` for a COMPONENT
   * wrapper rather than an `ungroup`: this is what would happen if it did not.
   * `unwrapJsxElement` refuses a component tag by name (`has-behaviour`) —
   * removing the call site is deleting a component usage, not ungrouping — so
   * the undo would post a write the server refuses, with a sentence about
   * behaviour the user never mentioned. The refusal is made at ⌘Z instead.
   */
  it('refuses to dissolve a COMPONENT wrapper, which is why that group has no canvas undo', () => {
    const source = `export default function Page() {
  return (
    <section>
      <p>first</p>
      <b>second</b>
    </section>
  )
}
`
    write(REL, source)
    write('src/ui/Card.tsx', 'export function Card(props: { children?: unknown }) { return null }\n')

    const grouped = applyStudioEditBatch(tmpDir, [
      {
        kind: 'group',
        nodeId: idIn(REL, source, 'p'),
        siblingNodeIds: [idIn(REL, source, 'b')],
        name: 'Card',
        importSpecifier: '../ui/Card',
      },
    ])
    expect(grouped.createdNodeIds).toHaveLength(1)

    const undone = applyStudioEditBatch(tmpDir, [{ kind: 'ungroup', nodeId: grouped.createdNodeIds[0]! }])
    expect(undone.written).toBe(0)
    expect(undone.refusals.map((r) => r.reason)).toEqual(['has-behaviour'])
  })

  it('insert → delete gives the file back byte for byte', () => {
    write(REL, PAGE)
    const inserted = applyStudioEditBatch(tmpDir, [
      { kind: 'insert', nodeId: idIn(REL, PAGE, 'section'), name: 'span', props: {}, children: 'fourth' },
    ])
    expect(inserted.createdNodeIds).toHaveLength(1)

    const undone = applyStudioEditBatch(tmpDir, [{ kind: 'delete', nodeId: inserted.createdNodeIds[0]! }])
    expect(undone.written).toBe(1)
    expect(read(REL)).toBe(PAGE)
  })

  /**
   * The two-file case. A cross-frame drag removes markup from one file and
   * writes it into another; its undo has to do both, in one batch, and leave
   * both files exactly as they were — including the import it carried across
   * and the one it pruned behind it.
   */
  it('transplant → transplant back restores BOTH files', () => {
    const HOME = `import { Badge } from '../ui/Badge'

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Badge tone="quiet">New</Badge>
      <p>tail</p>
    </main>
  )
}
`
    const ABOUT = `export default function About() {
  return (
    <main>
      <h1>About</h1>
    </main>
  )
}
`
    const HOME_REL = 'src/pages/Home.tsx'
    const ABOUT_REL = 'src/pages/About.tsx'
    write(HOME_REL, HOME)
    write(ABOUT_REL, ABOUT)
    write('src/ui/Badge.tsx', 'export function Badge(props: { tone?: string; children?: unknown }) { return null }\n')

    const moved = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: idIn(HOME_REL, HOME, 'Badge'),
        parentNodeId: idIn(ABOUT_REL, ABOUT, 'main'),
      },
    ])
    expect(moved.written).toBe(1)
    expect(moved.relocatedNodeIds).toHaveLength(1)
    expect(read(HOME_REL)).not.toContain('<Badge')
    expect(read(ABOUT_REL)).toContain('<Badge')

    // `transplant-back`: the element, addressed where the move left it, sent
    // to the container it came from and anchored before the sibling that now
    // occupies its old slot.
    const undone = applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: moved.relocatedNodeIds[0]!,
        parentNodeId: idOf(HOME_REL, 'main'),
        anchorNodeId: idOf(HOME_REL, 'p'),
        position: 'before',
      },
    ])
    expect(undone.written).toBe(1)
    expect(read(HOME_REL)).toBe(HOME)
    expect(read(ABOUT_REL)).toBe(ABOUT)
  })
})
