/**
 * `unrollMapExpression` — G-9 / OD-24: "Unroll list". A `.map` over an array
 * literal written in the same file becomes the N elements it renders, byte for
 * byte outside the list.
 *
 * Fixtures are a playlist, a pantry and a pricing table — nothing from the
 * eSIM corpus (`genericRepoShapes.test.ts`'s discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProject, findJsxElementAtLocation, loadSourceFile } from '../locateJsxElement'
import { unrollMapExpression, MAX_UNROLL_ITEMS } from '../unrollMapExpression'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-unroll-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const read = (file: string) => fs.readFileSync(file, 'utf8')

/** 1-based line/col of the first occurrence of `needle` at-or-after `from`, offset by `shift` characters. */
function positionOf(source: string, needle: string, shift = 0, from = 0): { line: number; col: number } {
  const offset = source.indexOf(needle, from) + shift
  const before = source.slice(0, offset)
  return { line: before.split('\n').length, col: offset - before.lastIndexOf('\n') }
}

interface Fixture {
  source: string
  /** The marker the array literal's `[` follows. */
  arrayMarker: string
  /** The marker the row root's `<` precedes (its tag name is one character later). */
  rowMarker: string
  length: number
}

function unroll(fixture: Fixture, overrides: { length?: number; name?: string } = {}) {
  const file = path.join(tmpDir, overrides.name ?? 'Playlist.tsx')
  fs.writeFileSync(file, fixture.source, 'utf8')
  const array = positionOf(fixture.source, '[', 0, fixture.source.indexOf(fixture.arrayMarker))
  const row = positionOf(fixture.source, fixture.rowMarker, 1)
  const result = unrollMapExpression({ file, ...row, array, length: overrides.length ?? fixture.length })
  return { file, result, text: read(file) }
}

const PLAYLIST: Fixture = {
  arrayMarker: 'const TRACKS',
  rowMarker: '<li key=',
  length: 3,
  source: `import { play } from './player'

// The warm-up set.
const TRACKS = [
  { id: 1, title: 'Open Road', artist: 'Lena', seconds: 214 },
  { id: 2, title: "Night Bus", artist: 'Ode', seconds: 187 },
  { id: 3, title: 'Static & Bloom', artist: 'Ode', seconds: 301 },
]

export default function Playlist() {
  return (
    <section>
      <h1>Warm-up</h1>
      <ul className="tracks">
        {TRACKS.map((track, i) => (
          <li key={track.id} data-row={i} title={track.title}>
            <b>{track.title}</b> by {track.artist}
            <span>{track.seconds}s</span>
            <button onClick={() => play(track)}>Play</button>
          </li>
        ))}
      </ul>
      <footer>{TRACKS.length} tracks</footer>
    </section>
  )
}
`,
}

describe('unrollMapExpression — the rows become the elements they rendered', () => {
  it('writes one element per item with the values in place, drops the key, and touches nothing outside the list', () => {
    const { result, text } = unroll(PLAYLIST)
    expect(result.ok).toBe(true)
    expect(text).toBe(`import { play } from './player'

// The warm-up set.
const TRACKS = [
  { id: 1, title: 'Open Road', artist: 'Lena', seconds: 214 },
  { id: 2, title: "Night Bus", artist: 'Ode', seconds: 187 },
  { id: 3, title: 'Static & Bloom', artist: 'Ode', seconds: 301 },
]

export default function Playlist() {
  return (
    <section>
      <h1>Warm-up</h1>
      <ul className="tracks">
        <li data-row={0} title="Open Road">
          <b>Open Road</b> by Lena
          <span>214s</span>
          <button onClick={() => play({ id: 1, title: 'Open Road', artist: 'Lena', seconds: 214 })}>Play</button>
        </li>
        <li data-row={1} title="Night Bus">
          <b>Night Bus</b> by Ode
          <span>187s</span>
          <button onClick={() => play({ id: 2, title: "Night Bus", artist: 'Ode', seconds: 187 })}>Play</button>
        </li>
        <li data-row={2} title={'Static & Bloom'}>
          <b>{'Static & Bloom'}</b> by Ode
          <span>301s</span>
          <button onClick={() => play({ id: 3, title: 'Static & Bloom', artist: 'Ode', seconds: 301 })}>Play</button>
        </li>
      </ul>
      <footer>{TRACKS.length} tracks</footer>
    </section>
  )
}
`)
  })

  it('reports where each written row is, in order, and every position is a real element', () => {
    const { file, result } = unroll(PLAYLIST)
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.created).toHaveLength(3)
    const sourceFile = loadSourceFile(createProject(), file)
    for (const location of result.created) {
      const element = findJsxElementAtLocation(sourceFile, location.line, location.col)
      expect(element?.getTagNameNode().getText()).toBe('li')
    }
    const lines = read(file).split('\n')
    expect(result.created.map((location) => lines[location.line - 1]!.trim().slice(0, 12))).toEqual(['<li data-row', '<li data-row', '<li data-row'])
  })

  it('leaves the array where it is (it may feed other lists, and it is the user’s data)', () => {
    const { text } = unroll(PLAYLIST)
    expect(text).toContain("{ id: 2, title: \"Night Bus\", artist: 'Ode', seconds: 187 },")
    expect(text).toContain('{TRACKS.length} tracks')
  })
})

