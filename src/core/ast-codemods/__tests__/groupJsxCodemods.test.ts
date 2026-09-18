/**
 * `wrapJsxElements` / `unwrapJsxElement` — K3's two writes, held to the bar
 * `structuralJsxCodemods.test.ts` and `copyJsxCodemods.test.ts` set: assert the
 * WHOLE file, byte for byte, against the original with one thing grouped or
 * dissolved. A reformatted sibling, an eaten blank line or a reindented comment
 * is a defect, and only a whole-file assertion catches it.
 *
 * The refusals carry at least as much weight. Group is the FIRST structural
 * write in this module that spans several elements, so "one honest target"
 * becomes a question about the gap between them: anything unnamed inside the
 * span means the wrapper would land around something the user never selected,
 * and that must refuse by name with the file untouched. Ungroup DELETES an
 * element from the user's repository, so every wrapper that is doing more than
 * holding its children refuses the same way.
 *
 * TWO CORPORA ON PURPOSE (the `genericRepoShapes.test.ts` discipline): the
 * eSIM-ish `PAGE` fixture below, and `PLAIN_JS` — a tab-indented `.jsx` file
 * with a fragment root, no TypeScript, and no design system anywhere near it.
 * A suite grown from one repo encodes that repo's habits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { wrapJsxElements } from '../wrapJsxElements'
import { unwrapJsxElement } from '../unwrapJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-group-'))
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
 * Formatting is load-bearing: the comment, the blank line between the two
 * paragraphs, `<Third>`'s multi-line attribute list and the inline pair inside
 * `<footer>` all exist so the byte-exact assertions have something to protect.
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
        tone="quiet"
      />
      <aside className="last">Last</aside>
      <footer><a href="/a">A</a><a href="/b">B</a></footer>
    </section>
  )
}
`

describe('wrapJsxElements', () => {
  it('wraps a contiguous run of siblings in ONE container, re-hanging only their own indentation', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const second = locateTag(PAGE, 'p', 2)

    expect(wrapJsxElements({ file, targets: [first, second], name: 'div' })).toMatchObject({ ok: true })

    // The blank line between the two paragraphs is INSIDE the span, so it
    // travels verbatim; the comment above them does not move at all.
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '      <p className="first">First</p>\n\n      <p className="second">Second</p>\n',
        '      <div>\n        <p className="first">First</p>\n\n        <p className="second">Second</p>\n      </div>\n',
      ),
    )
  })

  it('carries a multi-line element and the text between siblings into the group verbatim', () => {
    const source = `export default function Row() {
  return (
    <div className="row">
      <b>Bold</b>
      and
      <i>Italic</i>
    </div>
  )
}
`
    const file = writeFixture(source)
    expect(
      wrapJsxElements({ file, targets: [locateTag(source, 'b'), locateTag(source, 'i')], name: 'span' }),
    ).toMatchObject({ ok: true })

    // `and` is an ordinary text child sitting between the two elements. It is
    // inside the span, so it is grouped with them — leaving it outside would
    // reorder it, which is not what the user asked for.
    expect(fs.readFileSync(file, 'utf8')).toBe(
      source.replace(
        '      <b>Bold</b>\n      and\n      <i>Italic</i>\n',
        '      <span>\n        <b>Bold</b>\n        and\n        <i>Italic</i>\n      </span>\n',
      ),
    )
  })

  it('groups an INLINE run in place, without breaking the line the user kept', () => {
    const file = writeFixture(PAGE)
    const a = locateTag(PAGE, 'a', 1)
    const b = locateTag(PAGE, 'a', 2)

    expect(wrapJsxElements({ file, targets: [a, b], name: 'span' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '<footer><a href="/a">A</a><a href="/b">B</a></footer>',
        '<footer><span><a href="/a">A</a><a href="/b">B</a></span></footer>',
      ),
    )
  })

  it('accepts the targets in any order and ignores the same element named twice', () => {
    const file = writeFixture(PAGE)
    const second = locateTag(PAGE, 'p', 2)
    const third = locateTag(PAGE, 'Third')

    expect(wrapJsxElements({ file, targets: [third, second, third], name: 'div' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      PAGE.replace(
        '      <p className="second">Second</p>\n      <Third\n        label="third"\n        tone="quiet"\n      />\n',
        '      <div>\n        <p className="second">Second</p>\n        <Third\n          label="third"\n          tone="quiet"\n        />\n      </div>\n',
      ),
    )
  })

  it('writes the import when the wrapper is a component, and REFUSES a name the file already binds', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const second = locateTag(PAGE, 'p', 2)

    const conflict = wrapJsxElements({ file, targets: [first, second], name: 'Third', importSpecifier: '@acme/ui' })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.refusal.reason).toBe('binding-conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)

    expect(
      wrapJsxElements({ file, targets: [first, second], name: 'Stack', importSpecifier: '@acme/ui' }),
    ).toMatchObject({ ok: true })
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain("import { Stack } from '@acme/ui'\n")
    expect(after).toContain('      <Stack>\n        <p className="first">First</p>\n')
  })

  it('REFUSES a run with an unselected element in the middle, leaving the file untouched', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const third = locateTag(PAGE, 'Third')

    const result = wrapJsxElements({ file, targets: [first, third], name: 'div' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.reason).toBe('not-contiguous')
      expect(result.refusal.message).toContain('Select siblings next to each other')
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES elements that are not siblings in the code', () => {
    const file = writeFixture(PAGE)
    const result = wrapJsxElements({
      file,
      targets: [locateTag(PAGE, 'p', 1), locateTag(PAGE, 'a', 1)],
      name: 'div',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-siblings')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES a run whose members disagree about owning their line', () => {
    const source = `export default () => (
  <div>
    <a href="/a">A</a>
    <b>B</b><i>I</i>
  </div>
)
`
    const file = writeFixture(source)
    const result = wrapJsxElements({
      file,
      targets: [locateTag(source, 'a'), locateTag(source, 'b')],
      name: 'span',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('mixed-indentation')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('REFUSES a run with an expression container between its members', () => {
    const source = `export default function List({ rows, showBadge }) {
  return (
    <ul className="list">
      <li>Head</li>
      {showBadge && <li className="badge">New</li>}
      <li>Tail</li>
    </ul>
  )
}
`
    const file = writeFixture(source)
    const result = wrapJsxElements({
      file,
      targets: [locateTag(source, 'li', 1), locateTag(source, 'li', 3)],
      name: 'div',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('expression-child')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('REFUSES a wrapper tag Studio will not write, and a run of none', () => {
    const file = writeFixture(PAGE)
    const first = locateTag(PAGE, 'p', 1)
    const second = locateTag(PAGE, 'p', 2)

    const unsafe = wrapJsxElements({ file, targets: [first, second], name: 'script' })
    expect(unsafe.ok).toBe(false)
    if (!unsafe.ok) expect(unsafe.refusal.reason).toBe('unsafe-tag')

    const none = wrapJsxElements({ file, targets: [], name: 'div' })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.refusal.reason).toBe('no-targets')

    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('REFUSES grouping the element a component returns', () => {
    const file = writeFixture(PAGE)
    const result = wrapJsxElements({ file, targets: [locateTag(PAGE, 'section')], name: 'div' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('no-jsx-parent')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })
})

describe('unwrapJsxElement', () => {
  const WRAPPED = `export default function Page() {
  return (
    <section className="list">
      {/* above the group */}
      <div className="group">
        <p className="first">First</p>

        {/* inside the group */}
        <p className="second">Second</p>
      </div>
      <footer>done</footer>
    </section>
  )
}
`

  it('hoists the children into the parent at the wrapper index, dedented one level', () => {
    const file = writeFixture(WRAPPED)
    expect(unwrapJsxElement({ file, ...locateTag(WRAPPED, 'div') })).toMatchObject({ ok: true })

    expect(fs.readFileSync(file, 'utf8')).toBe(
      WRAPPED.replace(
        '      <div className="group">\n        <p className="first">First</p>\n\n        {/* inside the group */}\n        <p className="second">Second</p>\n      </div>\n',
        '      <p className="first">First</p>\n\n      {/* inside the group */}\n      <p className="second">Second</p>\n',
      ),
    )
  })

  it('unwraps an INLINE container in place', () => {
    const source = 'export default () => <p>Hello <span className="x"><b>you</b></span> there</p>\n'
    const file = writeFixture(source)

    expect(unwrapJsxElement({ file, ...locateTag(source, 'span') })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'export default () => <p>Hello <b>you</b> there</p>\n',
    )
  })

  it('removes an empty container, taking its line with it', () => {
    const source = `export default () => (
  <section>
    <div className="spacer" />
    <p>After</p>
  </section>
)
`
    const file = writeFixture(source)
    expect(unwrapJsxElement({ file, ...locateTag(source, 'div') })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('    <div className="spacer" />\n', ''))
  })

  it('keeps `style`, `id` and `data-*` wrappers unwrappable — they hold nothing but their children', () => {
    const source = `export default () => (
  <section>
    <div id="hero" data-testid="hero" style={{ display: 'flex' }}>
      <p>Only child</p>
    </div>
  </section>
)
`
    const file = writeFixture(source)
    expect(unwrapJsxElement({ file, ...locateTag(source, 'div') })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      source.replace(
        "    <div id=\"hero\" data-testid=\"hero\" style={{ display: 'flex' }}>\n      <p>Only child</p>\n    </div>\n",
        '    <p>Only child</p>\n',
      ),
    )
  })

  it('REFUSES a wrapper with behaviour — a handler, a ref, a key, a spread — and names it', () => {
    const cases: Array<[string, string]> = [
      ['onClick={open}', 'onClick'],
      ['ref={boxRef}', 'ref'],
      ['key={row.id}', 'key'],
      ['{...rest}', 'spread'],
    ]
    for (const [attribute] of cases) {
      const source = `export default () => (
  <section>
    <div ${attribute}>
      <p>Child</p>
    </div>
  </section>
)
`
      const file = writeFixture(source, `Case${attribute.replace(/\W/g, '')}.tsx`)
      const result = unwrapJsxElement({ file, ...locateTag(source, 'div') })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('has-behaviour')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    }
  })

  it('REFUSES a COMPONENT tag — removing it deletes a usage, it does not ungroup', () => {
    const source = `import { Card } from './Card'

