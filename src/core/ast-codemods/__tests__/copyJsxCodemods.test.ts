/**
 * `duplicateJsxElement` / `wrapJsxElement` / `moveJsxElement`'s reparent form —
 * W4-1's three writes, held to the same bar `structuralJsxCodemods.test.ts` set
 * for move and delete: assert the WHOLE file, byte for byte, against the
 * original with one thing added, wrapped or relocated. Anything that reformats
 * an untouched sibling, eats a blank line or reindents a comment is a defect,
 * and only a whole-file assertion catches it.
 *
 * The refusal cases matter at least as much, and are the reason this file is
 * long. These three verbs REFUSED unconditionally until now; a change that
 * quietly starts writing where it used to decline is the worst regression this
 * module can ship, so every refusal that survives is asserted by name and every
 * file it declines is asserted unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { duplicateJsxElement } from '../duplicateJsxElement'
import { wrapJsxElement } from '../wrapJsxElement'
import { moveJsxElement } from '../moveJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-copy-'))
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
 * Formatting is load-bearing: the comment, the blank line, the multi-line
 * attribute list on `<Third>` and the inline pair inside `<footer>` all exist so
 * the byte-exact assertions have something real to protect.
 */
const PAGE = `import { Third } from './Third'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <p className="first">First</p>

      <Third
        label="third"
        tone="quiet"
      />
      <aside className="empty"></aside>
      <footer><a href="/a">A</a><a href="/b">B</a></footer>
    </section>
  )
}
`