describe('unrollMapExpression — other callback and receiver shapes', () => {
  it('reads a block callback with a lone return, an inline array of primitives, and writes inline rows end to end', () => {
    const fixture: Fixture = {
      arrayMarker: '<p>',
      rowMarker: '<i>',
      length: 3,
      source: `export const Stars = () => (
  <p>{[1, 2, 3].map((n) => { return <i>{n}</i> })}</p>
)
`,
    }
    const { result, text } = unroll(fixture, { name: 'Stars.tsx' })
    expect(result.ok).toBe(true)
    expect(text).toBe(`export const Stars = () => (
  <p><i>1</i><i>2</i><i>3</i></p>
)
`)
  })

  it('writes a numeric item through a method call and arithmetic without changing what it computes', () => {
    const fixture: Fixture = {
      arrayMarker: 'const PLANS',
      rowMarker: '<tr>',
      length: 2,
      source: `const PLANS = [
  { name: 'Basic', price: 9.5, seats: 1, tags: ['solo', 'tiny'] },
  { name: 'Team', price: 24, seats: -5, tags: ['group'] },
]

export function Pricing() {
  return (
    <table>
      <tbody>
        {PLANS.map((plan) => (
          <tr>
            <td>{plan.price.toFixed(2)}</td>
            <td>{10 - plan.seats}</td>
            <td>{plan.tags.length}:{plan.tags[0]}</td>
            <td>{plan.missing}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
`,
    }
    const { result, text } = unroll(fixture, { name: 'Pricing.tsx' })
    expect(result.ok).toBe(true)
    expect(text).toContain('<td>{(9.5).toFixed(2)}</td>')
    expect(text).toContain('<td>{(24).toFixed(2)}</td>')
    expect(text).toContain('<td>{10 - 1}</td>')
    expect(text).toContain('<td>{10 - (-5)}</td>')
    expect(text).toContain('<td>2:solo</td>')
    expect(text).toContain('<td>1:group</td>')
    // A property the item does not have stays a read of the item's own text, so it is still `undefined`.
    expect(text).toContain("<td>{({ name: 'Basic', price: 9.5, seats: 1, tags: ['solo', 'tiny'] }).missing}</td>")
  })

  it('keeps CRLF line endings', () => {
    const crlf = { ...PLAYLIST, source: PLAYLIST.source.replace(/\n/g, '\r\n') }
    const file = path.join(tmpDir, 'Crlf.tsx')
    fs.writeFileSync(file, crlf.source, 'utf8')
    const array = positionOf(PLAYLIST.source, '[', 0, PLAYLIST.source.indexOf(PLAYLIST.arrayMarker))
    const row = positionOf(PLAYLIST.source, PLAYLIST.rowMarker, 1)
    const result = unrollMapExpression({ file, ...row, array, length: 3 })
    expect(result.ok).toBe(true)
    const text = read(file)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(text.split('\r\n').length).toBeGreaterThan(PLAYLIST.source.split('\n').length)
  })
})

