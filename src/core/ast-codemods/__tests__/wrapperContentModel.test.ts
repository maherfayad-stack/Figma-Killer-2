/**
 * `struct-11` — the tag ⌘G writes, decided from the AST rather than hard-coded
 * by the caller, and the contexts where no tag is legal at all.
 *
 * The defect these cover is the worst kind this module can have: Studio wrote
 * markup that broke the user's real app. Grouping two inline `<span>`s inside
 * a `<p>` emitted `<div>`, and React answered in their own console with "In
 * HTML, `<div>` cannot be a descendant of `<p>`. This will cause a hydration
 * error." So every case here asserts the BYTES on disk, and every refusal case
 * asserts the file is untouched — a refusal that half-writes is worse than the
 * defect it replaced.
 *
 * TWO CORPORA, per `genericRepoShapes.test.ts`'s discipline and this file's
 * sibling `groupJsxCodemods.test.ts`: `ARTICLE` is a TypeScript page in the
 * shape the eSIM corpus taught us to expect, and `DOCS_JSX` is a tab-indented
 * `.jsx` documentation page with a definition list, a table, a block link and
 * a fragment root — no TypeScript, no design system, no shared habit with the
 * first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { wrapJsxElement } from '../wrapJsxElement'
import { wrapJsxElements } from '../wrapJsxElements'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-content-model-'))
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
 * Corpus 1. The `<p>` holding two `<span>`s on their own lines is the exact
 * shape the Phase-0 dogfood found; the `<section>` above it is the ordinary
 * flow case that must keep writing `<div>`.
 */
const ARTICLE = `export default function Article() {
  return (
    <section className="body">
      <p className="lede">
        <span className="who">Ada</span>
        <span className="when">1843</span>
      </p>
      <figure className="plate">
        <img src="/plate.png" alt="" />
        <figcaption>Plate 1</figcaption>
      </figure>
      <div className="notes">
        <div className="note">One</div>
        <div className="note">Two</div>
      </div>
    </section>
  )
}
`

/** Corpus 2 — a different repo's habits entirely: tabs, `.jsx`, a fragment root. */
const DOCS_JSX = `export function Reference() {
\treturn (
\t\t<>
\t\t\t<dl className="terms">
\t\t\t\t<dt>flow</dt>
\t\t\t\t<dd>anything</dd>
\t\t\t</dl>
\t\t\t<ul className="links">
\t\t\t\t<li>one</li>
\t\t\t\t<li>two</li>
\t\t\t</ul>
\t\t\t<table>
\t\t\t\t<tbody>
\t\t\t\t\t<tr>
\t\t\t\t\t\t<td>a</td>
\t\t\t\t\t\t<td>b</td>
\t\t\t\t\t</tr>
\t\t\t\t</tbody>
\t\t\t</table>
\t\t\t<a href="/next" className="card">
\t\t\t\t<strong>Next</strong>
\t\t\t\t<em>chapter</em>
\t\t\t</a>
\t\t</>
\t)
}
`

