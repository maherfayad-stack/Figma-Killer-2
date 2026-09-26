/**
 * P3-C (WB-17) — an inline-style edit lands after a spread, and wraps a
 * `style` that is an identifier or a call, instead of refusing `style-target`.
 *
 * JS semantics decide both: in `{ ...base, color: 'red' }` a key written AFTER
 * the last spread wins, so writing there makes the element show exactly what
 * the canvas shows; and `style={s}` becomes `style={{ ...s, color: 'red' }}`,
 * which keeps the binding and adds one key on top. What still refuses: a
 * REMOVAL from a wrapped expression (the key lives inside it — there is
 * nothing in the file to delete), a shorthand key, and wrapping a value that
 * is not an object.
 *
 * The fixture is a dashboard card and shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsxStyleTargetError, setJsxStyle } from '../setJsxStyle'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-style-spread-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** `line:col` of the `nth` (0-based) `<Tile` tag name in `source`. */
function tileAt(source: string, nth = 0): { line: number; col: number } {
  let index = -1
  for (let i = 0; i <= nth; i++) index = source.indexOf('<Tile', index + 1)
  const before = source.slice(0, index + 1)
  return { line: before.split('\n').length, col: index + 1 - before.lastIndexOf('\n') }
}

/** Writes `source` and returns the file plus the location of its first `<Tile`. */
function fixture(source: string): { file: string; line: number; col: number } {
  const file = path.join(tmpDir, 'Stats.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return { file, ...tileAt(source) }
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('setJsxStyle — a spread inside the style object', () => {
  const SOURCE = "const base = { padding: 4 }\nexport const Stats = () => <Tile style={{ ...base, color: 'red' }} />\n"

  it('updates a key written after the last spread in place', () => {
    const at = fixture(SOURCE)
    setJsxStyle({ ...at, style: { color: 'blue' } })
    expect(read(at.file)).toBe(SOURCE.replace("color: 'red'", "color: 'blue'")) // WB-10 — in the object's own quote
  })

  it('adds a new key after the last spread, where it wins', () => {
    const at = fixture(SOURCE)
    setJsxStyle({ ...at, style: { margin: '8px' } })
    expect(read(at.file)).toBe(SOURCE.replace("color: 'red' }}", "color: 'red', margin: '8px' }}"))
  })

  it('MOVES a key written only before the spread to after it — one key, never a TS1117 duplicate', () => {
    const src = "const base = { padding: 4 }\nexport const Stats = () => <Tile style={{ color: 'red', ...base }} />\n"
    const at = fixture(src)
    setJsxStyle({ ...at, style: { color: 'blue' } })
    expect(read(at.file)).toBe(src.replace("{{ color: 'red', ...base }}", "{{ ...base, color: 'blue' }}"))
  })

  it('sets the LAST of a key written both before and after the spread', () => {
    const src = "export const Stats = (p: object) => <Tile style={{ color: 'red', ...p, color: 'green' }} />\n"
    const at = fixture(src)
    setJsxStyle({ ...at, style: { color: 'blue' } })
    expect(read(at.file)).toBe(src.replace("color: 'green'", "color: 'blue'"))
  })

  it('removes a key written after the spread; a key only the spread supplies is a no-op (the canvas never showed it)', () => {
    const at = fixture(SOURCE)
    setJsxStyle({ ...at, style: {}, remove: ['color'] })
    expect(read(at.file)).toBe(SOURCE.replace("{{ ...base, color: 'red' }}", '{{ ...base }}'))
    setJsxStyle({ ...at, style: {}, remove: ['padding'] })
    expect(read(at.file)).toBe(SOURCE.replace("{{ ...base, color: 'red' }}", '{{ ...base }}'))
  })

  it('still refuses to overwrite a shorthand key after the spread', () => {
    const src = 'export const Stats = ({ color }: { color: string }) => <Tile style={{ ...base, color }} />\n'
    const at = fixture(src)
    expect(() => setJsxStyle({ ...at, style: { color: 'blue' } })).toThrow(JsxStyleTargetError)
    expect(read(at.file)).toBe(src)
  })
})

describe('setJsxStyle — an identifier, member chain, call, or conditional initializer', () => {
  it('wraps an identifier in an object that spreads it', () => {
    const src = 'const tile = { padding: 4 }\nexport const Stats = () => <Tile style={tile} />\n'
    const at = fixture(src)
    setJsxStyle({ ...at, style: { color: 'blue' } })
    expect(read(at.file)).toBe(src.replace('style={tile}', 'style={{ ...tile, color: "blue" }}'))
  })

  it('wraps a call', () => {
    const src = "export const Stats = () => <Tile style={tone('warm')} />\n"
    const at = fixture(src)
    setJsxStyle({ ...at, style: { opacity: 0.5 } })
    expect(read(at.file)).toBe(src.replace("style={tone('warm')}", "style={{ ...tone('warm'), opacity: 0.5 }}"))
  })

  it('wraps a member chain, and parenthesises a conditional', () => {
    const src = 'export const Stats = (p: { on: boolean }) => (\n  <>\n    <Tile style={theme.card} />\n    <Tile style={p.on ? a : b} />\n  </>\n)\n'
    const at = fixture(src)
    setJsxStyle({ ...at, style: { color: 'blue' } })
    setJsxStyle({ file: at.file, ...tileAt(src, 1), style: { color: 'red' } })
    expect(read(at.file)).toBe(
      src
        .replace('style={theme.card}', 'style={{ ...theme.card, color: "blue" }}')
        .replace('style={p.on ? a : b}', 'style={{ ...(p.on ? a : b), color: "red" }}'),
    )
  })

  it('refuses a removal — the key lives inside the expression, not in the file', () => {
    const src = 'const tile = { padding: 4 }\nexport const Stats = () => <Tile style={tile} />\n'
    const at = fixture(src)
    expect(() => setJsxStyle({ ...at, style: {}, remove: ['padding'] })).toThrow(JsxStyleTargetError)
    expect(read(at.file)).toBe(src)
  })

  it('refuses to spread a value that is not an object — a string would scatter into characters', () => {
    const src = 'export const Stats = () => <Tile style={`color: red`} />\n'
    const at = fixture(src)
    expect(() => setJsxStyle({ ...at, style: { color: 'blue' } })).toThrow(JsxStyleTargetError)
    expect(read(at.file)).toBe(src)
  })

  it('still refuses a string style attribute — there is no object to write into', () => {
    const src = 'export const Stats = (p: object) => <Tile {...p} style="color:red" />\n'
    const at = fixture(src)
    expect(() => setJsxStyle({ ...at, style: { color: 'blue' } })).toThrow(JsxStyleTargetError)
    expect(read(at.file)).toBe(src)
  })
})
