import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setJsxProp } from '../../ast-codemods'
import { parsePageFile } from '../parsePageFile'
import type { ParsedNode, ParsedPage } from '../types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-parser-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

function byName(page: ParsedPage, name: string): ParsedNode {
  const node = Object.values(page.nodes).find((n) => n.name === name)
  if (!node) throw new Error(`no parsed node named "${name}" (have: ${Object.values(page.nodes).map((n) => n.name).join(', ')})`)
  return node
}

describe('parsePageFile', () => {
  it('parses a static tree: element/component kinds, props, children, rootIds', () => {
    const source = [
      'export default function Page() {',
      '  return (',
      '    <div>',
      '      <Button label="Save" primary />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('static-tree.tsx', source)

    const page = parsePageFile(file, tmpDir)

    expect(page.rootIds.length).toBe(1)
    const div = page.nodes[page.rootIds[0]]
    expect(div.kind).toBe('element')
    expect(div.name).toBe('div')
    expect(div.locked).toBe(false)

    const button = byName(page, 'Button')
    expect(button.kind).toBe('component')
    expect(button.props).toEqual({ label: 'Save', primary: true })
    expect(button.locked).toBe(false)
    expect(div.children).toContain(button.id)
  })

  it('captures numeric/boolean literal props and skips non-literal props', () => {
    const source = [
      'export default function Page() {',
      '  const handleClick = () => {}',
      '  return <Widget count={5} active={true} disabled={false} onClick={handleClick} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('literal-props.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const widget = byName(page, 'Widget')
    expect(widget.props).toEqual({ count: 5, active: true, disabled: false })
    expect(widget.props.onClick).toBeUndefined()
  })

  it('locks elements rendered from a `.map(...)` callback', () => {
    const source = [
      'interface Item { id: string; title: string }',
      'export default function Page({ items }: { items: Item[] }) {',
      '  return (',
      '    <div>',
      '      {items.map((it) => (',
      '        <Card key={it.id} title={it.title} />',
      '      ))}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('map-locking.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const card = byName(page, 'Card')
    expect(card.locked).toBe(true)
    expect(card.lockReason).toBeTruthy()
    expect(card.props.title).toBeUndefined() // `it.title` is non-literal, skipped as a prop too

    const div = page.nodes[page.rootIds[0]]
    expect(div.children).toContain(card.id)
  })

  it('locks elements rendered from a ternary or logical JSX expression', () => {
    const source = [
      'export default function Page({ open }: { open: boolean }) {',
      '  return (',
      '    <div>',
      '      {open ? <Dialog /> : null}',
      '      {open && <Toast />}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('ternary-locking.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const dialog = byName(page, 'Dialog')
    expect(dialog.locked).toBe(true)
    expect(dialog.lockReason).toBeTruthy()

    const toast = byName(page, 'Toast')
    expect(toast.locked).toBe(true)
    expect(toast.lockReason).toBeTruthy()
  })

  it('locks elements with a spread attribute', () => {
    const source = [
      'export default function Page(props: Record<string, unknown>) {',
      '  return <Panel {...props} />',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('spread-locking.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const panel = byName(page, 'Panel')
    expect(panel.locked).toBe(true)
    expect(panel.lockReason).toBeTruthy()
  })

  it('locks descendants of a locked element too', () => {
    const source = [
      'interface Item { id: string }',
      'export default function Page({ items }: { items: Item[] }) {',
      '  return (',
      '    <div>',
      '      {items.map((it) => (',
      '        <Card key={it.id}>',
      '          <Icon name="star" />',
      '        </Card>',
      '      ))}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('nested-locking.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const icon = byName(page, 'Icon')
    expect(icon.locked).toBe(true)
  })

  it('returns an empty page for a file with no component/JSX', () => {
    const file = writeFixture('no-component.tsx', 'export const x = 1\n')

    const page = parsePageFile(file, tmpDir)

    expect(page).toEqual({ rootIds: [], nodes: {} })
  })

  it('CROSS-CHECK: locations from parsePageFile are valid setJsxProp targets', () => {
    // Two elements sharing a tag name, so this also proves the location
    // pinpoints the exact element, not just "some Card in the file".
    const source = [
      'export default function Page() {',
      '  return (',
      '    <div>',
      '      <Card title="First" />',
      '      <Card title="Second" />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('cross-check.tsx', source)

    const page = parsePageFile(file, tmpDir)
    const cards = Object.values(page.nodes).filter((n) => n.name === 'Card')
    expect(cards.length).toBe(2)

    const second = cards.find((n) => n.props.title === 'Second')
    expect(second).toBeDefined()
    expect(second!.locked).toBe(false)

    setJsxProp({
      file,
      line: second!.loc.line,
      col: second!.loc.col,
      prop: 'data-test',
      value: 'x',
    })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Card title="Second" data-test="x" />')
    expect(written).not.toContain('First" data-test="x"')

    // Re-parsing confirms the edit landed on the right node and the file is
    // still a well-formed page.
    const reparsed = parsePageFile(file, tmpDir)
    const updatedSecond = Object.values(reparsed.nodes).find((n) => n.props.title === 'Second')
    expect(updatedSecond?.props['data-test']).toBe('x')
    const updatedFirst = Object.values(reparsed.nodes).find((n) => n.props.title === 'First')
    expect(updatedFirst?.props['data-test']).toBeUndefined()
  })
})
