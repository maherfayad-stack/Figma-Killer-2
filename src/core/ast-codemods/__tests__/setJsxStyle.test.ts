import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsxStyleTargetError, setJsxStyle } from '../setJsxStyle'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-style-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

describe('setJsxStyle', () => {
  it('adds a style attribute to an element that lacks one', () => {
    const source = [
      'export function App() {',
      '  return <div>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('add-style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { color: 'red', zIndex: 2 } })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('style={{ color: "red", zIndex: 2 }}')
  })

  it('merges a new key into an existing style object, keeping unrelated keys', () => {
    const source = [
      'export function App() {',
      '  return <div style={{ color: "red" }}>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('merge-style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { boxShadow: '0 0 0 1px black' } })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "red"')
    expect(written).toContain('boxShadow: "0 0 0 1px black"')
  })

  it('overrides an existing key in place', () => {
    const source = [
      'export function App() {',
      '  return <div style={{ color: "red", display: "flex" }}>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('override-style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { color: 'blue' } })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "blue"')
    expect(written).toContain('display: "flex"')
    expect(written).not.toContain('"red"')
  })

  it('serializes a var(--token) value correctly', () => {
    const source = [
      'export function App() {',
      '  return <div>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('token-value.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { color: 'var(--editor-danger)' } })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('color: "var(--editor-danger)"')
  })

  it('throws JsxStyleTargetError when style is an identifier expression', () => {
    const source = [
      'export function App() {',
      '  const s = { color: "red" }',
      '  return <div style={s}>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('identifier-style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() => setJsxStyle({ file, line, col, style: { color: 'blue' } })).toThrow(
      JsxStyleTargetError,
    )

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toBe(source)
  })

  it('throws JsxStyleTargetError when the style object literal contains a spread', () => {
    const source = [
      'export function App() {',
      '  const extra = { color: "red" }',
      '  return <div style={{ ...extra }}>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('spread-style.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() => setJsxStyle({ file, line, col, style: { color: 'blue' } })).toThrow(
      JsxStyleTargetError,
    )
  })

  it('is idempotent: setting the same style twice yields identical file content', () => {
    const source = [
      'export function App() {',
      '  return <div>Hi</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('idempotent.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { color: 'red' } })
    const afterFirst = fs.readFileSync(file, 'utf8')

    setJsxStyle({ file, line, col, style: { color: 'red' } })
    const afterSecond = fs.readFileSync(file, 'utf8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('throws a clear error when no JSX element exists at the location', () => {
    const source = 'export const x = 1\n'
    const file = writeFixture('no-element.tsx', source)

    expect(() => setJsxStyle({ file, line: 1, col: 1, style: { color: 'red' } })).toThrow(
      /No JSX element found/,
    )
  })
})


/**
 * `style-03` — the removal half. `setJsxStyle` only ever merged, so clearing
 * an inline style produced no edit that could do anything: the declaration
 * stayed in the `style={{…}}` on disk and came back on the next reload.
 */
describe('setJsxStyle — remove', () => {
  it('deletes the named properties and keeps the rest', () => {
    const source = ['export function App() {', "  return <div style={{ color: 'red', padding: 4 }}>Hi</div>", '}', ''].join('\n')
    const file = writeFixture('style-remove.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: {}, remove: ['color'] })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('padding: 4')
    expect(written).not.toContain('color')
  })

  it('removes the whole attribute once the last property is gone', () => {
    const source = ['export function App() {', "  return <div style={{ color: 'red' }}>Hi</div>", '}', ''].join('\n')
    const file = writeFixture('style-remove-all.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: {}, remove: ['color'] })

    expect(fs.readFileSync(file, 'utf8')).not.toContain('style')
  })

  it('is a no-op for a property that is already absent (idempotent re-send)', () => {
    const source = ['export function App() {', "  return <div style={{ color: 'red' }}>Hi</div>", '}', ''].join('\n')
    const file = writeFixture('style-remove-noop.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: {}, remove: ['padding'] })

    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('never mints an empty style attribute for a removal-only request on a bare element', () => {
    const source = ['export function App() {', '  return <div>Hi</div>', '}', ''].join('\n')
    const file = writeFixture('style-remove-bare.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: {}, remove: ['color'] })

    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses to remove a shorthand property whose value it never read', () => {
    const source = ['export function App({ color }) {', '  return <div style={{ color }}>Hi</div>', '}', ''].join('\n')
    const file = writeFixture('style-remove-shorthand.tsx', source)
    const { line, col } = locateTag(source, 'div')

    expect(() => setJsxStyle({ file, line, col, style: {}, remove: ['color'] })).toThrow(JsxStyleTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('sets and removes in one edit', () => {
    const source = ['export function App() {', "  return <div style={{ color: 'red', padding: 4 }}>Hi</div>", '}', ''].join('\n')
    const file = writeFixture('style-set-and-remove.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxStyle({ file, line, col, style: { margin: 8 }, remove: ['color'] })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('margin: 8')
    expect(written).toContain('padding: 4')
    expect(written).not.toContain('color')
  })
})
