import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsxTextTargetError, setJsxText } from '../setJsxText'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-text-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

describe('setJsxText', () => {
  it('WB-9 — replaces a plain-text child with plain text, not an expression container', () => {
    const source = [
      'export function App() {',
      '  return <p>Hello</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('plain-text.tsx', source)
    const { line, col } = locateTag(source, 'p')

    setJsxText({ file, line, col, text: 'Bye' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toBe(source.replace('<p>Hello</p>', '<p>Bye</p>'))
  })

  it('replaces a component element\'s text child', () => {
    const source = [
      'export function App() {',
      '  return <Button>x</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('component-text.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    setJsxText({ file, line, col, text: 'Go' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Button>Go</Button>')
  })

  it('fills an empty element with no prior children', () => {
    const source = [
      'export function App() {',
      '  return <p></p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('empty.tsx', source)
    const { line, col } = locateTag(source, 'p')

    setJsxText({ file, line, col, text: 'New' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<p>New</p>')
  })

  it('expands a self-closing element, preserving attributes verbatim', () => {
    const source = [
      'export function App() {',
      '  return <Label htmlFor="email" className="field-label" />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('self-closing.tsx', source)
    const { line, col } = locateTag(source, 'Label')

    setJsxText({ file, line, col, text: 'Email' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain(
      '<Label htmlFor="email" className="field-label">Email</Label>',
    )
  })

  it('replaces an existing string-literal expression container', () => {
    const source = [
      'export function App() {',
      '  return <p>{"Old"}</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('existing-expression.tsx', source)
    const { line, col } = locateTag(source, 'p')

    setJsxText({ file, line, col, text: 'New' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<p>{"New"}</p>')
  })

  it('throws JsxTextTargetError on an element child (nested JSX)', () => {
    const source = [
      'export function App() {',
      '  return <div><span/></div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('element-child.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() => setJsxText({ file, line, col, text: 'Bye' })).toThrow(JsxTextTargetError)
  })

  it('throws JsxTextTargetError on mixed content (icon + label)', () => {
    const source = [
      'export function App() {',
      '  return <Button><Icon/> Label</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('mixed-content.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    expect(() => setJsxText({ file, line, col, text: 'Bye' })).toThrow(JsxTextTargetError)

    // The file must be untouched — a thrown codemod must not partially write.
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toBe(source)
  })

  it('throws JsxTextTargetError on a non-literal expression child', () => {
    const source = [
      'export function App() {',
      '  const label = "dynamic"',
      '  return <p>{label}</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('non-literal-expression.tsx', source)
    const { line, col } = locateTag(source, 'p')

    expect(() => setJsxText({ file, line, col, text: 'Bye' })).toThrow(JsxTextTargetError)
  })

  it('writes text raw JSX cannot say as an escaped string container', () => {
    const source = [
      'export function App() {',
      '  return <p>Hello</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('escaping.tsx', source)
    const { line, col } = locateTag(source, 'p')
    const text = `Say "hi" & <bye> {curly}`

    setJsxText({ file, line, col, text })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain(`<p>{${JSON.stringify(text)}}</p>`)
  })

  it('is idempotent: setting the same text twice yields identical file content', () => {
    const source = [
      'export function App() {',
      '  return <p>Hello</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('idempotent.tsx', source)
    const { line, col } = locateTag(source, 'p')

    setJsxText({ file, line, col, text: 'Bye' })
    const afterFirst = fs.readFileSync(file, 'utf8')

    setJsxText({ file, line, col, text: 'Bye' })
    const afterSecond = fs.readFileSync(file, 'utf8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('throws a clear error when no JSX element exists at the location', () => {
    const source = 'export const x = 1\n'
    const file = writeFixture('no-element.tsx', source)

    expect(() => setJsxText({ file, line: 1, col: 1, text: 'Bye' })).toThrow(
      /No JSX element found/,
    )
  })
describe('WB-9 — the file keeps its formatting', () => {
    it('keeps a multi-line text on the same lines, so nothing below it moves', () => {
      const source = [
        'export function App() {',
        '  return (',
        '    <p>',
        '      Multi line',
        '      copy here',
        '    </p>',
        '  )',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('multi-line.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'Multi line copy here!' })

      const written = fs.readFileSync(file, 'utf8')
      expect(written).toBe(source.replace('copy here', 'copy here!'))
      expect(written.split('\n').length).toBe(source.split('\n').length)
    })

    it('re-wraps a longer value over the original lines, each with its own indentation', () => {
      const source = ['export const A = () => (', '  <p>', '    One two', '    three', '  </p>', ')', ''].join('\n')
      const file = writeFixture('rewrap.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'Alpha beta gamma delta' })

      const written = fs.readFileSync(file, 'utf8')
      const body = written.split('\n').slice(2, 4)
      expect(body.every((row) => row.startsWith('    ') && row.trim().length > 0)).toBe(true)
      expect(body.map((row) => row.trim()).join(' ')).toBe('Alpha beta gamma delta')
      expect(written.split('\n').length).toBe(source.split('\n').length)
    })

    it('writes a value that carries its own line breaks exactly as given', () => {
      const source = ['export const A = () => (', '  <p>', '    One', '    two', '  </p>', ')', ''].join('\n')
      const file = writeFixture('own-breaks.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'One\n    two\n    three' })

      expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('    two\n', '    two\n    three\n'))
    })

    it('keeps the whitespace around single-line text byte-for-byte', () => {
      const source = 'export const A = () => <p> Hello </p>\n'
      const file = writeFixture('padded.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'Bye' })

      expect(fs.readFileSync(file, 'utf8')).toBe('export const A = () => <p> Bye </p>\n')
    })

    it('keeps an existing single-quoted container, in single quotes', () => {
      const source = "export const A = () => <p>{'Old'}</p>\n"
      const file = writeFixture('single-container.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: "It's new" })

      expect(fs.readFileSync(file, 'utf8')).toBe("export const A = () => <p>{'It\\'s new'}</p>\n")
    })

    it("falls back to a container in the file's own quote for text raw JSX cannot say", () => {
      const source = ["import { x } from './x'", 'export const A = () => <p>Hello</p>', ''].join('\n')
      const file = writeFixture('single-file.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'a < b' })

      expect(fs.readFileSync(file, 'utf8')).toContain("<p>{'a < b'}</p>")
    })

    it('does not write raw text the compiler would decode as an entity', () => {
      const source = 'export const A = () => <p>Hello</p>\n'
      const file = writeFixture('entity.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'Fish &amp; chips' })

      expect(fs.readFileSync(file, 'utf8')).toContain('<p>{"Fish &amp; chips"}</p>')
    })

    it('writes an ampersand that is not an entity raw', () => {
      const source = 'export const A = () => <p>Hello</p>\n'
      const file = writeFixture('ampersand.tsx', source)
      const { line, col } = locateTag(source, 'p')

      setJsxText({ file, line, col, text: 'Terms & conditions' })

      expect(fs.readFileSync(file, 'utf8')).toContain('<p>Terms & conditions</p>')
    })
  })
})
