/**
 * G-7 - the single-file structure gestures that used to answer with a warning
 * and now write (or, where writing would break the file, still refuse by name).
 *
 * One block per former refusal, whole-file assertions throughout: the bar for a
 * structural codemod is that the file after the write is the file before it with
 * one thing moved, and a refusal leaves it byte-identical.
 *
 * The fixtures are a recipe app's screens and share nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deleteJsxElement } from '../deleteJsxElement'
import { duplicateJsxElement } from '../duplicateJsxElement'
import { insertJsxElement } from '../insertJsxElement'
import { moveJsxElement } from '../moveJsxElement'
import { unwrapJsxElement } from '../unwrapJsxElement'
import { wrapJsxElements } from '../wrapJsxElements'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-tidy-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fixture(source: string): string {
  const file = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

const page = (body: string) => `export default function Page() {\n  return (\n${body}\n  )\n}\n`

describe('moveJsxElement - same-element is a silent no-op', () => {
  const SOURCE = page(`    <ul>
      <li>one</li>
      <li>two</li>
    </ul>`)

  it('writes nothing, succeeds, and says the element is where it was', () => {
    const file = fixture(SOURCE)
    const one = locateTag(SOURCE, 'li', 1)
    const result = moveJsxElement({ file, ...one, anchorLine: one.line, anchorCol: one.col, position: 'after' })
    expect(result).toMatchObject({ ok: true, unchanged: true, relocated: one })
    expect(read(file)).toBe(SOURCE)
  })
})

describe('moveJsxElement - no anchor means an edge of its own parent', () => {
  const SOURCE = page(`    <ul>
      <li>one</li>
      <li>two</li>
      <li>three</li>
    </ul>`)

  it("'after' sends it last, 'before' sends it first", () => {
    const file = fixture(SOURCE)
    const one = locateTag(SOURCE, 'li', 1)
    expect(moveJsxElement({ file, ...one, position: 'after' })).toMatchObject({ ok: true })
    expect(read(file)).toBe(page(`    <ul>
      <li>two</li>
      <li>three</li>
      <li>one</li>
    </ul>`))

    const sourceAfter = read(file)
    const three = locateTag(sourceAfter, 'li', 3)
    // `one` is last now; send the last one to the front.
    expect(moveJsxElement({ file, ...three, position: 'before' })).toMatchObject({ ok: true })
    expect(read(file)).toBe(SOURCE)
  })

  it('an element already at that edge, or alone, has nowhere to go: nothing is written', () => {
    const file = fixture(SOURCE)
    const three = locateTag(SOURCE, 'li', 3)
    const one = locateTag(SOURCE, 'li', 1)
    expect(moveJsxElement({ file, ...three, position: 'after' })).toMatchObject({ ok: true, unchanged: true })
    expect(moveJsxElement({ file, ...one, position: 'before' })).toMatchObject({ ok: true, unchanged: true })
    expect(read(file)).toBe(SOURCE)

    const lone = page('    <ul>\n      <li>only</li>\n    </ul>')
    const loneFile = fixture(lone)
    expect(moveJsxElement({ file: loneFile, ...locateTag(lone, 'li'), position: 'after' })).toMatchObject({ ok: true, unchanged: true })
    expect(read(loneFile)).toBe(lone)
  })
})

describe('moveJsxElement - not-siblings is written beside the anchor, where it renders', () => {
  it('moves out of a nested container to sit beside an element of the outer one, re-hung at its indentation', () => {
    const source = page(`    <section>
      <div>
        <span>inner</span>
      </div>
      <p>outer</p>
    </section>`)
    const file = fixture(source)
    const span = locateTag(source, 'span')
    const p = locateTag(source, 'p')

    const result = moveJsxElement({ file, ...span, anchorLine: p.line, anchorCol: p.col, position: 'after' })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <section>
      <div>
      </div>
      <p>outer</p>
      <span>inner</span>
    </section>`))
    // The write reports where the element is now, so the board can follow it.
    expect(result).toMatchObject({ relocated: locateTag(read(file), 'span') })
  })

  it('lands inside a <Fragment> the canvas flattens, because that is where the anchor is', () => {
    const source = page(`    <main>
      <h1>Menu</h1>
      <>
        <p>starters</p>
        <p>mains</p>
      </>
    </main>`)
    const file = fixture(source)
    const h1 = locateTag(source, 'h1')
    const starters = locateTag(source, 'p', 1)

    expect(moveJsxElement({ file, ...h1, anchorLine: starters.line, anchorCol: starters.col, position: 'after' }).ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <>
        <p>starters</p>
        <h1>Menu</h1>
        <p>mains</p>
      </>
    </main>`))
  })

  it('still refuses what would break the file: a name the new place cannot see, or an anchor inside the moved element', () => {
    const source = page(`    <ul>
      {items.map((item) => (
        <div key={item}>
          <b>{item}</b>
          <i>x</i>
        </div>
      ))}
      <p>after</p>
    </ul>`)
    const file = fixture(source)
    const b = locateTag(source, 'b')
    const p = locateTag(source, 'p')

    const lost = moveJsxElement({ file, ...b, anchorLine: p.line, anchorCol: p.col, position: 'after' })
    expect(lost).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
    if (!lost.ok) expect(lost.refusal.message).toContain('`item`')
    expect(read(file)).toBe(source)

    const nested = page(`    <section>
      <div>
        <b>x</b>
      </div>
    </section>`)
    const nestedFile = fixture(nested)
    const div = locateTag(nested, 'div')
    const inner = locateTag(nested, 'b')
    const inside = moveJsxElement({ file: nestedFile, ...div, anchorLine: inner.line, anchorCol: inner.col, position: 'after' })
    expect(inside).toMatchObject({ ok: false, refusal: { reason: 'into-own-descendant' } })
    expect(read(nestedFile)).toBe(nested)
  })
})

describe('insert and duplicate - an anchor the source nests elsewhere is written beside', () => {
  const SOURCE = page(`    <main>
      <>
        <p>starters</p>
      </>
    </main>`)

  it('an insert whose anchor sits inside a fragment lands beside the anchor, not nowhere', () => {
    const file = fixture(SOURCE)
    const main = locateTag(SOURCE, 'main')
    const starters = locateTag(SOURCE, 'p')
    const result = insertJsxElement({ file, ...main, anchorLine: starters.line, anchorCol: starters.col, position: 'after', name: 'hr' })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <>
        <p>starters</p>
        <hr />
      </>
    </main>`))
  })

  it('a copy dropped into a container, beside an anchor in a fragment, lands in the fragment - and never inside the element being copied', () => {
    const file = fixture(SOURCE)
    const main = locateTag(SOURCE, 'main')
    const starters = locateTag(SOURCE, 'p')
    const h = page(`    <main>
      <h1>Menu</h1>
      <>
        <p>starters</p>
      </>
    </main>`)
    fs.writeFileSync(file, h)
    const h1 = locateTag(h, 'h1')
    const p = locateTag(h, 'p')
    const m = locateTag(h, 'main')
    expect(duplicateJsxElement({ file, ...h1, destinationLine: m.line, destinationCol: m.col, anchorLine: p.line, anchorCol: p.col, position: 'before' }).ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <h1>Menu</h1>
      <>
        <h1>Menu</h1>
        <p>starters</p>
      </>
    </main>`))
    void main
    void starters
  })

  it('a copy whose anchor is INSIDE the element being copied is refused, writing nothing', () => {
    const source = page(`    <main>
      <section>
        <p>inside</p>
      </section>
    </main>`)
    const file = fixture(source)
    const section = locateTag(source, 'section')
    const main = locateTag(source, 'main')
    const inside = locateTag(source, 'p')
    const result = duplicateJsxElement({ file, ...section, destinationLine: main.line, destinationCol: main.col, anchorLine: inside.line, anchorCol: inside.col, position: 'after' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'into-own-descendant' } })
    expect(read(file)).toBe(source)
  })
})

describe('insertJsxElement - a void element asked to hold elements writes them after it', () => {
  const SOURCE = page(`    <figure>
      <figcaption>Pasta</figcaption>
    </figure>`)

  it('writes <img /> bare and its children as the siblings that follow, in one splice', () => {
    const file = fixture(SOURCE)
    const figure = locateTag(SOURCE, 'figure')
    const caption = locateTag(SOURCE, 'figcaption')
    const result = insertJsxElement({
      file,
      ...figure,
      anchorLine: caption.line,
      anchorCol: caption.col,
      position: 'before',
      name: 'img',
      props: { src: '/pasta.png', alt: 'Pasta' },
      children: [{ name: 'span', children: 'Fresh' }],
    })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <figure>
      <img src="/pasta.png" alt="Pasta" />
      <span>Fresh</span>
      <figcaption>Pasta</figcaption>
    </figure>`))
    if (result.ok) expect(result.created).toHaveLength(2)
  })

  it('still refuses TEXT in a void element - a bare text node beside an element is mixed content - and writes nothing', () => {
    const file = fixture(SOURCE)
    const figure = locateTag(SOURCE, 'figure')
    const result = insertJsxElement({ file, ...figure, name: 'img', children: 'nope' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'void-element-children' } })
    expect(read(file)).toBe(SOURCE)
  })
})

describe('deleteJsxElement - deleting what a component returns leaves return null', () => {
  it('a single root, written plain, parenthesised across lines, or as a concise arrow body', () => {
    const plain = 'export default function Page() {\n  return <section>hi</section>\n}\n'
    const plainFile = fixture(plain)
    expect(deleteJsxElement({ file: plainFile, ...locateTag(plain, 'section') }).ok).toBe(true)
    expect(read(plainFile)).toBe('export default function Page() {\n  return null\n}\n')

    const wrapped = page('    <section>\n      <h1>hi</h1>\n    </section>')
    const wrappedFile = fixture(wrapped)
    expect(deleteJsxElement({ file: wrappedFile, ...locateTag(wrapped, 'section') }).ok).toBe(true)
    expect(read(wrappedFile)).toBe('export default function Page() {\n  return null\n}\n')

    const arrow = 'export default () => <div>hi</div>\n'
    const arrowFile = fixture(arrow)
    expect(deleteJsxElement({ file: arrowFile, ...locateTag(arrow, 'div') }).ok).toBe(true)
    expect(read(arrowFile)).toBe('export default () => null\n')
  })

  it('a returned conditional: a ternary branch alone goes (the other state stays), `cond && <X/>` goes whole', () => {
    const ternary = 'export default function Page({ open }: { open: boolean }) {\n  return open ? <Panel /> : <Closed />\n}\n'
    const ternaryFile = fixture(ternary)
    expect(deleteJsxElement({ file: ternaryFile, ...locateTag(ternary, 'Panel') }).ok).toBe(true)
    expect(read(ternaryFile)).toBe('export default function Page({ open }: { open: boolean }) {\n  return open ? null : <Closed />\n}\n')

    const guard = 'export default function Page({ open }: { open: boolean }) {\n  return open && <Panel />\n}\n'
    const guardFile = fixture(guard)
    expect(deleteJsxElement({ file: guardFile, ...locateTag(guard, 'Panel') }).ok).toBe(true)
    expect(read(guardFile)).toBe('export default function Page({ open }: { open: boolean }) {\n  return null\n}\n')
  })

  it('still refuses an element that is the value of something else - null there is a guess', () => {
    const held = 'export default function Page() {\n  const icon = <b>hi</b>\n  return <section>{icon}</section>\n}\n'
    const file = fixture(held)
    const result = deleteJsxElement({ file, ...locateTag(held, 'b') })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'no-jsx-parent' } })
    expect(read(file)).toBe(held)

    const listed = 'export default function Page() {\n  return [<b key="a">hi</b>]\n}\n'
    const listFile = fixture(listed)
    expect(deleteJsxElement({ file: listFile, ...locateTag(listed, 'b') })).toMatchObject({ ok: false, refusal: { reason: 'no-jsx-parent' } })
    expect(read(listFile)).toBe(listed)
  })
})

describe('unwrapJsxElement - a wrapper that carries behaviour is kept, emptied', () => {
  const body = (opening: string, closing = '</div>') => page(`    <main>
      ${opening}
        <h2>Title</h2>
        <p>Body</p>
      ${closing}
    </main>`)

  it.each([
    ['a handler', '<div className="card" onClick={save}>', '<div className="card" onClick={save} />'],
    ['a ref', '<div ref={box}>', '<div ref={box} />'],
    ['a key', '<div key="a">', '<div key="a" />'],
    ['a spread', '<div {...rest}>', '<div {...rest} />'],
  ])('%s: the children go to the parent, the wrapper stays with every attribute untouched', (_name, opening, husk) => {
    const source = body(opening)
    const file = fixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'div') })
    expect(result).toMatchObject({ ok: true, keptWrapper: true })
    expect(read(file)).toBe(page(`    <main>
      ${husk}
      <h2>Title</h2>
      <p>Body</p>
    </main>`))
    // The two children it handed back, and not the wrapper it kept.
    if (result.ok) expect(result.relocated).toHaveLength(2)
  })

  it('a component tag keeps its usage: <Card> becomes <Card /> with its children beside it', () => {
    const source = body('<Card>', '</Card>')
    const file = fixture(source)
    expect(unwrapJsxElement({ file, ...locateTag(source, 'Card') })).toMatchObject({ ok: true, keptWrapper: true })
    expect(read(file)).toBe(page(`    <main>
      <Card />
      <h2>Title</h2>
      <p>Body</p>
    </main>`))
  })

  it('keeps a tag whose attributes are laid out over several lines in that layout', () => {
    const source = page(`    <main>
      <div
        className="card"
        onClick={save}
      >
        <h2>Title</h2>
      </div>
    </main>`)
    const file = fixture(source)
    expect(unwrapJsxElement({ file, ...locateTag(source, 'div') }).ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <div
        className="card"
        onClick={save}
      />
      <h2>Title</h2>
    </main>`))
  })

  it('a wrapper with behaviour and nothing inside just closes itself; one already self-closed is left alone', () => {
    const empty = body('<div onClick={save}>', '</div>').replace(/\n\s*<h2>Title<\/h2>\n\s*<p>Body<\/p>/, '')
    const emptyFile = fixture(empty)
    expect(unwrapJsxElement({ file: emptyFile, ...locateTag(empty, 'div') })).toMatchObject({ ok: true, keptWrapper: true, relocated: [] })
    expect(read(emptyFile)).toContain('<div onClick={save} />')

    const closed = page('    <main>\n      <Card onClick={save} />\n    </main>')
    const closedFile = fixture(closed)
    expect(unwrapJsxElement({ file: closedFile, ...locateTag(closed, 'Card') })).toMatchObject({ ok: true, keptWrapper: true })
    expect(read(closedFile)).toBe(closed)
  })

  it('a wrapper that shares its line hands its inline children back on that line', () => {
    const source = page('    <p><span onClick={save}>x <b>c</b></span> tail</p>')
    const file = fixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'span') })
    expect(result).toMatchObject({ ok: true, keptWrapper: true })
    expect(read(file)).toBe(page('    <p><span onClick={save} />x <b>c</b> tail</p>'))
    if (result.ok) expect(result.relocated).toEqual([locateTag(read(file), 'b')])
  })

  it('a plain container is still dissolved entirely - nothing to keep', () => {
    const source = body('<div className="card">')
    const file = fixture(source)
    const result = unwrapJsxElement({ file, ...locateTag(source, 'div') })
    expect(result.ok).toBe(true)
    expect(result.ok && 'keptWrapper' in result).toBe(false)
    expect(read(file)).toBe(page(`    <main>
      <h2>Title</h2>
      <p>Body</p>
    </main>`))
  })
})

describe('wrapJsxElements - a selection that is not a run is gathered, then grouped', () => {
  it('members with an element between them: the unselected one stays where it was', () => {
    const source = page(`    <main>
      <h1>A</h1>
      <h2>B</h2>
      <h3>C</h3>
    </main>`)
    const file = fixture(source)
    const result = wrapJsxElements({ file, targets: [locateTag(source, 'h1'), locateTag(source, 'h3')], name: 'div' })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <div>
        <h1>A</h1>
        <h3>C</h3>
      </div>
      <h2>B</h2>
    </main>`))
    if (result.ok) expect(result.created).toEqual(locateTag(read(file), 'div'))
  })

  it('members the source nests in different parents are brought into the first one\'s parent', () => {
    const source = page(`    <main>
      <h1>Menu</h1>
      <>
        <p>starters</p>
        <p>mains</p>
      </>
    </main>`)
    const file = fixture(source)
    const result = wrapJsxElements({ file, targets: [locateTag(source, 'h1'), locateTag(source, 'p', 2)], name: 'div' })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <div>
        <h1>Menu</h1>
        <p>mains</p>
      </div>
      <>
        <p>starters</p>
      </>
    </main>`))
  })

  it('code between the members (a condition, a list) is not swallowed - it stays outside', () => {
    const source = page(`    <ul>
      <li>one</li>
      {open && <li>maybe</li>}
      <li>three</li>
    </ul>`)
    const file = fixture(source)
    const result = wrapJsxElements({ file, targets: [locateTag(source, 'li', 1), locateTag(source, 'li', 3)], name: 'div' })
    // A <div> is not legal inside a <ul>: the HTML content model, not the gap, is what refuses.
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'content-model' } })
    expect(read(file)).toBe(source)

    const divs = page(`    <main>
      <h1>one</h1>
      {open && <h2>maybe</h2>}
      <h3>three</h3>
    </main>`)
    const divFile = fixture(divs)
    expect(wrapJsxElements({ file: divFile, targets: [locateTag(divs, 'h1'), locateTag(divs, 'h3')], name: 'div' }).ok).toBe(true)
    expect(read(divFile)).toBe(page(`    <main>
      <div>
        <h1>one</h1>
        <h3>three</h3>
      </div>
      {open && <h2>maybe</h2>}
    </main>`))
  })

  it('inline neighbours on one line: both members move, the one between them keeps its own line', () => {
    const source = page('    <p><b>a</b> <i>b</i> <u>c</u></p>')
    const file = fixture(source)
    const result = wrapJsxElements({ file, targets: [locateTag(source, 'b'), locateTag(source, 'u')], name: 'span' })
    expect(result.ok).toBe(true)
    const after = read(file)
    expect(after).toContain('<span>')
    // Every byte of every member survives, and the unselected one is still there once.
    expect(after.match(/<b>a<\/b>/g)).toHaveLength(1)
    expect(after.match(/<u>c<\/u>/g)).toHaveLength(1)
    expect(after.match(/<i>b<\/i>/g)).toHaveLength(1)
    expect(after.indexOf('<b>a</b>')).toBeLessThan(after.indexOf('<u>c</u>'))
  })

  it('an element nested inside another selected one travels with it - it is one member, not two', () => {
    const source = page(`    <main>
      <section>
        <p>deep</p>
      </section>
      <h2>B</h2>
      <h3>C</h3>
    </main>`)
    const file = fixture(source)
    const result = wrapJsxElements({
      file,
      targets: [locateTag(source, 'section'), locateTag(source, 'p'), locateTag(source, 'h3')],
      name: 'div',
    })
    expect(result.ok).toBe(true)
    expect(read(file)).toBe(page(`    <main>
      <div>
        <section>
          <p>deep</p>
        </section>
        <h3>C</h3>
      </div>
      <h2>B</h2>
    </main>`))
  })

  it('still refuses a member that reads a name the container cannot see, writing nothing', () => {
    const source = page(`    <main>
      <h1>A</h1>
      {items.map((item) => (
        <section key={item}>
          <b>{item}</b>
        </section>
      ))}
    </main>`)
    const file = fixture(source)
    const result = wrapJsxElements({ file, targets: [locateTag(source, 'h1'), locateTag(source, 'b')], name: 'div' })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
    expect(read(file)).toBe(source)
  })
})
