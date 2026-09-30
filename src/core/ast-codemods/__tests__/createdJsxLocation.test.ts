/**
 * `store-13` — every structural codemod that CREATES markup reports where it
 * landed, and the reported `line:col` is the one the parser will mint the new
 * node's id from.
 *
 * The assertion shape is deliberately indirect: rather than hard-coding
 * numbers, every case re-derives the expected location from the file the
 * codemod actually wrote (`locateTag` on the post-write source). A test that
 * only pinned literals would still pass if the codemod and the locator drifted
 * together — this one fails the moment `created` stops naming the element the
 * write actually produced.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxElement } from '../insertJsxElement'
import { duplicateJsxElement } from '../duplicateJsxElement'
import { wrapJsxElement } from '../wrapJsxElement'
import { wrapJsxElements } from '../wrapJsxElements'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-created-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Page.tsx'): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const read = (file: string): string => fs.readFileSync(file, 'utf8')

const PAGE = `export default function Page() {
  return (
    <section className="list">
      <p>first</p>
      <p>second</p>
    </section>
  )
}
`

describe('insertJsxElement reports where the new element landed', () => {
  it('names the appended child, not the container it was written into', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({ file, ...locateTag(PAGE, 'section'), name: 'span', children: 'third' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual([locateTag(read(file), 'span')])
  })

  it('accounts for the import line it writes above the JSX', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      name: 'Chip',
      importSpecifier: '../design-system',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = read(file)
    // The import pushed every JSX line down by one; a `created` that had been
    // measured against the pre-write text would be exactly one line short.
    expect(after.startsWith("import { Chip } from '../design-system'")).toBe(true)
    expect(result.created).toEqual([locateTag(after, 'Chip')])
  })

  it('names the new element when it joins an existing line', () => {
    const source = `export default function Page() {
  return (
    <div><a href="/">one</a></div>
  )
}
`
    const file = writeFixture(source)
    const result = insertJsxElement({ file, ...locateTag(source, 'div'), name: 'b', children: 'two' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual([locateTag(read(file), 'b')])
  })

  it('names the first child of a self-closing parent it reopened', () => {
    const source = `export default function Page() {
  return (
    <section className="empty" />
  )
}
`
    const file = writeFixture(source)
    const result = insertJsxElement({ file, ...locateTag(source, 'section'), name: 'p', children: 'hi' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual([locateTag(read(file), 'p')])
  })

  it('names the ROOT of a nested subtree written in one call', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      name: 'article',
      children: [{ name: 'h2', children: 'Title' }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual([locateTag(read(file), 'article')])
  })
})

describe('duplicateJsxElement reports the COPY, never the original', () => {
  it('names the second occurrence after an in-place copy', () => {
    const file = writeFixture(PAGE)
    const result = duplicateJsxElement({ file, ...locateTag(PAGE, 'p') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Three `<p>`s now: first, its copy, second. The copy is occurrence #2.
    expect(result.created).toEqual(locateTag(read(file), 'p', 2))
    expect(result.created).not.toEqual(locateTag(PAGE, 'p'))
  })

  it('names the copy inside the container an Alt+drag dropped it into', () => {
    const source = `export default function Page() {
  return (
    <section>
      <p>row</p>
      <aside className="tray" />
    </section>
  )
}
`
    const file = writeFixture(source)
    const result = duplicateJsxElement({
      file,
      ...locateTag(source, 'p'),
      destinationLine: locateTag(source, 'aside').line,
      destinationCol: locateTag(source, 'aside').col,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual(locateTag(read(file), 'p', 2))
  })
})

describe('wrap and group report the CONTAINER they wrote', () => {
  it('names the wrapper, which now sits where the element used to', () => {
    const file = writeFixture(PAGE)
    const result = wrapJsxElement({ file, ...locateTag(PAGE, 'p'), name: 'div' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual(locateTag(read(file), 'div'))
  })

  it('names a wrapper COMPONENT after its own import shifted the file down', () => {
    const file = writeFixture(PAGE)
    const result = wrapJsxElement({
      file,
      ...locateTag(PAGE, 'p'),
      name: 'Card',
      importSpecifier: '../design-system',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual(locateTag(read(file), 'Card'))
  })

  it('names the one container a group wrote around a run of siblings', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const second = locateTag(PAGE, 'p', 2)
    const result = wrapJsxElements({ file, targets: [first, second], name: 'div' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toEqual(locateTag(read(file), 'div'))
  })
})
