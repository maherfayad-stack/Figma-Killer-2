/**
 * `setJsxTagName` — the writeback behind the editor's `tag` property.
 *
 * `tag` is the one property that is not an attribute: it is synthesized from the
 * element's NAME so an imported `<h1>` keeps rendering as an `<h1>`. It used to be
 * written through `setJsxProp`, which added a literal `tag="section"` attribute
 * and left the element a `<div>` — a control that looked live, changed the canvas,
 * and wrote junk into the user's source.
 *
 * Most of these tests are about NOT writing: the tag position is the one place a
 * bad string produces a file that no longer parses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setJsxTagName, JsxTagNameTargetError } from '../setJsxTagName'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-tag-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/** 1-based line/col of the character right after `<` — what a node id encodes. */
function locateTag(source: string, tag: string): { line: number; col: number } {
  const index = source.indexOf(`<${tag}`)
  if (index < 0) throw new Error(`fixture does not contain <${tag}`)
  const before = source.slice(0, index + 1)
  const line = before.split('\n').length
  const col = index + 1 - (before.lastIndexOf('\n') + 1) + 1
  return { line, col }
}

const read = (file: string): string => fs.readFileSync(file, 'utf8')

describe('setJsxTagName', () => {
  it('renames both the opening and closing tag', () => {
    const source = 'export default () => (\n  <div className="card">Hello</div>\n)\n'
    const file = writeFixture('Screen.jsx', source)

    setJsxTagName({ file, ...locateTag(source, 'div'), tag: 'section' })

    const written = read(file)
    expect(written).toContain('<section className="card">Hello</section>')
    // No stray attribute — the old path added `tag="section"` here.
    expect(written).not.toContain('tag=')
  })

  it('renames a self-closing element', () => {
    const source = 'export default () => <br />\n'
    const file = writeFixture('Screen.jsx', source)

    setJsxTagName({ file, ...locateTag(source, 'br'), tag: 'hr' })

    expect(read(file)).toContain('<hr />')
  })

  it('leaves nested elements of the same name alone', () => {
    const source = 'export default () => (\n  <div><div>inner</div></div>\n)\n'
    const file = writeFixture('Screen.jsx', source)

    // Target the INNER div by locating the second occurrence.
    const innerIndex = source.indexOf('<div', source.indexOf('<div') + 1)
    const before = source.slice(0, innerIndex + 1)
    setJsxTagName({
      file,
      line: before.split('\n').length,
      col: innerIndex + 1 - (before.lastIndexOf('\n') + 1) + 1,
      tag: 'span',
    })

    expect(read(file)).toContain('<div><span>inner</span></div>')
  })

  it('accepts a custom element name', () => {
    const source = 'export default () => <div>x</div>\n'
    const file = writeFixture('Screen.jsx', source)

    setJsxTagName({ file, ...locateTag(source, 'div'), tag: 'my-widget' })

    expect(read(file)).toContain('<my-widget>x</my-widget>')
  })

  it('is a no-op when the tag already matches', () => {
    const source = 'export default () => <div>x</div>\n'
    const file = writeFixture('Screen.jsx', source)

    setJsxTagName({ file, ...locateTag(source, 'div'), tag: 'div' })

    expect(read(file)).toBe(source)
  })

  it('refuses to rename a component reference', () => {
    // `<Sheet>` → `<Dialog>` needs the new name imported and in scope, which this
    // codemod cannot know.
    const source = 'export default () => <Sheet title="x">y</Sheet>\n'
    const file = writeFixture('Screen.jsx', source)

    expect(() => setJsxTagName({ file, ...locateTag(source, 'Sheet'), tag: 'div' })).toThrow(
      JsxTagNameTargetError,
    )
    expect(read(file)).toBe(source)
  })

  it.each([
    ['a closing bracket', 'div>'],
    ['an attribute', 'div onClick={x}'],
    ['a member expression', 'Foo.Bar'],
    ['whitespace', 'di v'],
    ['empty', ''],
    ['an uppercase component', 'Section'],
  ])('refuses %s as the new name', (_label, tag) => {
    const source = 'export default () => <div>x</div>\n'
    const file = writeFixture('Screen.jsx', source)

    expect(() => setJsxTagName({ file, ...locateTag(source, 'div'), tag })).toThrow(
      JsxTagNameTargetError,
    )
    expect(read(file)).toBe(source)
  })

  it('throws when no element sits at the location', () => {
    const source = 'export default () => <div>x</div>\n'
    const file = writeFixture('Screen.jsx', source)

    expect(() => setJsxTagName({ file, line: 99, col: 1, tag: 'section' })).toThrow()
    expect(read(file)).toBe(source)
  })
})
