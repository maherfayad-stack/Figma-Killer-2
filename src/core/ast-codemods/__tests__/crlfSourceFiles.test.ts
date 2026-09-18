/**
 * Every codemod that writes a `.tsx` keeps the file's line ending.
 *
 * Studio edits OTHER PEOPLE'S repositories, and a repo cloned on Windows with
 * Git's default `core.autocrlf=true` has a CRLF working tree. Before
 * `EolPreservingFileSystem` (see `@core/page-parser`'s `eolFileSystem.ts`),
 * every structural codemod emitted `'\n'` for the lines it rewrote or
 * inserted, so a one-attribute edit turned a clean CRLF file into a mixed one
 * and `git diff` showed the user lines they never touched. `STATE.md`
 * `struct-10` landmine 7 named it; this is its gate.
 *
 * THE FIXTURE SHARES NOTHING WITH THE eSIM CORPUS. It is a warehouse
 * inventory screen: named exports, a props interface, `<section>`/`<table>`
 * markup, British copy. `genericRepoShapes.test.ts` explains why that matters
 * — a suite grown from one repo encodes that repo's habits.
 *
 * The bytes are BUILT IN THE TEST, never checked in: this repository's own
 * working tree is CRLF-converted by Git on checkout, so a committed CRLF
 * fixture file cannot be trusted to still be CRLF when the test opens it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  deleteJsxElement,
  duplicateJsxElement,
  extractStringsToDictionary,
  insertJsxElement,
  moveJsxElement,
  setJsxProp,
  setJsxText,
  unwrapJsxElement,
  wrapJsxElements,
} from '../index'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-codemods-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** The fixture as LINES — the twins below differ only in what joins them. */
const STOCK_ROOM_LINES = [
  "import { Shelf } from './Shelf'",
  '',
  'export interface StockRoomProps {',
  '  siteName: string',
  '}',
  '',
  'export function StockRoom({ siteName }: StockRoomProps) {',
  '  return (',
  '    <section className="stock-room">',
  '      <h2 className="stock-room__heading">Stock room</h2>',
  '      <p className="stock-room__site">Depot</p>',
  '      <Shelf label="Aisle one" />',
  '      <Shelf label="Aisle two" />',
  '    </section>',
  '  )',
  '}',
  '',
]

function writeFixture(eol: '\n' | '\r\n'): string {
  const file = path.join(tmpDir, `StockRoom${eol === '\r\n' ? 'Crlf' : 'Lf'}.tsx`)
  fs.writeFileSync(file, STOCK_ROOM_LINES.join(eol), 'utf8')
  return file
}

