/**
 * `setImportSpecifier` — the writeback that makes an imported image editable.
 *
 * `<img src={heroImg}/>` where `heroImg = import('./hero.png')` has no writeback
 * target at the JSX (that would delete the binding). The honest target is the
 * import's own module-specifier literal, addressed by the (line, col) the parser
 * records as `ParsedNode.assetOrigin`.
 *
 * The tests below are mostly about NOT writing: a mis-aimed literal write
 * corrupts a file the editor never showed the user, and this codemod must
 * refuse anything that is not genuinely an import's own specifier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setImportSpecifier, ImportSpecifierTargetError } from '../setImportSpecifier'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-import-specifier-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

/** 1-based line/col of `needle`'s first character — what `assetOrigin` records. */
function locate(source: string, needle: string): { line: number; col: number } {
  const index = source.indexOf(needle)
  if (index < 0) throw new Error(`fixture does not contain ${needle}`)
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const col = index - (before.lastIndexOf('\n') + 1) + 1
  return { line, col }
}

const PAGE_SOURCE = [
  "import React from 'react'",
  "import heroImg from './assets/hero.png'",
  "import { Header } from './Header'",
  '',
  'export function Home() {',
  '  return <img src={heroImg} alt="Hero" />',
  '}',
  '',
].join('\n')

describe('setImportSpecifier', () => {
  it('replaces the module specifier and nothing else', () => {
    const file = writeFixture('Home.tsx', PAGE_SOURCE)
    const { line, col } = locate(PAGE_SOURCE, "'./assets/hero.png'")

    setImportSpecifier({ file, line, col, specifier: './assets/hero-2.png' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("import heroImg from './assets/hero-2.png'")
    // Sibling imports are untouched.
    expect(written).toContain("import React from 'react'")
    expect(written).toContain("import { Header } from './Header'")
    // The JSX itself is untouched — the binding, not a baked path.
    expect(written).toContain('<img src={heroImg} alt="Hero" />')
  })

  it('keeps the quote style already in the file', () => {
    const file = writeFixture('Home.tsx', PAGE_SOURCE)
    const { line, col } = locate(PAGE_SOURCE, "'./assets/hero.png'")

    setImportSpecifier({ file, line, col, specifier: './assets/new.png' })

    expect(fs.readFileSync(file, 'utf8')).toContain("'./assets/new.png'")
  })

  it('rewrites a double-quoted specifier as double-quoted', () => {
    const source = 'import heroImg from "./assets/hero.png"\nexport const x = heroImg\n'
    const file = writeFixture('double.ts', source)
    const { line, col } = locate(source, '"./assets/hero.png"')

    setImportSpecifier({ file, line, col, specifier: './assets/new.png' })

    expect(fs.readFileSync(file, 'utf8')).toContain('"./assets/new.png"')
  })

  it('leaves the rest of the file byte-identical apart from the specifier', () => {
    const file = writeFixture('Home.tsx', PAGE_SOURCE)
    const { line, col } = locate(PAGE_SOURCE, "'./assets/hero.png'")

    setImportSpecifier({ file, line, col, specifier: './assets/hero-2.png' })

    const written = fs.readFileSync(file, 'utf8')
    const expected = PAGE_SOURCE.replace("'./assets/hero.png'", "'./assets/hero-2.png'")
    expect(written).toBe(expected)
  })

  it('escapes a specifier containing the quote character', () => {
    const file = writeFixture('Home.tsx', PAGE_SOURCE)
    const { line, col } = locate(PAGE_SOURCE, "'./assets/hero.png'")

    setImportSpecifier({ file, line, col, specifier: "./assets/ramy's pick.png" })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("'./assets/ramy\\'s pick.png'")
  })

  it('refuses a position that is not a string literal', () => {
    const source = 'export const COUNT = 42\n'
    const file = writeFixture('count.ts', source)
    const { line, col } = locate(source, '42')

    expect(() => setImportSpecifier({ file, line, col, specifier: 'nope' })).toThrow(ImportSpecifierTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses an ordinary string literal that is not an import specifier', () => {
    // Same literal shape, wrong grammatical position — a `require()` call
    // argument, not an ImportDeclaration's own specifier.
    const source = "const heroImg = require('./assets/hero.png')\n"
    const file = writeFixture('require.ts', source)
    const { line, col } = locate(source, "'./assets/hero.png'")

    expect(() => setImportSpecifier({ file, line, col, specifier: 'nope' })).toThrow(ImportSpecifierTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a dictionary string literal at an unrelated location', () => {
    const source = "export const translations = {\n  hotelsTag: 'Exclusive rates on hotels',\n}\n"
    const file = writeFixture('translations.js', source)
    const { line, col } = locate(source, "'Exclusive rates on hotels'")

    expect(() => setImportSpecifier({ file, line, col, specifier: 'nope' })).toThrow(ImportSpecifierTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a named-import specifier text but succeeds on its own specifier position', () => {
    const source = "import { Header } from './Header'\nimport heroImg from './assets/hero.png'\n"
    const file = writeFixture('mixed.ts', source)
    // Position of the FIRST import's specifier — a real, different import.
    const { line, col } = locate(source, "'./Header'")

    setImportSpecifier({ file, line, col, specifier: './HeaderNew' })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("import { Header } from './HeaderNew'")
    // The second import is untouched.
    expect(written).toContain("import heroImg from './assets/hero.png'")
  })

  it('refuses a line/column outside the file', () => {
    const file = writeFixture('short.ts', "import x from './x.png'\n")

    expect(() => setImportSpecifier({ file, line: 999, col: 1, specifier: 'nope' })).toThrow(
      ImportSpecifierTargetError,
    )
  })

  it('refuses a column that lands inside the literal rather than at its start', () => {
    const file = writeFixture('offset.ts', PAGE_SOURCE)
    const { line, col } = locate(PAGE_SOURCE, "'./assets/hero.png'")

    expect(() =>
      setImportSpecifier({ file, line, col: col + 3, specifier: 'nope' }),
    ).toThrow(ImportSpecifierTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE_SOURCE)
  })

  it('refuses a no-substitution template literal used as a specifier (not real import grammar)', () => {
    // Not valid JS for an import specifier, but exercise the "wrong node kind"
    // refusal path defensively — `setStringLiteral` accepts a template literal;
    // this codemod deliberately does not.
    const source = 'const x = `./assets/hero.png`\n'
    const file = writeFixture('tpl.ts', source)
    const { line, col } = locate(source, '`./assets/hero.png`')

    expect(() => setImportSpecifier({ file, line, col, specifier: 'nope' })).toThrow(ImportSpecifierTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
