/**
 * `reinsertJsxSource` — `store-15`'s half of ⌘Z on a source delete.
 *
 * Held to the same bar `structuralJsxCodemods.test.ts` set for the codemods
 * either side of it: byte-for-byte. A delete's own bytes, spliced back at the
 * position `deleteJsxElement`/`pruneOrphanedImports` reported, must reproduce
 * the original file exactly — that IS the undo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deleteJsxElement } from '../deleteJsxElement'
import { createImportPruneSession } from '../pruneOrphanedImports'
import { reinsertJsxSource } from '../reinsertJsxSource'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-reinsert-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Page.tsx'): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

describe('reinsertJsxSource — round trip with deleteJsxElement', () => {
  it('restores a whole-line sibling byte-for-byte at the end of the list', () => {
    const PAGE = `export default function Page() {
  return (
    <section>
      <p>First</p>
      <p>Second</p>
    </section>
  )
}
`
    const file = writeFixture(PAGE)
    const section = locateTag(PAGE, 'section')
    const second = locateTag(PAGE, 'p', 2)

    const deleted = deleteJsxElement({ file, line: second.line, col: second.col })
    if (!deleted.ok) throw new Error('unreachable')
    expect(deleted.removed).toEqual({ text: '      <p>Second</p>\n', wholeLine: true })
    expect(read(file)).not.toBe(PAGE)

    const restored = reinsertJsxSource({
      file,
      line: section.line,
      col: section.col,
      index: 1,
      text: deleted.removed.text,
    })
    expect(restored).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })

  it('restores a whole-line sibling byte-for-byte in the middle of the list', () => {
    const PAGE = `export default function Page() {
  return (
    <section>
      <p>First</p>
      <p>Second</p>
      <p>Third</p>
    </section>
  )
}
`
    const file = writeFixture(PAGE)
    const section = locateTag(PAGE, 'section')
    const second = locateTag(PAGE, 'p', 2)

    const deleted = deleteJsxElement({ file, line: second.line, col: second.col })
    if (!deleted.ok) throw new Error('unreachable')

    const restored = reinsertJsxSource({
      file,
      line: section.line,
      col: section.col,
      index: 1,
      text: deleted.removed.text,
    })
    expect(restored).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })

  it('restores an inline sibling byte-for-byte — no indentation to fake', () => {
    const PAGE = `export default function Page() {
  return (
    <div><a/><b/></div>
  )
}
`
    const file = writeFixture(PAGE)
    const div = locateTag(PAGE, 'div')
    const a = locateTag(PAGE, 'a')

    const deleted = deleteJsxElement({ file, line: a.line, col: a.col })
    if (!deleted.ok) throw new Error('unreachable')
    expect(deleted.removed).toEqual({ text: '<a/>', wholeLine: false })

    const restored = reinsertJsxSource({ file, line: div.line, col: div.col, index: 0, text: deleted.removed.text })
    expect(restored).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })

  it('restores the sole child of an emptied parent, on its own line', () => {
    const PAGE = `export default function Page() {
  return (
    <section>
      <p>Only</p>
    </section>
  )
}
`
    const file = writeFixture(PAGE)
    const section = locateTag(PAGE, 'section')
    const p = locateTag(PAGE, 'p')

    const deleted = deleteJsxElement({ file, line: p.line, col: p.col })
    if (!deleted.ok) throw new Error('unreachable')
    expect(read(file)).toBe(`export default function Page() {
  return (
    <section>
    </section>
  )
}
`)

    const restored = reinsertJsxSource({ file, line: section.line, col: section.col, index: 0, text: deleted.removed.text })
    expect(restored).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })

  it('restores an element AND the import a delete pruned, byte-for-byte', () => {
    const PAGE = `import { Card } from './Card'

export default function Page() {
  return (
    <section>
      <Card />
    </section>
  )
}
`
    const file = writeFixture(PAGE)
    const card = locateTag(PAGE, 'Card')

    const session = createImportPruneSession()
    const before = session.snapshot(file)
    const deleted = deleteJsxElement({ file, line: card.line, col: card.col })
    if (!deleted.ok) throw new Error('unreachable')
    const pruned = session.prune(file, before)
    expect(pruned).toEqual({ removed: ['Card'], declarations: ["import { Card } from './Card'"] })
    // Pruning the import shifted every line below it by one — `<section>`'s
    // own `line:col` has to be re-read from the file as it now stands, the
    // same reparse a real batch's `historyNodeIdRemap` would hand back.
    const afterPrune = read(file)
    expect(afterPrune).toBe(`
export default function Page() {
  return (
    <section>
    </section>
  )
}
`)
    const section = locateTag(afterPrune, 'section')

    const restored = reinsertJsxSource({
      file,
      line: section.line,
      col: section.col,
      index: 0,
      text: deleted.removed.text,
      imports: pruned.declarations,
    })
    expect(restored).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })

  it('restores two siblings under one parent, applied ascending by index', () => {
    const PAGE = `export default function Page() {
  return (
    <ul>
      <li>A</li>
      <li>B</li>
      <li>C</li>
    </ul>
  )
}
`
    const file = writeFixture(PAGE)
    const ul = locateTag(PAGE, 'ul')
    const a = locateTag(PAGE, 'li', 1)
    const c = locateTag(PAGE, 'li', 3)

    // Bottom-to-top, same discipline `orderStudioEditsForApply` enforces on a
    // real batch: deleting C first leaves A's line untouched for the second call.
    const deletedC = deleteJsxElement({ file, line: c.line, col: c.col })
    if (!deletedC.ok) throw new Error('unreachable')
    const deletedA = deleteJsxElement({ file, line: a.line, col: a.col })
    if (!deletedA.ok) throw new Error('unreachable')
    expect(read(file)).toBe(`export default function Page() {
  return (
    <ul>
      <li>B</li>
    </ul>
  )
}
`)

    // Ascending index: A (originally 0) before C (originally 2).
    const restoredA = reinsertJsxSource({ file, line: ul.line, col: ul.col, index: 0, text: deletedA.removed.text })
    expect(restoredA).toMatchObject({ ok: true })
    const restoredC = reinsertJsxSource({ file, line: ul.line, col: ul.col, index: 2, text: deletedC.removed.text })
    expect(restoredC).toMatchObject({ ok: true })
    expect(read(file)).toBe(PAGE)
  })
})

describe('reinsertJsxSource — refusals leave the file untouched', () => {
  const PAGE = `export default function Page() {
  return (
    <section>
      <p>First</p>
    </section>
  )
}
`

  it('refuses when the parent no longer resolves', () => {
    const file = writeFixture(PAGE)
    const result = reinsertJsxSource({ file, line: 99, col: 5, index: 0, text: '<p>Gone</p>\n' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('not-found')
    expect(read(file)).toBe(PAGE)
  })

  it('refuses an import that does not parse as exactly one ImportDeclaration', () => {
    const file = writeFixture(PAGE)
    const section = locateTag(PAGE, 'section')

    const result = reinsertJsxSource({
      file,
      line: section.line,
      col: section.col,
      index: 1,
      text: '      <p>Second</p>\n',
      imports: ['this is not an import'],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('invalid-import')
    expect(read(file)).toBe(PAGE)
  })

  it('refuses a restore that would leave the file with a syntax error', () => {
    const file = writeFixture(PAGE)
    const section = locateTag(PAGE, 'section')

    const result = reinsertJsxSource({
      file,
      line: section.line,
      col: section.col,
      index: 1,
      text: '      <p>\n',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('invalid-source')
    expect(read(file)).toBe(PAGE)
  })
})