function readRaw(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/** Every line ending in the file, as the literal bytes — the assertion that matters. */
function endings(text: string): string[] {
  return [...text.matchAll(/\r\n|\r|\n/g)].map((match) => match[0])
}

function expectUniformCrlf(text: string): void {
  expect(new Set(endings(text))).toEqual(new Set(['\r\n']))
}

/**
 * Runs `edit` against both twins and asserts they agree line-for-line, so a
 * CRLF file is never edited DIFFERENTLY — only with different endings.
 */
function expectTwinsAgree(edit: (file: string) => void): { lf: string; crlf: string } {
  const lfFile = writeFixture('\n')
  const crlfFile = writeFixture('\r\n')
  edit(lfFile)
  edit(crlfFile)
  const lf = readRaw(lfFile)
  const crlf = readRaw(crlfFile)
  expect(crlf.replace(/\r\n/g, '\n')).toBe(lf)
  expectUniformCrlf(crlf)
  expect(endings(lf)).toEqual(endings(lf).map(() => '\n'))
  return { lf, crlf }
}

describe('a CRLF .tsx stays CRLF', () => {
  it('setJsxProp — the rewritten line and every untouched line keep \\r\\n', () => {
    const { crlf } = expectTwinsAgree((file) => {
      setJsxProp({ file, line: 11, col: 8, prop: 'className', value: 'stock-room__site is-open' })
    })
    expect(crlf).toContain('<p className="stock-room__site is-open">Depot</p>\r\n')
    // The lines around it were never re-emitted at all.
    expect(crlf).toContain('      <h2 className="stock-room__heading">Stock room</h2>\r\n')
  })

  it('setJsxText — text written into an existing element', () => {
    const { crlf } = expectTwinsAgree((file) => {
      setJsxText({ file, line: 10, col: 8, text: 'Stock room — level two' })
    })
    expect(crlf).toContain('Stock room — level two')
    expectUniformCrlf(crlf)
  })

  it('insertJsxElement — an INSERTED line gets \\r\\n, not \\n', () => {
    const { crlf } = expectTwinsAgree((file) => {
      const result = insertJsxElement({
        file,
        line: 9,
        col: 6,
        anchorLine: 10,
        anchorCol: 8,
        position: 'after',
        name: 'p',
        props: { className: 'stock-room__note' },
        children: 'Counted this morning',
      })
      expect(result.ok).toBe(true)
    })
    expect(crlf).toContain('stock-room__note')
    expectUniformCrlf(crlf)
  })

  it('duplicateJsxElement — a duplicated whole-line element', () => {
    const { crlf } = expectTwinsAgree((file) => {
      const result = duplicateJsxElement({ file, line: 12, col: 8 })
      expect(result.ok).toBe(true)
    })
    expect(crlf.match(/Aisle one/g)).toHaveLength(2)
    expectUniformCrlf(crlf)
  })

  it('moveJsxElement — a verbatim byte splice', () => {
    const { crlf } = expectTwinsAgree((file) => {
      const result = moveJsxElement({ file, line: 13, col: 8, anchorLine: 12, anchorCol: 8, position: 'before' })
      expect(result.ok).toBe(true)
    })
    expect(crlf.indexOf('Aisle two')).toBeLessThan(crlf.indexOf('Aisle one'))
    expectUniformCrlf(crlf)
  })

  it('deleteJsxElement — the surviving lines keep their endings and no blank ragged line appears', () => {
    const { crlf } = expectTwinsAgree((file) => {
      const result = deleteJsxElement({ file, line: 11, col: 8 })
      expect(result.ok).toBe(true)
    })
    expect(crlf).not.toContain('Depot')
    expectUniformCrlf(crlf)
  })

  it('wrapJsxElements then unwrapJsxElement — struct-10 landmine 7, closed', () => {
    const crlfFile = writeFixture('\r\n')
    const before = readRaw(crlfFile)

    const wrapped = wrapJsxElements({
      file: crlfFile,
      targets: [
        { line: 12, col: 8 },
        { line: 13, col: 8 },
      ],
      name: 'div',
    })
    expect(wrapped.ok).toBe(true)
    const afterWrap = readRaw(crlfFile)
    expectUniformCrlf(afterWrap)
    expect(afterWrap).toContain('<div>')

    const wrapLines = afterWrap.split('\r\n')
    const containerIndex = wrapLines.findIndex((line) => line.includes('<div>'))
    const unwrapped = unwrapJsxElement({
      file: crlfFile,
      line: containerIndex + 1,
      col: wrapLines[containerIndex]!.indexOf('<div>') + 2,
    })
    expect(unwrapped.ok).toBe(true)

    // Round-trip: byte-identical to where it started, `\r\n` included.
    expect(readRaw(crlfFile)).toBe(before)
  })
})

describe('what a line ending does NOT change', () => {
  it('leaves a uniformly-LF file byte-identical to how it would have been written before', () => {
    const file = writeFixture('\n')
    setJsxProp({ file, line: 10, col: 8, prop: 'id', value: 'heading' })
    expect(readRaw(file)).not.toContain('\r')
  })

  it('normalises a MIXED file to its dominant ending — a documented repair, not preservation', () => {
    const file = path.join(tmpDir, 'Mixed.tsx')
    // Three CRLF endings, one LF: exactly the shape an earlier `\n`-only
    // codemod left behind.
    fs.writeFileSync(
      file,
      'export function Mixed() {\r\n  return (\r\n    <p className="a">Hi</p>\n  )\r\n}\r\n',
      'utf8',
    )
    setJsxProp({ file, line: 3, col: 6, prop: 'className', value: 'b' })
    const after = readRaw(file)
    expectUniformCrlf(after)
    expect(after).toContain('className="b"')
  })

  it('extractStringsToDictionary preserves the ending it was GIVEN — its contract is text, not a file', () => {
    const lines = [
      'export function Notice() {',
      '  return <p title="Closed on Sunday">Closed on Sunday</p>',
      '}',
      '',
    ]
    const params = {
      fileName: 'Notice.tsx',
      extractions: [{ line: 2, col: 21, text: 'Closed on Sunday', key: 'notice.closed' }],
      importSpecifier: '../i18n/LanguageContext',
      hookName: 'useLanguage',
    }
    const lf = extractStringsToDictionary({ ...params, sourceText: lines.join('\n') })
    const crlf = extractStringsToDictionary({ ...params, sourceText: lines.join('\r\n') })

    expect(crlf.applied).toEqual(lf.applied)
    expect(crlf.applied).toEqual(['notice.closed'])
    expect(crlf.text.replace(/\r\n/g, '\n')).toBe(lf.text)
    expectUniformCrlf(crlf.text)
    expect(lf.text).not.toContain('\r')

    // A refusal returns the caller's own bytes, untouched.
    const refused = extractStringsToDictionary({
      ...params,
      sourceText: lines.join('\r\n'),
      extractions: [{ line: 2, col: 21, text: 'Something else', key: 'notice.closed' }],
    })
    expect(refused.applied).toEqual([])
    expect(refused.text).toBe(lines.join('\r\n'))
  })

  it('still REFUSES a file whose on-disk bytes are not the bytes it parsed — the BOM case', () => {
    const file = path.join(tmpDir, 'Bom.tsx')
    fs.writeFileSync(file, `\uFEFF${STOCK_ROOM_LINES.join('\r\n')}`, 'utf8')
    const before = readRaw(file)

    const result = deleteJsxElement({ file, line: 11, col: 8 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('stale-source')
    // Refused means untouched — including the mark itself.
    expect(readRaw(file)).toBe(before)
  })
})
