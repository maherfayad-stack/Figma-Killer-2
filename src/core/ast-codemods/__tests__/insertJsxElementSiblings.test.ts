/**
 * P5-B (IMG-2) — `insertJsxElement`'s `siblings`: a run of new elements
 * written at ONE anchor in ONE splice, the write behind dropping several
 * images at once.
 *
 * Held to the same whole-file bar as `insertJsxElement.test.ts`: the run lands
 * as hand-written siblings would (own line each, the file's own indentation),
 * nothing else moves, every element is reported in order, and a refusal
 * anywhere in the run leaves the file byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxElement } from '../insertJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-insert-siblings-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string): string {
  const filePath = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

const PAGE = `export default function Page() {
  return (
    <section className="gallery">
      {/* keep me */}
      <h1>Photos</h1>

      <p>Footer</p>
    </section>
  )
}
`

const img = (src: string, alt: string) => ({ name: 'img', props: { src, alt } })

describe('insertJsxElement — a run of siblings', () => {
  it('writes three images after one anchor, in order, each on its own line', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      anchorLine: locateTag(PAGE, 'h1').line,
      anchorCol: locateTag(PAGE, 'h1').col,
      position: 'after',
      name: 'img',
      props: { src: '/a.png', alt: 'a' },
      siblings: [img('/b.png', 'b'), img('/c.png', 'c')],
    })

    expect(result.ok).toBe(true)
    expect(read(file)).toBe(`export default function Page() {
  return (
    <section className="gallery">
      {/* keep me */}
      <h1>Photos</h1>
      <img src="/a.png" alt="a" />
      <img src="/b.png" alt="b" />
      <img src="/c.png" alt="c" />

      <p>Footer</p>
    </section>
  )
}
`)
  })

  it('reports every new element, in source order', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      name: 'img',
      props: { src: '/a.png', alt: 'a' },
      siblings: [img('/b.png', 'b'), img('/c.png', 'c')],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = read(file)
    expect(result.created).toEqual([locateTag(after, 'img', 1), locateTag(after, 'img', 2), locateTag(after, 'img', 3)])
  })

  it('fills an empty parent with the whole run', () => {
    const source = `export default function Page() {
  return <div className="box"></div>
}
`
    const file = writeFixture(source)
    const result = insertJsxElement({
      file,
      ...locateTag(source, 'div'),
      name: 'img',
      props: { src: '/a.png', alt: 'a' },
      siblings: [img('/b.png', 'b')],
    })

    expect(result.ok).toBe(true)
    expect(read(file)).toBe(`export default function Page() {
  return <div className="box">
    <img src="/a.png" alt="a" />
    <img src="/b.png" alt="b" />
  </div>
}
`)
    if (!result.ok) return
    expect(result.created).toHaveLength(2)
  })

  it('keeps an inline row on one line', () => {
    const source = `export default function Page() {
  return <div><b>x</b></div>
}
`
    const file = writeFixture(source)
    const result = insertJsxElement({
      file,
      ...locateTag(source, 'div'),
      anchorLine: locateTag(source, 'b').line,
      anchorCol: locateTag(source, 'b').col,
      position: 'after',
      name: 'img',
      props: { src: '/a.png', alt: 'a' },
      siblings: [img('/b.png', 'b')],
    })

    expect(result.ok).toBe(true)
    expect(read(file)).toBe(`export default function Page() {
  return <div><b>x</b> <img src="/a.png" alt="a" /> <img src="/b.png" alt="b" /></div>
}
`)
  })

  it('writes ONE import for a component used by several siblings', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      name: 'Chip',
      importSpecifier: '../design-system',
      props: { label: 'one' },
      siblings: [{ name: 'Chip', importSpecifier: '../design-system', props: { label: 'two' } }],
    })

    expect(result.ok).toBe(true)
    const after = read(file)
    expect(after.match(/import \{ Chip \} from '\.\.\/design-system'/g)).toHaveLength(1)
    expect(after).toContain('<Chip label="one" />\n      <Chip label="two" />')
  })

  it('writes nothing at all when ONE sibling is refused', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'section'),
      name: 'img',
      props: { src: '/a.png', alt: 'a' },
      siblings: [img('/b.png', 'b'), { name: 'script', children: 'boom' }],
    })

    expect(result).toEqual({ ok: false, refusal: expect.objectContaining({ reason: 'unsafe-tag' }) })
    expect(read(file)).toBe(PAGE)
  })
})