export default () => (
  <section>
    <Card>
      <p>Child</p>
    </Card>
  </section>
)
`
    const file = writeFixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'Card') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('has-behaviour')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('REFUSES the element a component returns, and a location nothing is written at', () => {
    const file = writeFixture(WRAPPED)
    const root = unwrapJsxElement({ file, ...locateTag(WRAPPED, 'section') })
    expect(root.ok).toBe(false)
    if (!root.ok) expect(root.refusal.reason).toBe('no-jsx-parent')

    const gone = unwrapJsxElement({ file, line: 9_000, col: 1 })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.refusal.reason).toBe('not-found')

    expect(fs.readFileSync(file, 'utf8')).toBe(WRAPPED)
  })
})

/**
 * A repository that shares NOTHING with the eSIM corpus: plain `.jsx`, tabs,
 * a fragment root, lower-case helper components, and no design system. Every
 * generality bug this module has shipped came from a suite grown on one repo.
 */
const PLAIN_JS = `export function Panel({ items }) {
\treturn (
\t\t<>
\t\t\t<h2>Title</h2>
\t\t\t<ul>
\t\t\t\t<li>one</li>
\t\t\t</ul>
\t\t\t<button type="button">Go</button>
\t\t</>
\t)
}
`

describe('generic repo shapes — tabs, a fragment parent, plain JSX', () => {
  it('groups a run inside a FRAGMENT and keeps the file tab-indented', () => {
    const file = writeFixture(PLAIN_JS, 'Panel.jsx')
    expect(
      wrapJsxElements({
        file,
        targets: [locateTag(PLAIN_JS, 'ul'), locateTag(PLAIN_JS, 'button')],
        name: 'div',
      }),
    ).toMatchObject({ ok: true })

    const after = fs.readFileSync(file, 'utf8')
    expect(after).toBe(
      PLAIN_JS.replace(
        '\t\t\t<ul>\n\t\t\t\t<li>one</li>\n\t\t\t</ul>\n\t\t\t<button type="button">Go</button>\n',
        '\t\t\t<div>\n\t\t\t\t<ul>\n\t\t\t\t\t<li>one</li>\n\t\t\t\t</ul>\n\t\t\t\t<button type="button">Go</button>\n\t\t\t</div>\n',
      ),
    )
    expect(after).not.toContain('    ') // never mixes spaces into a tab-indented file
  })

  it('ungroups back to exactly the file it started from', () => {
    const file = writeFixture(PLAIN_JS, 'Panel.jsx')
    expect(
      wrapJsxElements({
        file,
        targets: [locateTag(PLAIN_JS, 'ul'), locateTag(PLAIN_JS, 'button')],
        name: 'div',
      }),
    ).toMatchObject({ ok: true })

    const grouped = fs.readFileSync(file, 'utf8')
    expect(unwrapJsxElement({ file, ...locateTag(grouped, 'div') })).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(PLAIN_JS)
  })
})