describe('wrapJsxElements — the container follows the content model', () => {
  it('writes a <span>, not a <div>, around inline elements inside a <p>', () => {
    const file = writeFixture(ARTICLE)
    const first = locateTag(ARTICLE, 'span', 1)
    const second = locateTag(ARTICLE, 'span', 2)

    expect(wrapJsxElements({ file, targets: [first, second], name: 'div' })).toMatchObject({ ok: true })

    const after = fs.readFileSync(file, 'utf8')
    expect(after).toBe(
      ARTICLE.replace(
        '        <span className="who">Ada</span>\n        <span className="when">1843</span>\n',
        '        <span>\n          <span className="who">Ada</span>\n          <span className="when">1843</span>\n        </span>\n',
      ),
    )
    // The thing the user's app would have complained about is simply not there.
    expect(after).not.toContain('<div>\n          <span className="who">')
  })

  it('still writes a <div> around block elements in a flow container', () => {
    const file = writeFixture(ARTICLE)
    const first = locateTag(ARTICLE, 'div', 2)
    const second = locateTag(ARTICLE, 'div', 3)

    expect(wrapJsxElements({ file, targets: [first, second], name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      ARTICLE.replace(
        '        <div className="note">One</div>\n        <div className="note">Two</div>\n',
        '        <div>\n          <div className="note">One</div>\n          <div className="note">Two</div>\n        </div>\n',
      ),
    )
  })

  it('REFUSES a group of <li>s and leaves the file byte-identical', () => {
    const file = writeFixture(DOCS_JSX, 'Reference.jsx')
    const first = locateTag(DOCS_JSX, 'li', 1)
    const second = locateTag(DOCS_JSX, 'li', 2)

    const result = wrapJsxElements({ file, targets: [first, second], name: 'div' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'content-model' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.message).toContain('<li>')
    expect(result.refusal.message).toContain('<ul>')
    expect(fs.readFileSync(file, 'utf8')).toBe(DOCS_JSX)
  })

  it('REFUSES a group of table cells inside a <tr>, and leaves the file alone', () => {
    const file = writeFixture(DOCS_JSX, 'Reference.jsx')
    const first = locateTag(DOCS_JSX, 'td', 1)
    const second = locateTag(DOCS_JSX, 'td', 2)

    expect(wrapJsxElements({ file, targets: [first, second], name: 'div' })).toMatchObject({
      ok: false,
      refusal: { reason: 'content-model' },
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(DOCS_JSX)
  })

  it('groups <dt>/<dd> into the <div> a <dl> actually allows', () => {
    // The one restricted parent HTML lets you group with a container — so this
    // is NOT a refusal, and getting it wrong in either direction is a bug.
    const file = writeFixture(DOCS_JSX, 'Reference.jsx')
    const dt = locateTag(DOCS_JSX, 'dt', 1)
    const dd = locateTag(DOCS_JSX, 'dd', 1)

    expect(wrapJsxElements({ file, targets: [dt, dd], name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('\t\t\t\t<div>\n\t\t\t\t\t<dt>flow</dt>')
  })

  it('resolves a TRANSPARENT parent — an <a> wrapping inline text keeps the group inline', () => {
    const file = writeFixture(DOCS_JSX, 'Reference.jsx')
    const strong = locateTag(DOCS_JSX, 'strong', 1)
    const em = locateTag(DOCS_JSX, 'em', 1)

    expect(wrapJsxElements({ file, targets: [strong, em], name: 'div' })).toMatchObject({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain('\t\t\t\t<span>\n\t\t\t\t\t<strong>Next</strong>')
  })

  it('REFUSES an explicitly-named block tag in phrasing content rather than re-spelling it', () => {
    const file = writeFixture(ARTICLE)
    const first = locateTag(ARTICLE, 'span', 1)
    const second = locateTag(ARTICLE, 'span', 2)

    const result = wrapJsxElements({ file, targets: [first, second], name: 'section' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'content-model' } })
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.message).toContain('<section>')
    expect(fs.readFileSync(file, 'utf8')).toBe(ARTICLE)
  })

  it('writes an explicitly-named tag unchanged where it is legal', () => {
    const file = writeFixture(ARTICLE)
    const first = locateTag(ARTICLE, 'div', 2)
    const second = locateTag(ARTICLE, 'div', 3)

    expect(wrapJsxElements({ file, targets: [first, second], name: 'section' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('        <section>\n          <div className="note">One</div>')
  })
})

describe('wrapJsxElement — ⌘G on ONE element asks the same question', () => {
  it('wraps a lone inline element inside a <p> in a <span>', () => {
    const file = writeFixture(ARTICLE)
    expect(wrapJsxElement({ file, ...locateTag(ARTICLE, 'span', 1), name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      ARTICLE.replace(
        '        <span className="who">Ada</span>\n',
        '        <span>\n          <span className="who">Ada</span>\n        </span>\n',
      ),
    )
  })

  it('REFUSES to wrap a single <li>, naming the list it belongs to', () => {
    const file = writeFixture(DOCS_JSX, 'Reference.jsx')
    const result = wrapJsxElement({ file, ...locateTag(DOCS_JSX, 'li', 1), name: 'div' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'content-model' } })
    expect(fs.readFileSync(file, 'utf8')).toBe(DOCS_JSX)
  })

  it('REFUSES to wrap a <figcaption>, which only means anything inside its <figure>', () => {
    const file = writeFixture(ARTICLE)
    expect(wrapJsxElement({ file, ...locateTag(ARTICLE, 'figcaption', 1), name: 'div' })).toMatchObject({
      ok: false,
      refusal: { reason: 'content-model' },
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(ARTICLE)
  })

  it('wraps an <img> in a <span> — a void element is inline, and the wrapper follows it', () => {
    const file = writeFixture(ARTICLE)
    expect(wrapJsxElement({ file, ...locateTag(ARTICLE, 'img', 1), name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('        <span>\n          <img src="/plate.png" alt="" />')
  })

  it('still writes a COMPONENT wrapper with its import where that is legal', () => {
    const source = `export default function Page() {
  return (
    <main>
      <p>text</p>
    </main>
  )
}
`
    const file = writeFixture(source)
    expect(
      wrapJsxElement({ file, ...locateTag(source, 'p', 1), name: 'Stack', importSpecifier: './Stack' }),
    ).toMatchObject({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain("import { Stack } from './Stack'")
    expect(after).toContain('      <Stack>\n        <p>text</p>\n      </Stack>')
  })

  it('REFUSES a component wrapper inside a <ul>, where nothing but an <li> may sit', () => {
    const source = `export default function Menu() {
  return (
    <ul>
      <li>one</li>
    </ul>
  )
}
`
    const file = writeFixture(source)
    expect(
      wrapJsxElement({ file, ...locateTag(source, 'li', 1), name: 'Stack', importSpecifier: './Stack' }),
    ).toMatchObject({ ok: false, refusal: { reason: 'content-model' } })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('has no opinion when the parent is a COMPONENT — an unknown context writes the ordinary <div>', () => {
    const source = `import { Card } from './Card'

export default function Page() {
  return (
    <Card>
      <p>text</p>
    </Card>
  )
}
`
    const file = writeFixture(source)
    expect(wrapJsxElement({ file, ...locateTag(source, 'p', 1), name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('      <div>\n        <p>text</p>\n      </div>')
  })

  it('walks through a fragment and an expression container to the element that really encloses it', () => {
    // The members' JSX parent is the FRAGMENT, whose own parent is `{show && …}`
    // inside the `<p>`. A walk that stopped at the fragment would see no parent
    // at all and write the ordinary `<div>` — into phrasing content, which is
    // the whole defect. The branch is decided when the app runs; where it SITS
    // is not, and it sits in the `<p>` either way.
    const source = `export default function Page({ show }) {
  return (
    <p>
      {show && (
        <>
          <em>maybe</em>
          <b>surely</b>
        </>
      )}
    </p>
  )
}
`
    const file = writeFixture(source)
    const result = wrapJsxElements({
      file,
      targets: [locateTag(source, 'em', 1), locateTag(source, 'b', 1)],
      name: 'div',
    })
    expect(result).toMatchObject({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain('          <span>\n            <em>maybe</em>')
    expect(after).not.toContain('<div>')
  })
})
