import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setJsxProp } from '../../ast-codemods'
import { parsePageFile, STUDIO_ASSET_SENTINEL } from '../parsePageFile'
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

/** Like `writeFixture`, but supports a nested relative path (mkdir -p). */
function writeNestedFixture(relPath: string, source: string): string {
  const filePath = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
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

  it('captures a style={{…}} object literal into inlineStyles (literal entries only)', () => {
    const source = [
      'const gap = 8',
      'export default function Page() {',
      '  return (',
      '    <div style={{ display: "flex", flexDirection: "column", marginTop: 40, gap, background: accent() }}>',
      '      <span>hi</span>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('inline-styles.tsx', source)

    const div = byName(parsePageFile(file, tmpDir), 'div')
    // String + numeric literals captured; `gap` (identifier) and
    // `background: accent()` (call) skipped, matching extractProps' policy.
    expect(div.inlineStyles).toEqual({ display: 'flex', flexDirection: 'column', marginTop: 40 })
  })

  it('leaves inlineStyles absent for an element with no style attribute', () => {
    const file = writeFixture(
      'no-style.tsx',
      'export default function Page() {\n  return <div>hi</div>\n}\n',
    )
    expect(byName(parsePageFile(file, tmpDir), 'div').inlineStyles).toBeUndefined()
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

  it('captures a single-text-child element\'s text onto ParsedNode.text', () => {
    const source = [
      'export default function Page() {',
      '  return <p>Hello</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('single-text.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const p = byName(page, 'p')
    expect(p.text).toBe('Hello')
    expect(p.children).toEqual([])
  })

  it('captures a component\'s single-text child onto ParsedNode.text', () => {
    const source = [
      'export default function Page() {',
      '  return <Button>Click me</Button>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('component-text.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const button = byName(page, 'Button')
    expect(button.text).toBe('Click me')
  })

  it('captures a string-literal expression container as text', () => {
    const source = [
      'export default function Page() {',
      '  return <p>{"Hello"}</p>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('expr-container-text.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const p = byName(page, 'p')
    expect(p.text).toBe('Hello')
  })

  it('does not capture text for mixed content (element + text)', () => {
    const source = [
      'export default function Page() {',
      '  return <div><span/>x</div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('mixed-content.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const div = byName(page, 'div')
    expect(div.text).toBeUndefined()
  })

  it('does not capture text for a nested-element-only child', () => {
    const source = [
      'export default function Page() {',
      '  return <div><span>Hi</span></div>',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('nested-element-only.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const div = byName(page, 'div')
    expect(div.text).toBeUndefined()
    // The nested <span> itself still gets its own single-text-child capture.
    const span = byName(page, 'span')
    expect(span.text).toBe('Hi')
  })

  it('does not capture text for a locked (dynamic-surface) element', () => {
    const source = [
      'interface Item { id: string; title: string }',
      'export default function Page({ items }: { items: Item[] }) {',
      '  return (',
      '    <div>',
      '      {items.map((it) => (',
      '        <Card key={it.id}>Static label</Card>',
      '      ))}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('locked-text.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const card = byName(page, 'Card')
    expect(card.locked).toBe(true)
    expect(card.text).toBeUndefined()
  })

  it('captures a static <svg> verbatim into props.svg and does not recurse into its children', () => {
    const source = [
      'export default function Page() {',
      '  return (',
      '    <svg className="icon" viewBox="0 0 24 24">',
      '      <path d="M1 2h3" />',
      '      <circle cx="1" cy="2" r="3" />',
      '    </svg>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('static-svg.tsx', source)

    const page = parsePageFile(file, tmpDir)

    expect(page.rootIds.length).toBe(1)
    const svg = page.nodes[page.rootIds[0]]!
    expect(svg.name).toBe('svg')
    expect(svg.kind).toBe('element')
    expect(svg.children).toEqual([])
    expect(svg.locked).toBe(false)
    expect(svg.lockReason).toBeUndefined()
    expect(svg.props.svg).toContain('<path')
    // className is still captured as a normal literal prop (§4/§6 need it).
    expect(svg.props.className).toBe('icon')
    // <path>/<circle> never become their own ParsedNodes.
    expect(Object.values(page.nodes).some((n) => n.name === 'path')).toBe(false)
    expect(Object.values(page.nodes).some((n) => n.name === 'circle')).toBe(false)
  })

  it('locks a dynamic <svg> (embedded JSX expression) and drops the unusable svg prop', () => {
    const source = [
      'export default function Page({ pct }: { pct: number }) {',
      '  const C = 100',
      '  return (',
      '    <svg viewBox="0 0 24 24">',
      '      <circle strokeDashoffset={C * (1 - pct / 100)} />',
      '    </svg>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture('dynamic-svg.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const svg = page.nodes[page.rootIds[0]]!
    expect(svg.name).toBe('svg')
    expect(svg.locked).toBe(true)
    expect(svg.lockReason).toBe('dynamic SVG')
    expect(svg.props.svg).toBeUndefined()
    expect(svg.children).toEqual([])
  })

  it('resolves a default-imported image identifier to a sentinel-prefixed workspace-relative path (§5.1)', () => {
    const file = writeNestedFixture(
      'src/screens/Home.jsx',
      [
        "import esimChip from '../assets/esim-flow/figma/esim-chip.png'",
        'export default function Home() {',
        '  return <img src={esimChip} alt="chip" />',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)

    const img = byName(page, 'img')
    expect(img.props.src).toBe(`${STUDIO_ASSET_SENTINEL}src/assets/esim-flow/figma/esim-chip.png`)
    // Untouched literal prop still captured normally alongside it.
    expect(img.props.alt).toBe('chip')
  })

  it('resolves the same imported image identifier used on multiple elements', () => {
    const file = writeNestedFixture(
      'src/screens/Home.jsx',
      [
        "import esimChip from '../assets/esim-chip.png'",
        'export default function Home() {',
        '  return (',
        '    <div>',
        '      <img src={esimChip} />',
        '      <img src={esimChip} />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)
    const imgs = Object.values(page.nodes).filter((n) => n.name === 'img')
    expect(imgs).toHaveLength(2)
    for (const img of imgs) {
      expect(img.props.src).toBe(`${STUDIO_ASSET_SENTINEL}src/assets/esim-chip.png`)
    }
  })

  it('does not resolve a non-image default import (e.g. a local component) to a sentinel', () => {
    const file = writeNestedFixture(
      'src/screens/Home.jsx',
      [
        "import Header from '../components/Header'",
        'export default function Home() {',
        '  return <Header logo={Header} />',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)
    const header = byName(page, 'Header')
    expect(header.props.logo).toBeUndefined()
  })

  it('does not resolve an identifier that is not imported at all', () => {
    const file = writeFixture(
      'no-import.tsx',
      [
        'export default function Page() {',
        '  const localVar = "x"',
        '  return <img src={localVar} />',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)
    const img = byName(page, 'img')
    expect(img.props.src).toBeUndefined()
  })

  it('drops (does not sentinel) an image import that resolves OUTSIDE the workspace root', () => {
    // tmpDir/escape.tsx importing '../outside.png' resolves to a path one
    // level above tmpDir itself — outside the workspace root passed as appDir.
    const file = writeFixture(
      'escape.tsx',
      [
        "import outside from '../outside.png'",
        'export default function Page() {',
        '  return <img src={outside} />',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)
    const img = byName(page, 'img')
    expect(img.props.src).toBeUndefined()
  })

  it('does not resolve a bare/aliased (non-relative) image specifier — out of scope for §5.1', () => {
    const file = writeFixture(
      'aliased.tsx',
      [
        "import icon from '@/assets/icon.png'",
        'export default function Page() {',
        '  return <img src={icon} />',
        '}',
        '',
      ].join('\n'),
    )

    const page = parsePageFile(file, tmpDir)
    const img = byName(page, 'img')
    expect(img.props.src).toBeUndefined()
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
