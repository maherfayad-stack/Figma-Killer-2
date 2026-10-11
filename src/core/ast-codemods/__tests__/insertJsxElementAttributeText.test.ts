/**
 * G-10 — what `insertJsxElement` writes for an attribute VALUE, and the
 * `className` expression a CSS-Module class needs.
 *
 * A pasted design brings attribute values the older callers never did: a title
 * with a quote in it, an href with `&` in the query, a placeholder across two
 * lines. JSX string attributes have no backslash escapes and decode entities,
 * so those must be written as expression containers or the line is not the
 * value that was pasted (or not valid code at all).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxElement } from '../insertJsxElement'
import { ClassNameTokens } from '../jsxClassTokens'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-insert-attr-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const PAGE = `export default function Page() {
  return (
    <main>
      <h1>Hi</h1>
    </main>
  )
}
`

function write(source: string): string {
  const file = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

function insertInto(file: string, props: Record<string, string | ClassNameTokens>) {
  return insertJsxElement({ file, ...locateTag(PAGE, 'main'), name: 'a', props, children: 'link' })
}

describe('insertJsxElement - attribute values', () => {
  it('writes a plain value as a string attribute, unchanged', () => {
    const file = write(PAGE)
    insertInto(file, { href: '/pricing?plan=team', title: 'See the plans' })
    expect(read(file)).toContain('<a href="/pricing?plan=team" title="See the plans">link</a>')
  })

  it('writes a value holding a quote, a backslash, an ampersand or a newline as an expression container', () => {
    const file = write(PAGE)
    const result = insertInto(file, {
      title: 'He said "hi"',
      'data-path': 'C:\\temp',
      href: '/a?x=1&y=2',
      placeholder: 'line one\nline two',
    })
    expect(result.ok).toBe(true)
    expect(read(file)).toContain(
      '<a title={"He said \\"hi\\""} data-path={"C:\\\\temp"} href={"/a?x=1&y=2"} placeholder={"line one\\nline two"}>link</a>',
    )
  })
})

describe('insertJsxElement - a CSS-Module className', () => {
  it('writes a single module class as styles.name', () => {
    const file = write(PAGE)
    insertInto(file, { className: new ClassNameTokens([{ module: { binding: 'styles', local: 'card' } }]) })
    expect(read(file)).toContain('<a className={styles.card}>link</a>')
  })

  it('writes a hyphenated class by bracket access and mixes literal tokens in a template', () => {
    const file = write(PAGE)
    insertInto(file, {
      className: new ClassNameTokens([
        { module: { binding: 'css', local: 'btn-primary' } },
        { literal: 'wide' },
        { literal: 'a`b' },
      ]),
    })
    expect(read(file)).toContain('<a className={`${css["btn-primary"]} wide a\\`b`}>link</a>')
  })

  it('refuses a binding that is not an identifier, so no expression can be smuggled into the file', () => {
    expect(() => new ClassNameTokens([{ module: { binding: 'styles); evil(', local: 'a' } }])).toThrow()
  })
})
