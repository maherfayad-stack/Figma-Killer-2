/**
 * `setStringLiteral` — the writeback that makes RESOLVED copy editable.
 *
 * An imported app keeps most of its user-visible strings in a dictionary, read
 * through a hook: `<span>{c.hotelsTag}</span>` renders
 * `hotelsTag: 'Exclusive rates on hotels'` from `translations.js`. The JSX is not
 * a writeback target — putting a string there deletes the i18n binding — so the
 * edit has to land on the literal itself, addressed by the (line, col) the parser
 * recorded as `ParsedNode.textOrigin`.
 *
 * The tests below are mostly about NOT writing: a mis-aimed literal write
 * corrupts a file the editor never showed the user.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setStringLiteral, StringLiteralTargetError } from '../setStringLiteral'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-literal-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/** 1-based line/col of `needle`'s first character — what `textOrigin` records. */
function locate(source: string, needle: string): { line: number; col: number } {
  const index = source.indexOf(needle)
  if (index < 0) throw new Error(`fixture does not contain ${needle}`)
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const col = index - (before.lastIndexOf('\n') + 1) + 1
  return { line, col }
}

const DICTIONARY = [
  'export const translations = {',
  '  en: {',
  '    bookingConfirmation: {',
  "      hotelsTag: 'Exclusive rates on hotels',",
  "      hotelsTitle: 'Enjoy 12% discount on hotels',",
  '    },',
  '  },',
  '  ar: {',
  '    bookingConfirmation: {',
  "      hotelsTag: 'عروض حصرية',",
  '    },',
  '  },',
  '}',
  '',
].join('\n')

describe('setStringLiteral', () => {
  it('rewrites the targeted dictionary entry and nothing else', () => {
    const file = writeFixture('translations.js', DICTIONARY)
    const { line, col } = locate(DICTIONARY, "'Exclusive rates on hotels'")

    setStringLiteral({ file, line, col, value: 'Members-only hotel rates' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("hotelsTag: 'Members-only hotel rates'")
    // The sibling key and the other locale's identically-named key are untouched.
    expect(written).toContain("hotelsTitle: 'Enjoy 12% discount on hotels'")
    expect(written).toContain("hotelsTag: 'عروض حصرية'")
  })

  it('keeps the quote style already in the file', () => {
    const file = writeFixture('translations.js', DICTIONARY)
    const { line, col } = locate(DICTIONARY, "'Exclusive rates on hotels'")

    setStringLiteral({ file, line, col, value: 'Still single quoted' })

    // A copy edit that flipped every touched line to double quotes would show up
    // as noise in the user's diff.
    expect(fs.readFileSync(file, 'utf8')).toContain("'Still single quoted'")
  })

  it('escapes a value containing the quote character', () => {
    const file = writeFixture('translations.js', DICTIONARY)
    const { line, col } = locate(DICTIONARY, "'Exclusive rates on hotels'")

    setStringLiteral({ file, line, col, value: "Ramy's pick" })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("'Ramy\\'s pick'")
    // Still parses: re-reading the same position finds a literal again.
    expect(() => setStringLiteral({ file, line, col, value: 'ok' })).not.toThrow()
  })

  it('handles newlines and unicode without breaking the file', () => {
    const file = writeFixture('translations.js', DICTIONARY)
    const { line, col } = locate(DICTIONARY, "'Exclusive rates on hotels'")

    setStringLiteral({ file, line, col, value: 'line one\nline two — عربي' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('line one\\nline two — عربي')
    expect(written.split('\n').length).toBe(DICTIONARY.split('\n').length)
  })

  it('rewrites a double-quoted literal as double-quoted', () => {
    const source = 'export const LABEL = "Old label"\n'
    const file = writeFixture('labels.ts', source)
    const { line, col } = locate(source, '"Old label"')

    setStringLiteral({ file, line, col, value: 'New label' })

    expect(fs.readFileSync(file, 'utf8')).toContain('"New label"')
  })

  it('rewrites a plain template literal', () => {
    const source = 'export const LABEL = `Old label`\n'
    const file = writeFixture('labels.ts', source)
    const { line, col } = locate(source, '`Old label`')

    setStringLiteral({ file, line, col, value: 'New label' })

    expect(fs.readFileSync(file, 'utf8')).toContain('New label')
  })

  it('refuses a position that is not a string literal', () => {
    const source = 'export const COUNT = 42\n'
    const file = writeFixture('count.ts', source)
    const { line, col } = locate(source, '42')

    expect(() => setStringLiteral({ file, line, col, value: 'nope' })).toThrow(StringLiteralTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses an identifier at the position', () => {
    const source = "const other = 'x'\nexport const LABEL = other\n"
    const file = writeFixture('alias.ts', source)
    const { line, col } = locate(source, 'other\n')

    expect(() => setStringLiteral({ file, line, col, value: 'nope' })).toThrow(StringLiteralTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a template literal that has substitutions', () => {
    const source = 'const n = 2\nexport const LABEL = `count: ${n}`\n'
    const file = writeFixture('tpl.ts', source)
    const { line, col } = locate(source, '`count:')

    // Rewriting this would silently delete the `${n}` interpolation.
    expect(() => setStringLiteral({ file, line, col, value: 'nope' })).toThrow(StringLiteralTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a line/column outside the file', () => {
    const file = writeFixture('short.ts', "export const A = 'a'\n")

    expect(() => setStringLiteral({ file, line: 999, col: 1, value: 'nope' })).toThrow(StringLiteralTargetError)
  })

  it('refuses a column that lands inside a literal rather than at its start', () => {
    const source = "export const LABEL = 'Old label'\n"
    const file = writeFixture('offset.ts', source)
    const { line, col } = locate(source, "'Old label'")

    // Off-by-one on the column must fail closed, not rewrite a neighbour.
    expect(() => setStringLiteral({ file, line, col: col + 3, value: 'nope' })).toThrow(StringLiteralTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
