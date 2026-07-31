/**
 * swapComponentInstance — WS-4.5. Covers the plan's gate list: tag rename,
 * import resolution, prop diffing, shadowing refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { swapComponentInstance, type SwapResult } from '../swapComponentInstance'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-component-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
}

function swapAt(
  file: string,
  line: number,
  col: number,
  target: { newComponentName: string; newComponentSource: 'local' | 'package'; newComponentFile: string },
): SwapResult {
  return swapComponentInstance({ file, line, col, workspaceRoot: tmpDir, ...target })
}

describe('swapComponentInstance — tag rename', () => {
  it('renames a self-closing tag', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile() {\n  return <div>Tile</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toContain('<Tile />')
  })

  it('renames both the opening AND closing tag for an open/close call site', () => {
    write('components/Card.tsx', 'export function Card({ children }: { children?: React.ReactNode }) {\n  return <div>{children}</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile({ children }: { children?: React.ReactNode }) {\n  return <div>{children}</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card>hi</Card>',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<Tile>hi</Tile>')
    expect(text).not.toContain('</Card>')
  })

  it('renames only the TARGETED self-closing instance nested beside a sibling, without corrupting the enclosing element', () => {
    // Regression: a self-closing element's `.getParent()` is whatever
    // CONTAINS it (the surrounding <div>), not "its own open+close pair" —
    // getting this wrong renamed the ENCLOSING div's closing tag instead.
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile() {\n  return <div>Tile</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return (',
      '    <section>',
      '      <Card />',
      '      <span>sibling</span>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 5, 8, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<Tile />')
    expect(text).toContain('</section>') // enclosing element untouched
    expect(text).toContain('<span>sibling</span>') // sibling untouched
  })
})

describe('swapComponentInstance — import resolution', () => {
  it('adds the new component\'s import and drops the old one when it was the last usage', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile() {\n  return <div>Tile</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain("import { Tile } from '../components/Tile'")
    expect(text).not.toContain("from '../components/Card'")
  })

  it('keeps the old import when another call site still uses it', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile() {\n  return <div>Tile</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return (',
      '    <div>',
      '      <Card />',
      '      <Card />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 5, 8, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain("import { Card } from '../components/Card'")
    expect(text).toContain('<Card />')
  })
})

describe('swapComponentInstance — prop diffing', () => {
  it('removes props the new component does not accept and reports required props left unfilled', () => {
    write('components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div>{title}</div>',
      '}',
      '',
    ].join('\n'))
    write('components/Tile.tsx', [
      "export function Tile({ heading, subtitle }: { heading: string; subtitle: string }) {",
      '  return <div>{heading} — {subtitle}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.removedProps).toEqual(['title'])
      expect(result.unfilledRequiredProps).toEqual(['heading', 'subtitle'])
    }
    const text = read('pages/Home.tsx')
    expect(text).toContain('<Tile />')
    expect(text).not.toContain('title=')
  })

  it('keeps a prop the new component ALSO accepts', () => {
    write('components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div>{title}</div>',
      '}',
      '',
    ].join('\n'))
    write('components/Tile.tsx', [
      "export function Tile({ title }: { title: string }) {",
      '  return <div>{title}</div>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.removedProps).toEqual([])
      expect(result.unfilledRequiredProps).toEqual([])
    }
    expect(read('pages/Home.tsx')).toContain('<Tile title="Hi" />')
  })
})

describe('swapComponentInstance — refusals', () => {
  it('refuses when the new name would shadow an existing binding', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Tile.tsx', 'export function Tile() {\n  return <div>Tile</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      "const Tile = 'not a component'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = swapAt(pageFile, 4, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('name-shadow')
  })

  it('refuses a plain HTML element', () => {
    const pageFile = write('pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    const result = swapAt(pageFile, 2, 11, { newComponentName: 'Tile', newComponentSource: 'local', newComponentFile: 'components/Tile.tsx' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-a-component')
  })

  it('refuses swapping a component for itself', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))
    const result = swapAt(pageFile, 3, 11, { newComponentName: 'Card', newComponentSource: 'local', newComponentFile: 'components/Card.tsx' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('same-component')
  })
})
