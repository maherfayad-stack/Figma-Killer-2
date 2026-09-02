import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readJsxProps } from '../readJsxProps'
import { setJsxProp } from '../setJsxProp'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

describe('setJsxProp', () => {
  it('adds a new string prop to an element that lacks it', () => {
    const source = [
      'export function App() {',
      '  return (',
      '    <Button>Click me</Button>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('add-prop.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    setJsxProp({ file, line, col, prop: 'variant', value: 'primary' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Button variant="primary">Click me</Button>')

    const props = readJsxProps({ file, line, col })
    expect(props.variant).toBe('primary')
  })

  it("replaces an existing prop's value", () => {
    const source = [
      'export function App() {',
      '  return <Button variant="secondary">Click me</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('replace-prop.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    setJsxProp({ file, line, col, prop: 'variant', value: 'primary' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('variant="primary"')
    expect(written).not.toContain('secondary')

    const props = readJsxProps({ file, line, col })
    expect(props.variant).toBe('primary')
  })

  it('sets a numeric prop using the {123} expression form', () => {
    const source = [
      'export function App() {',
      '  return <Slider min={0} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('numeric-prop.tsx', source)
    const { line, col } = locateTag(source, 'Slider')

    setJsxProp({ file, line, col, prop: 'max', value: 100 })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('max={100}')

    const props = readJsxProps({ file, line, col })
    expect(props.max).toBe(100)
    expect(props.min).toBe(0)
  })

  it('sets a boolean prop using the {true} expression form', () => {
    const source = [
      'export function App() {',
      '  return <Slider min={0} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('boolean-prop.tsx', source)
    const { line, col } = locateTag(source, 'Slider')

    setJsxProp({ file, line, col, prop: 'disabled', value: true })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('disabled={true}')

    const props = readJsxProps({ file, line, col })
    expect(props.disabled).toBe(true)
  })

  it('targets only the element at the given location when two share a tag name', () => {
    const source = [
      'export function List() {',
      '  return (',
      '    <div>',
      '      <Card title="First" />',
      '      <Card title="Second" />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('two-elements.tsx', source)
    const first = locateTag(source, 'Card', 1)
    const second = locateTag(source, 'Card', 2)
    expect(second.line).toBeGreaterThan(first.line)

    setJsxProp({ file, line: second.line, col: second.col, prop: 'title', value: 'Updated' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('title="First"')
    expect(written).toContain('title="Updated"')
    expect(written).not.toContain('title="Second"')

    expect(readJsxProps({ file, line: first.line, col: first.col }).title).toBe('First')
    expect(readJsxProps({ file, line: second.line, col: second.col }).title).toBe('Updated')
  })

  it('is idempotent: setting the same value twice yields identical file content', () => {
    const source = [
      'export function App() {',
      '  return <Button variant="secondary">Click me</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('idempotent.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    setJsxProp({ file, line, col, prop: 'variant', value: 'primary' })
    const afterFirst = fs.readFileSync(file, 'utf8')

    setJsxProp({ file, line, col, prop: 'variant', value: 'primary' })
    const afterSecond = fs.readFileSync(file, 'utf8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('picks the single-quote delimiter when the value contains embedded double quotes', () => {
    // JSX attribute string literals don't support `\"` escaping (backslash
    // isn't an escape character there), so the safe move is to switch the
    // delimiter rather than try to escape.
    const source = [
      'export function App() {',
      '  return <Button>Click me</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('embedded-double-quote.tsx', source)
    const { line, col } = locateTag(source, 'Button')

    setJsxProp({ file, line, col, prop: 'label', value: 'Say "hi"' })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain(`label='Say "hi"'`)

    const props = readJsxProps({ file, line, col })
    expect(props.label).toBe('Say "hi"')
  })

  it('falls back to an expression container when the value contains both quote characters', () => {
    const source = [
      'export function App() {',
      '  return <Button>Click me</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('both-quotes.tsx', source)
    const { line, col } = locateTag(source, 'Button')
    const value = `Say "hi" and 'bye'`

    setJsxProp({ file, line, col, prop: 'label', value })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('label={')

    const props = readJsxProps({ file, line, col })
    expect(props.label).toBe(value)
  })

  it('throws a clear error when no JSX element exists at the location', () => {
    const source = 'export const x = 1\n'
    const file = writeFixture('no-element.tsx', source)

    expect(() => setJsxProp({ file, line: 1, col: 1, prop: 'foo', value: 'bar' })).toThrow(
      /No JSX element found/,
    )
  })
})

describe('readJsxProps', () => {
  it('returns only literal-valued attributes, skipping complex expressions', () => {
    const source = [
      'export function App() {',
      '  const label = "dynamic"',
      '  return (',
      '    <Widget',
      '      title="Static"',
      '      count={5}',
      '      active={true}',
      '      disabled={false}',
      '      onClick={() => {}}',
      '      computed={label}',
      '    />',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('read-props.tsx', source)
    const { line, col } = locateTag(source, 'Widget')

    const props = readJsxProps({ file, line, col })

    expect(props).toEqual({
      title: 'Static',
      count: 5,
      active: true,
      disabled: false,
    })
  })
})