describe('unrollMapExpression — every refusal leaves the file byte-identical', () => {
  const refuses = (fixture: Fixture, reason: string, overrides: { length?: number } = {}) => {
    const { result, text } = unroll(fixture, overrides)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe(reason)
    expect(text).toBe(fixture.source)
  }

  const wrap = (arrayDecl: string, callback: string, parent = '{LIST.map(' + callback + ')}'): Fixture => ({
    arrayMarker: 'const LIST',
    rowMarker: '<li',
    length: 2,
    source: `${arrayDecl}\nexport function View(props) {\n  return (\n    <ul>\n      ${parent}\n    </ul>\n  )\n}\n`,
  })
  const TWO = 'const LIST = [{ id: 1, label: "a" }, { id: 2, label: "b" }]'

  it('an item that is not plain data', () => {
    refuses(wrap('const LIST = [{ id: 1, label: "a" }, { id: 2, label: makeLabel() }]', '(x) => <li>{x.label}</li>'), 'not-literal')
    refuses(wrap('const LIST = [{ id: 1 }, { id: 2, ...rest }]', '(x) => <li>{x.id}</li>'), 'not-literal')
  })

  it('a list handed in as a prop, imported, reassignable or computed', () => {
    const rows = '(x) => <li>{x.label}</li>'
    refuses(
      { ...wrap(TWO, rows), source: `export function View({ LIST }) {\n  return (\n    <ul>\n      {LIST.map(${rows})}\n    </ul>\n  )\n}\n`, arrayMarker: 'LIST }' },
      'not-literal',
    )
    refuses(
      { ...wrap(TWO, rows), source: `import { LIST } from './data'\nexport function View() {\n  return (\n    <ul>\n      {LIST.map(${rows})}\n    </ul>\n  )\n}\n` },
      'not-literal',
    )
    refuses(wrap('let LIST = [{ label: "a" }, { label: "b" }]', rows), 'not-literal')
    refuses(wrap(TWO, rows, '{LIST.filter(Boolean).map(' + rows + ')}'), 'not-literal')
  })

  it('a callback that destructures, holds statements, or shadows its item', () => {
    refuses(wrap(TWO, '({ label }) => <li>{label}</li>'), 'unsupported-params')
    refuses(wrap(TWO, '(x) => { const t = x.label; return <li>{t}</li> }'), 'not-a-list')
    refuses(wrap(TWO, '(x) => <li>{[1].map((x) => x)}</li>'), 'shadowed-param')
  })

  it('a row that changes its item or index', () => {
    refuses(wrap(TWO, '(x, i) => <li onClick={() => { i++ }}>{x.label}</li>'), 'param-assigned')
    refuses(wrap(TWO, '(x) => <li onClick={() => { x.label = "z" }}>{x.label}</li>'), 'param-assigned')
  })

  it('a list that is not a direct child, and one whose braces hold a comment', () => {
    refuses(wrap(TWO, '(x) => <li>{x.label}</li>', '{show && LIST.map((x) => <li>{x.label}</li>)}'), 'not-a-child')
    refuses(wrap(TWO, '(x) => <li>{x.label}</li>', '{/* the rows */ LIST.map((x) => <li>{x.label}</li>)}'), 'unsupported-callback')
  })

  it('an array that is not the one the board read', () => {
    refuses(wrap(TWO, '(x) => <li>{x.label}</li>'), 'list-changed', { length: 3 })
  })

  it('a row that is not the thing the callback returns', () => {
    refuses(
      { ...wrap(TWO, '(x) => <li><em>{x.label}</em></li>'), rowMarker: '<em' },
      'not-a-list',
    )
  })

  it('a list too long to be written out by hand', () => {
    const items = Array.from({ length: MAX_UNROLL_ITEMS + 1 }, (_, i) => String(i)).join(', ')
    refuses({ ...wrap(`const LIST = [${items}]`, '(x) => <li>{x}</li>'), length: MAX_UNROLL_ITEMS + 1 }, 'too-long')
  })

  it('a whole multi-line item handed along', () => {
    const fixture = wrap('const LIST = [\n  {\n    id: 1,\n  },\n]', '(x) => <li onClick={() => pick(x)}>{x.id}</li>')
    refuses({ ...fixture, length: 1 }, 'multi-line-value')
  })

  it('a file that changed under the board', () => {
    const file = path.join(tmpDir, 'Stale.tsx')
    fs.writeFileSync(file, PLAYLIST.source, 'utf8')
    const row = positionOf(PLAYLIST.source, PLAYLIST.rowMarker, 1)
    // The element is no longer there.
    const result = unrollMapExpression({ file, line: row.line + 40, col: row.col, array: { line: 4, col: 16 }, length: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-found')
    expect(read(file)).toBe(PLAYLIST.source)
  })
})
