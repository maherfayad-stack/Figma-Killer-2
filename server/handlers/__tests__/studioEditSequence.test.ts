/**
 * P3-D — `applyStudioEditSequence`: several structural writes, each against
 * the file the previous one left, all or nothing.
 *
 * Whole-file byte assertions, like every structural codemod suite: a sequence
 * that lands its second step one line off is exactly the corruption this
 * engine exists to prevent, and only the whole file shows it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditSequence } from '../studioEditSequence'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sequence-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const REL = 'pages/Home.tsx'

function write(contents: string): void {
  const full = path.join(tmpDir, ...REL.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (): string => fs.readFileSync(path.join(tmpDir, ...REL.split('/')), 'utf8')

function id(source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${REL}:${line}:${col}`
}

const page = (children: string): string => `export default function Home() {
  return (
    <main>
${children}    </main>
  )
}
`

describe('applyStudioEditSequence', () => {
  it('moves two non-adjacent elements after a third, each step aimed at the file the last one left', () => {
    const source = page(`      <h1>A</h1>
      <h2>B</h2>
      <h3>C</h3>
      <h4>D</h4>
      <h5>E</h5>
`)
    write(source)
    // "A after E, then C after A" — the second step names A, which the first
    // one moved, and E, whose line the first one shifted.
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'move', nodeId: id(source, 'h1'), anchorNodeId: id(source, 'h5'), position: 'after' },
      { kind: 'move', nodeId: id(source, 'h3'), anchorNodeId: id(source, 'h1'), position: 'after' },
    ])
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    const expected = page(`      <h2>B</h2>
      <h4>D</h4>
      <h5>E</h5>
      <h1>A</h1>
      <h3>C</h3>
`)
    expect(read()).toBe(expected)
    // Where each moved element is NOW — what the board selects.
    expect([...result.relocatedNodeIds].sort()).toEqual([id(expected, 'h1'), id(expected, 'h3')].sort())
  })

  it('follows elements by document order, so identical siblings are never confused', () => {
    // Five identical cards: a line diff cannot tell them apart, order can.
    const source = page(`      <Card />
      <Card />
      <Card />
      <p>end</p>
`)
    write(source)
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'move', nodeId: id(source, 'Card', 1), anchorNodeId: id(source, 'p'), position: 'after' },
      { kind: 'move', nodeId: id(source, 'Card', 3), anchorNodeId: id(source, 'Card', 1), position: 'after' },
    ])
    expect(result.refusals).toEqual([])
    expect(read()).toBe(page(`      <Card />
      <p>end</p>
      <Card />
      <Card />
`))
  })

  it('brings non-adjacent members together and groups them, as one sequence', () => {
    const source = page(`      <h1>A</h1>
      <h2>B</h2>
      <h3>C</h3>
`)
    write(source)
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'move', nodeId: id(source, 'h3'), anchorNodeId: id(source, 'h1'), position: 'after' },
      { kind: 'group', nodeId: id(source, 'h1'), siblingNodeIds: [id(source, 'h3')], name: 'div' },
    ])
    expect(result.refusals).toEqual([])
    const expected = page(`      <div>
        <h1>A</h1>
        <h3>C</h3>
      </div>
      <h2>B</h2>
`)
    expect(read()).toBe(expected)
    expect(result.createdNodeIds).toEqual([id(expected, 'div')])
  })

  it('forwards what an earlier step created through the steps after it', () => {
    const source = page(`      <h1>A</h1>
      <h2>B</h2>
`)
    write(source)
    // Two copies of A written after B: the second copy is written ABOVE the
    // first (`after B` each time), which pushes the first one down a line.
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'duplicate', nodeId: id(source, 'h1'), parentNodeId: id(source, 'main'), anchorNodeId: id(source, 'h2'), position: 'after' },
      { kind: 'duplicate', nodeId: id(source, 'h1'), parentNodeId: id(source, 'main'), anchorNodeId: id(source, 'h2'), position: 'after' },
    ])
    expect(result.refusals).toEqual([])
    const expected = page(`      <h1>A</h1>
      <h2>B</h2>
      <h1>A</h1>
      <h1>A</h1>
`)
    expect(read()).toBe(expected)
    expect([...result.createdNodeIds].sort()).toEqual([id(expected, 'h1', 2), id(expected, 'h1', 3)].sort())
  })

  it('puts every file back when a later step is refused', () => {
    const source = page(`      <h1>A</h1>
      <section>
        <h2>B</h2>
      </section>
      <h3>C</h3>
`)
    write(source)
    // Step 2 is written against an element that is not C's sibling.
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'move', nodeId: id(source, 'h1'), anchorNodeId: id(source, 'h3'), position: 'after' },
      { kind: 'move', nodeId: id(source, 'h3'), anchorNodeId: id(source, 'h2'), position: 'after' },
    ])
    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]!.nodeId).toBe(id(source, 'h3'))
    expect(read()).toBe(source)
  })

  it('refuses before writing anything when a step is a kind it cannot follow', () => {
    const source = page(`      <h1>A</h1>
`)
    write(source)
    const result = applyStudioEditSequence(tmpDir, [
      { kind: 'text', nodeId: id(source, 'h1'), text: 'Z' },
    ])
    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('not-sequenced')
    expect(read()).toBe(source)
  })
})
