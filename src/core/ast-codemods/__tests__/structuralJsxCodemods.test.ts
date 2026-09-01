/**
 * `moveJsxElement` / `deleteJsxElement` — the two writes behind `struct-01`.
 *
 * These are the first codemods in this folder that change WHERE markup is
 * rather than what it says, so the bar they are held to is the one `panel-02`
 * set for CSS write-back: assert the whole file, byte for byte, against the
 * original with one thing moved or gone. Anything that reformats an untouched
 * sibling, eats a blank line, or reindents a comment is a defect, and only a
 * whole-file assertion catches it.
 *
 * The refusal cases matter at least as much. A structural edit that cannot
 * land honestly must leave the file byte-identical — a half-applied move is
 * strictly worse than no move.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deleteJsxElement } from '../deleteJsxElement'
import { moveJsxElement } from '../moveJsxElement'
import { spliceRange } from '../jsxChildRange'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-struct-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Page.tsx'): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/**
 * Formatting here is load-bearing: the comment, the blank line inside the
 * list, the trailing attribute on `<Third>`, and the two-space rhythm all
 * exist so the byte-exact assertions have something real to protect.
 */
const PAGE = `import { Third } from './Third'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <p className="first">First</p>

      <p className="second">Second</p>
      <Third
        label="third"
      />
    </section>
  )
}
`

describe('moveJsxElement', () => {
  it('moves a whole-line sibling after another, leaving every other byte identical', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const second = locateTag(PAGE, 'p', 2)

    const result = moveJsxElement({
      file,
      line: first.line,
      col: first.col,
      anchorLine: second.line,
      anchorCol: second.col,
      position: 'after',
    })
    expect(result).toEqual({ ok: true })

    // The moved line, and nothing else. The comment stays put, the blank line
    // keeps its place in the sequence, `<Third>` keeps its wrapping.
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace('      <p className="first">First</p>\n', '').replace(
        '      <p className="second">Second</p>\n',
        '      <p className="second">Second</p>\n      <p className="first">First</p>\n',
      ),
    )
  })

  it('moves a sibling before another, including a multi-line element', () => {
    const file = writeFixture(PAGE)
    const third = locateTag(PAGE, 'Third')
    const first = locateTag(PAGE, 'p', 1)

    const result = moveJsxElement({
      file,
      line: third.line,
      col: third.col,
      anchorLine: first.line,
      anchorCol: first.col,
      position: 'before',
    })
    expect(result).toEqual({ ok: true })

    const block = '      <Third\n        label="third"\n      />\n'
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(block, '').replace('      <p className="first">First</p>\n', block + '      <p className="first">First</p>\n'),
    )
  })

  it('reorders two elements that share a line, inline', () => {
    const source = 'export default () => <div><a href="/a">A</a><b>B</b></div>\n'
    const file = writeFixture(source)
    const a = locateTag(source, 'a')
    const b = locateTag(source, 'b')

    expect(
      moveJsxElement({ file, line: a.line, col: a.col, anchorLine: b.line, anchorCol: b.col, position: 'after' }),
    ).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'export default () => <div><b>B</b><a href="/a">A</a></div>\n',
    )
  })

  it('refuses two elements the canvas shows side by side but the source nests differently', () => {
    const source = `export default function Page() {
  return (
    <section>
      <div>
        <span>inner</span>
      </div>
      <p>outer</p>
    </section>
  )
}
`
    const file = writeFixture(source)
    const span = locateTag(source, 'span')
    const p = locateTag(source, 'p')

    const result = moveJsxElement({
      file,
      line: span.line,
      col: span.col,
      anchorLine: p.line,
      anchorCol: p.col,
      position: 'after',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('not-siblings')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a move that would have to reformat, when one side shares its line', () => {
    const source = `export default function Page() {
  return (
    <section>
      <p>alone</p>
      <b>shared</b><i>line</i>
    </section>
  )
}
`
    const file = writeFixture(source)
    const p = locateTag(source, 'p')
    const b = locateTag(source, 'b')

    const result = moveJsxElement({
      file,
      line: p.line,
      col: p.col,
      anchorLine: b.line,
      anchorCol: b.col,
      position: 'after',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('mixed-indentation')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses to move the component root, which has no siblings in the code', () => {
    const source = 'export default function Page() {\n  return <section>hi</section>\n}\n'
    const file = writeFixture(source)
    const section = locateTag(source, 'section')

    const result = moveJsxElement({
      file,
      line: section.line,
      col: section.col,
      anchorLine: section.line,
      anchorCol: section.col,
      position: 'after',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('no-jsx-parent')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses an element the code produces from an expression, not from a fixed position', () => {
    // `parser-06` selects a branch and leaves the node UNLOCKED (its values are
    // editable), so nothing before this point refuses it — this check is what
    // keeps its POSITION honest.
    const source = `export default function Page({ loading }) {
  return (
    <section>
      {loading && <span>spinner</span>}
      <p>content</p>
    </section>
  )
}
`
    const file = writeFixture(source)
    const span = locateTag(source, 'span')
    const p = locateTag(source, 'p')

    const result = moveJsxElement({
      file,
      line: span.line,
      col: span.col,
      anchorLine: p.line,
      anchorCol: p.col,
      position: 'after',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('expression-child')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a location that no longer holds a JSX element', () => {
    const file = writeFixture(PAGE)
    const result = moveJsxElement({ file, line: 1, col: 1, anchorLine: 1, anchorCol: 3, position: 'after' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('not-found')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })
})

describe('deleteJsxElement', () => {
  it('removes one element and its line, leaving every other byte identical', () => {
    const file = writeFixture(PAGE)
    const second = locateTag(PAGE, 'p', 2)

    expect(deleteJsxElement({ file, line: second.line, col: second.col })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE.replace('      <p className="second">Second</p>\n', ''))
  })

  // Deleting an element whose import nothing else uses used to REFUSE, which
  // left the user to go finish the job by hand. It no longer does: the element
  // goes here, and the binding it alone was using is retired by
  // `pruneOrphanedImports` once the whole batch has landed (see that module,
  // and `pruneOrphanedImports.test.ts`, for why the two are separate).
  it('deletes an element whose import nothing else uses, leaving the import for the batch pass', () => {
    const file = writeFixture(PAGE)
    const third = locateTag(PAGE, 'Third')

    expect(deleteJsxElement({ file, line: third.line, col: third.col })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace('      <Third\n        label="third"\n      />\n', ''),
    )
  })

  it('refuses to delete the component root', () => {
    const source = 'export default function Page() {\n  return <section>hi</section>\n}\n'
    const file = writeFixture(source)
    const section = locateTag(source, 'section')

    const result = deleteJsxElement({ file, line: section.line, col: section.col })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('no-jsx-parent')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})

describe('spliceRange', () => {
  it('moves a range forward, accounting for the hole the cut left behind', () => {
    expect(spliceRange('ABCDEF', 0, 2, 4)).toBe('CDABEF')
  })

  it('moves a range backward without adjusting the target', () => {
    expect(spliceRange('ABCDEF', 4, 6, 0)).toBe('EFABCD')
  })
})
