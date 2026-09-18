/**
 * `store-14` — every structural codemod that MOVES markup reports where it
 * ended up, and the reported `line:col` is the one the parser will mint the
 * moved node's id from.
 *
 * The counterpart of `createdJsxLocation.test.ts`, and it uses the same
 * deliberately indirect assertion shape: every case re-derives the expected
 * location from the file the codemod actually wrote (`locateTag` on the
 * post-write source), so a test cannot pass by drifting in step with the
 * locator.
 *
 * Two things this pins that nothing else does:
 *  - a REORDER's element keeps no id of its own — the board used to drop its
 *    selection every time a drag moved something;
 *  - an UNGROUP relocates SEVERAL elements at once, which is why `relocated`
 *    is a list and why its own undo (a group around the same run) has anything
 *    to address.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { moveJsxElement } from '../moveJsxElement'
import { unwrapJsxElement } from '../unwrapJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-relocated-'))
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
      <b>second</b>
      <i>third</i>
    </section>
  )
}
`

describe('moveJsxElement reports where the moved element landed', () => {
  it('names the element in its new slot after a sibling reorder', () => {
    const file = writeFixture(PAGE)
    const result = moveJsxElement({
      file,
      ...locateTag(PAGE, 'p'),
      anchorLine: locateTag(PAGE, 'i').line,
      anchorCol: locateTag(PAGE, 'i').col,
      position: 'after',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = read(file)
    // The `<p>` is now the LAST child, so its own line has changed — which is
    // exactly why the board needs to be told.
    expect(result.relocated).toEqual(locateTag(after, 'p'))
    expect(result.relocated).not.toEqual(locateTag(PAGE, 'p'))
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
    const file = writeFixture(source)
    const result = moveJsxElement({
      file,
      ...locateTag(source, 'p'),
      destinationLine: locateTag(source, 'aside').line,
      destinationCol: locateTag(source, 'aside').col,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relocated).toEqual(locateTag(read(file), 'p'))
  })
})

describe('unwrapJsxElement reports the children it released', () => {
  it('names every released child, in source order', () => {
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
    const file = writeFixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'div') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = read(file)
    expect(result.relocated).toEqual([locateTag(after, 'p'), locateTag(after, 'b')])
  })

  it('names the one child of an inline container unwrapped in place', () => {
    const source = `export default function Page() {
  return (
    <p>Hello <span><b>world</b></span></p>
  )
}
`
    const file = writeFixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'span') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relocated).toEqual([locateTag(read(file), 'b')])
  })

  it('reports nothing for a self-closing container, which hands nothing back', () => {
    const source = `export default function Page() {
  return (
    <section>
      <div />
    </section>
  )
}
`
    const file = writeFixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'div') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relocated).toEqual([])
  })
})
