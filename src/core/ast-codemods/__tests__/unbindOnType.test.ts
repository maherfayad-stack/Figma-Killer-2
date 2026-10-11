/**
 * G-6 (OD-20): typing over a code-bound value replaces the code with the
 * literal, only when the caller says `unbind: true`, and only for a plain value.
 * The refusals are tested as hard as the successes: the same call without the
 * flag still refuses, and markup / functions / whole lists never turn into text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsxPropTargetError, setJsxProp } from '../setJsxProp'
import { JsxTextTargetError, setJsxText } from '../setJsxText'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unbind-on-type-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fixture(source: string): { file: string; line: number; col: number; tag: string } {
  const file = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return { file, ...locateTag(source, 'p'), tag: 'p' }
}

const page = (body: string) => `export function Page({ count, t }: { count: number; t: (k: string) => string }) {\n  return (\n    <main>\n${body}\n    </main>\n  )\n}\n`

describe('setJsxProp unbind', () => {
  it('replaces a code-bound attribute only when asked, and keeps every other byte', () => {
    const source = page('      <p title={count} id="a">x</p>')
    const { file, line, col } = fixture(source)

    expect(() => setJsxProp({ file, line, col, prop: 'title', value: 'Hello' })).toThrow(JsxPropTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)

    setJsxProp({ file, line, col, prop: 'title', value: 'Hello', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('title={count}', 'title="Hello"'))
  })

  it('replaces a translation call the same way - the key stays in the dictionary, only the call goes', () => {
    const source = page("      <p aria-label={t('home.title')}>x</p>")
    const { file, line, col } = fixture(source)
    setJsxProp({ file, line, col, prop: 'aria-label', value: 'Home', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace("aria-label={t('home.title')}", 'aria-label="Home"'))
  })

  it('writes a number as a number', () => {
    const source = page('      <p tabIndex={count}>x</p>')
    const { file, line, col } = fixture(source)
    setJsxProp({ file, line, col, prop: 'tabIndex', value: 3, unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('tabIndex={count}', 'tabIndex={3}'))
  })

  it.each([
    ['a function', '      <p onClick={() => count}>x</p>', 'onClick'],
    ['markup', '      <p data-icon={<b>x</b>}>x</p>', 'data-icon'],
    ['a whole list', '      <p data-items={[1, 2]}>x</p>', 'data-items'],
    ['a whole object', '      <p data-conf={{ a: 1 }}>x</p>', 'data-conf'],
  ])('still refuses %s, writing nothing', (_name, body, prop) => {
    const source = page(body)
    const { file, line, col } = fixture(source)
    expect(() => setJsxProp({ file, line, col, prop, value: 'x', unbind: true })).toThrow(JsxPropTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('does not turn a spread into an attribute override of itself: an absent name is still just added', () => {
    const source = page('      <p {...rest}>x</p>')
    const { file, line, col } = fixture(source)
    setJsxProp({ file, line, col, prop: 'title', value: 'Hello', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('<p {...rest}>', '<p {...rest} title="Hello">'))
  })
})

describe('setJsxText unbind', () => {
  it('replaces the one code child, keeping the layout around it', () => {
    const source = page('      <p>\n        {count}\n      </p>')
    const { file, line, col } = fixture(source)

    expect(() => setJsxText({ file, line, col, text: 'Five' })).toThrow(JsxTextTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)

    setJsxText({ file, line, col, text: 'Five', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('{count}', 'Five'))
  })

  it('replaces a translation call in an inline element', () => {
    const source = page("      <p>{t('cart.empty')}</p>")
    const { file, line, col } = fixture(source)
    setJsxText({ file, line, col, text: 'Nothing here', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace("{t('cart.empty')}", 'Nothing here'))
  })

  it('spells text raw JSX cannot say as a string container', () => {
    const source = page('      <p>{count}</p>')
    const { file, line, col } = fixture(source)
    setJsxText({ file, line, col, text: '1 < 2', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('{count}', '{"1 < 2"}'))
  })

  it('clearing the text removes the code and leaves an empty element', () => {
    const source = page('      <p>{count}</p>')
    const { file, line, col } = fixture(source)
    setJsxText({ file, line, col, text: '', unbind: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(source.replace('<p>{count}</p>', '<p></p>'))
  })

  it.each([
    ['text beside code', '      <p>Total: {count}</p>'],
    ['two expressions', '      <p>{count}{count}</p>'],
    ['markup in the expression', '      <p>{count > 1 && <b>many</b>}</p>'],
    ['a list that renders elements', '      <p>{[1, 2].map((n) => <i key={n}>{n}</i>)}</p>'],
  ])('still refuses %s, writing nothing', (_name, body) => {
    const source = page(body)
    const { file, line, col } = fixture(source)
    expect(() => setJsxText({ file, line, col, text: 'x', unbind: true })).toThrow(JsxTextTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