describe('duplicateJsxElement', () => {
  it('copies a whole-line element in as its own next sibling, byte for byte', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)

    expect(duplicateJsxElement({ file, ...first })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '      <p className="first">First</p>\n',
        '      <p className="first">First</p>\n      <p className="first">First</p>\n',
      ),
    )
  })

  it('copies a multi-line, multi-prop self-closing element with its own wrapping intact', () => {
    const file = writeFixture(PAGE)
    const third = locateTag(PAGE, 'Third')

    expect(duplicateJsxElement({ file, ...third })).toEqual({ ok: true })
    const block = '      <Third\n        label="third"\n        tone="quiet"\n      />\n'
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE.replace(block, block + block))
  })

  it('copies an INLINE element onto the same line, separated by one space', () => {
    const file = writeFixture(PAGE)
    const a = locateTag(PAGE, 'a', 1)

    expect(duplicateJsxElement({ file, ...a })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '<footer><a href="/a">A</a><a href="/b">B</a></footer>',
        '<footer><a href="/a">A</a> <a href="/a">A</a><a href="/b">B</a></footer>',
      ),
    )
  })

  it('duplicates a child of a FRAGMENT — a fragment is an ordinary JSX parent', () => {
    const source = `export default function Page() {
  return (
    <>
      <h1>Title</h1>
      <p>Body</p>
    </>
  )
}
`
    const file = writeFixture(source)
    expect(duplicateJsxElement({ file, ...locateTag(source, 'h1') })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      source.replace('      <h1>Title</h1>\n', '      <h1>Title</h1>\n      <h1>Title</h1>\n'),
    )
  })

  it('REFUSES the element a component returns — a second root is not valid JSX', () => {
    const file = writeFixture(PAGE)
    const root = locateTag(PAGE, 'section')

    const result = duplicateJsxElement({ file, ...root })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('no-jsx-parent')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES an element the code produces from an expression', () => {
    const source = `export default function Page({ show }) {
  return (
    <div>
      {show && <span className="badge">New</span>}
    </div>
  )
}
`
    const file = writeFixture(source)
    const result = duplicateJsxElement({ file, ...locateTag(source, 'span') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('expression-child')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('REFUSES a location the file no longer has an element at — including one past its end', () => {
    const file = writeFixture(PAGE)
    const result = duplicateJsxElement({ file, ...locateTag(PAGE, 'p', 1), line: 3, col: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-found')

    // A stale id can also name a line the file no longer HAS. That used to
    // throw out of the TypeScript compiler's own assert and reach the user as
    // an unexplained skip; it is an ordinary refusal.
    const pastTheEnd = duplicateJsxElement({ file, line: 9_000, col: 1 })
    expect(pastTheEnd.ok).toBe(false)
    if (!pastTheEnd.ok) expect(pastTheEnd.refusal.reason).toBe('not-found')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })
})

describe('wrapJsxElement', () => {
  it('wraps a whole-line element in a div, re-hanging only its own indentation', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)

    expect(wrapJsxElement({ file, ...first, name: 'div' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '      <p className="first">First</p>',
        '      <div>\n        <p className="first">First</p>\n      </div>',
      ),
    )
  })

  it('re-indents a multi-line subtree by exactly one level, keeping every other byte', () => {
    const file = writeFixture(PAGE)
    const third = locateTag(PAGE, 'Third')

    expect(wrapJsxElement({ file, ...third, name: 'section' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '      <Third\n        label="third"\n        tone="quiet"\n      />',
        '      <section>\n        <Third\n          label="third"\n          tone="quiet"\n        />\n      </section>',
      ),
    )
  })

  it('wraps an INLINE element in place, without breaking the line the user kept', () => {
    const file = writeFixture(PAGE)
    const b = locateTag(PAGE, 'a', 2)

    expect(wrapJsxElement({ file, ...b, name: 'span' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace('<a href="/b">B</a></footer>', '<span><a href="/b">B</a></span></footer>'),
    )
  })

  it('writes the import when the wrapper is a component, into the file\'s own quote style', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)

    expect(
      wrapJsxElement({ file, ...first, name: 'Stack', importSpecifier: '@acme/ui' }),
    ).toEqual({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain("import { Stack } from '@acme/ui'\n")
    expect(after).toContain('      <Stack>\n        <p className="first">First</p>\n      </Stack>')
  })

  it('REFUSES a wrapper name that is not a tag Studio will write', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)

    const unsafe = wrapJsxElement({ file, ...first, name: 'script' })
    expect(unsafe.ok).toBe(false)
    if (!unsafe.ok) expect(unsafe.refusal.reason).toBe('unsafe-tag')

    // A capitalised name with no import is a component nobody declared.
    const unbound = wrapJsxElement({ file, ...first, name: 'Stack' })
    expect(unbound.ok).toBe(false)
    if (!unbound.ok) expect(unbound.refusal.reason).toBe('unsafe-tag')

    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES a wrapper whose name this file already binds to something else', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)

    const result = wrapJsxElement({ file, ...first, name: 'Third', importSpecifier: '@acme/ui' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('binding-conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES wrapping the element a component returns', () => {
    const file = writeFixture(PAGE)
    const result = wrapJsxElement({ file, ...locateTag(PAGE, 'section'), name: 'div' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('no-jsx-parent')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })
})

/** Two components in one file: the fixture for both the scope check and the honest same-component move. */
const TWO_COMPONENTS = `function Card({ title }) {
  return (
    <article className="card">
      {/* the heading reads a prop of THIS component */}
      <h2 className="card-title">{title}</h2>
    </article>
  )
}

export default function Page() {
  return (
    <main>
      <section className="hero">
        <h1>Welcome</h1>
      </section>
      <aside className="rail" />
      <Card title="One" />
    </main>
  )
}
`

describe('moveJsxElement — the reparent form', () => {
  it('moves an element into a different parent, appending inside an empty container', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const aside = locateTag(PAGE, 'aside')

    const result = moveJsxElement({
      file,
      ...first,
      destinationLine: aside.line,
      destinationCol: aside.col,
    })
    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace('      <p className="first">First</p>\n', '').replace(
        '      <aside className="empty"></aside>',
        '      <aside className="empty">\n        <p className="first">First</p>\n      </aside>',
      ),
    )
  })

  it('reopens a SELF-CLOSING destination and re-hangs the subtree at its depth', () => {
    const file = writeFixture(TWO_COMPONENTS)
    const h1 = locateTag(TWO_COMPONENTS, 'h1')
    const aside = locateTag(TWO_COMPONENTS, 'aside')

    const result = moveJsxElement({
      file,
      ...h1,
      destinationLine: aside.line,
      destinationCol: aside.col,
    })
    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      TWO_COMPONENTS.replace('        <h1>Welcome</h1>\n', '').replace(
        '      <aside className="rail" />',
        '      <aside className="rail">\n        <h1>Welcome</h1>\n      </aside>',
      ),
    )
  })

  it('writes the move against an anchor inside the destination when it is given one', () => {
    const file = writeFixture(TWO_COMPONENTS)
    const card = locateTag(TWO_COMPONENTS, 'Card', 1)
    const section = locateTag(TWO_COMPONENTS, 'section')
    const h1 = locateTag(TWO_COMPONENTS, 'h1')

    const result = moveJsxElement({
      file,
      ...card,
      destinationLine: section.line,
      destinationCol: section.col,
      anchorLine: h1.line,
      anchorCol: h1.col,
      position: 'before',
    })
    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      TWO_COMPONENTS.replace('      <Card title="One" />\n', '').replace(
        '        <h1>Welcome</h1>',
        '        <Card title="One" />\n        <h1>Welcome</h1>',
      ),
    )
  })

  it('REFUSES a move whose markup would lose a binding, and NAMES the binding', () => {
    const file = writeFixture(TWO_COMPONENTS)
    const h2 = locateTag(TWO_COMPONENTS, 'h2')
    const main = locateTag(TWO_COMPONENTS, 'main')

    const result = moveJsxElement({
      file,
      ...h2,
      destinationLine: main.line,
      destinationCol: main.col,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.reason).toBe('out-of-scope')
      expect(result.refusal.message).toContain('`title`')
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(TWO_COMPONENTS)
  })

  it('allows a move that stays inside the scope the markup reads from', () => {
    const source = `export default function List({ items }) {
  return (
    <main>
      <ul className="rows">
        {items.map((item) => (
          <li key={item.id}>{item.label}</li>
        ))}
      </ul>
      <section className="tail">
        <p>{items.length} rows</p>
      </section>
    </main>
  )
}
`
    const file = writeFixture(source)
    const p = locateTag(source, 'p')
    const ul = locateTag(source, 'ul')

    // `items` is the component's own prop, in scope in both places.
    const result = moveJsxElement({ file, ...p, destinationLine: ul.line, destinationCol: ul.col })
    expect(result).toEqual({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain('        <p>{items.length} rows</p>\n      </ul>')
    expect(after).toContain('      <section className="tail">\n      </section>')
  })

  it('REFUSES moving an element into its own descendant', () => {
    const file = writeFixture(TWO_COMPONENTS)
    const section = locateTag(TWO_COMPONENTS, 'section')
    const h1 = locateTag(TWO_COMPONENTS, 'h1')

    const result = moveJsxElement({
      file,
      ...section,
      destinationLine: h1.line,
      destinationCol: h1.col,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('into-own-descendant')
    expect(fs.readFileSync(file, 'utf8')).toBe(TWO_COMPONENTS)
  })

  it('REFUSES an anchor that is part of the element being moved', () => {
    const file = writeFixture(TWO_COMPONENTS)
    const section = locateTag(TWO_COMPONENTS, 'section')
    const h1 = locateTag(TWO_COMPONENTS, 'h1')
    const main = locateTag(TWO_COMPONENTS, 'main')

    const result = moveJsxElement({
      file,
      ...section,
      destinationLine: main.line,
      destinationCol: main.col,
      anchorLine: h1.line,
      anchorCol: h1.col,
      position: 'after',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-siblings')
    expect(fs.readFileSync(file, 'utf8')).toBe(TWO_COMPONENTS)
  })

  it('REFUSES a destination the file has no element at', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const result = moveJsxElement({ file, ...first, destinationLine: 1, destinationCol: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-found')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('still refuses a same-parent reorder with no anchor to write against', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const result = moveJsxElement({ file, ...first })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('no-anchor')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })
})
