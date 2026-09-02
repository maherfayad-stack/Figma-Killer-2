import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBoardsFile, serializeBoardsFile, upsertFrame } from '@core/studio-board'
import { studioEditMcpTools } from './editTools'
import { mcpToolsForCapabilities } from '../../registry'

function tool(name: string) {
  const t = studioEditMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('studio edit MCP tools — capability gating', () => {
  it('studio_apply_edits/studio_set_frames/studio_codemod all require studio.write + ai.tools.write', () => {
    for (const name of ['studio_apply_edits', 'studio_set_frames', 'studio_codemod']) {
      const withCaps = mcpToolsForCapabilities(['ai.tools.write', 'studio.write']).find((t) => t.name === name)
      expect(withCaps).toBeDefined()
      const withoutStudioWrite = mcpToolsForCapabilities(['ai.tools.write']).find((t) => t.name === name)
      expect(withoutStudioWrite).toBeUndefined()
      const withoutToolsWrite = mcpToolsForCapabilities(['studio.write']).find((t) => t.name === name)
      expect(withoutToolsWrite).toBeUndefined()
    }
  })
})

describe('studio_apply_edits', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-edit-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a prop edit through the shared batch engine and reports written/skipped', async () => {
    write(tmpDir, 'pages/Home.tsx', ['export default function Home() {', '  return <Button label="Old" />', '}', ''].join('\n'))

    const result = (await tool('studio_apply_edits').handler!(
      {
        dir: tmpDir,
        edits: [{ kind: 'prop', nodeId: 'pages/Home.tsx:2:11', prop: 'label', value: 'New' }],
      },
      {} as never,
    )) as { ok: boolean; written: number; skipped: number; pageIds: string[] }

    expect(result.ok).toBe(true)
    expect(result.written).toBe(1)
    expect(result.skipped).toBe(0)
    // mcp-tooling — the touched-file-to-pageId mapping the live-reload push
    // reports alongside the batch result.
    expect(result.pageIds).toEqual(['home'])
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')).toContain('label="New"')
  })

  it('counts a synthetic node id as skipped, not written', async () => {
    const result = (await tool('studio_apply_edits').handler!(
      { dir: tmpDir, edits: [{ kind: 'prop', nodeId: 'home:body', prop: 'x', value: 'y' }] },
      {} as never,
    )) as { written: number; skipped: number }
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(1)
  })
})

describe('studio_set_frames', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-frames-'))
    const boards = upsertFrame(
      { id: 'b1', name: 'Board', frames: [], notes: [], docs: [] },
      { pageId: 'home', x: 0, y: 0, width: 400, height: 800 },
    )
    const file = createBoardsFile()
    file.boards.push(boards)
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.studio', 'boards.json'), serializeBoardsFile(file))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resizes a targeted frame and leaves others alone', async () => {
    const result = (await tool('studio_set_frames').handler!(
      { dir: tmpDir, pageIds: ['home'], width: 600, height: 900 },
      {} as never,
    )) as { ok: boolean; resized: number; missing: string[]; pageIds: string[] }
    expect(result.ok).toBe(true)
    expect(result.resized).toBe(1)
    expect(result.missing).toEqual([])
    expect(result.pageIds).toEqual(['home'])

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8'))
    expect(written.boards[0].frames[0].width).toBe(600)
    expect(written.boards[0].frames[0].height).toBe(900)
  })

  it('reports a requested pageId with no existing frame as missing, without creating one', async () => {
    const result = (await tool('studio_set_frames').handler!(
      { dir: tmpDir, pageIds: ['nonexistent'], width: 600, height: 900 },
      {} as never,
    )) as { resized: number; missing: string[] }
    expect(result.resized).toBe(0)
    expect(result.missing).toEqual(['nonexistent'])
  })
})

describe('studio_codemod', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-codemod-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rename-tag renames the element via setJsxTagName', async () => {
    write(tmpDir, 'pages/Home.tsx', ['export default function Home() {', '  return <div>Hi</div>', '}', ''].join('\n'))
    const result = (await tool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'rename-tag', nodeId: 'pages/Home.tsx:2:11', tag: 'section' },
      {} as never,
    )) as { ok: boolean; pageIds: string[] }
    expect(result.ok).toBe(true)
    expect(result.pageIds).toEqual(['home'])
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')).toContain('<section>Hi</section>')
  })

  it('detach inlines a local component call site, reports shifted:true', async () => {
    write(tmpDir, 'components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div className="card">{title}</div>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n'))

    const result = (await tool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'detach', nodeId: 'pages/Home.tsx:3:11' },
      {} as never,
    )) as { ok: boolean; shifted?: boolean }
    expect(result.ok).toBe(true)
    expect(result.shifted).toBe(true)
    // Substituted as a JSX expression container holding the call site's own
    // string-literal text (`{"Hi"}`), not a bare text child — every
    // substitution `buildInlinedJsxText` makes is wrapped in `{…}` uniformly
    // (see its doc comment); React renders the two identically.
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')).toContain('<div className="card">{"Hi"}</div>')
  })

  it('detach refuses a component that uses a hook, with a specific reason', async () => {
    write(tmpDir, 'components/Counter.tsx', [
      "import { useState } from 'react'",
      'export function Counter() {',
      '  const [n] = useState(0)',
      '  return <span>{n}</span>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'pages/Home.tsx', [
      "import { Counter } from '../components/Counter'",
      'export default function Home() {',
      '  return <Counter />',
      '}',
      '',
    ].join('\n'))

    const result = (await tool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'detach', nodeId: 'pages/Home.tsx:3:11' },
      {} as never,
    )) as { ok: boolean; code: string; reason: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('refused')
    expect(result.reason).toBe('uses-hooks')
  })

  it('extract-component duplicates the component and repoints just this call site', async () => {
    write(tmpDir, 'components/Counter.tsx', [
      "import { useState } from 'react'",
      'export function Counter() {',
      '  const [n] = useState(0)',
      '  return <span>{n}</span>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'pages/Home.tsx', [
      "import { Counter } from '../components/Counter'",
      'export default function Home() {',
      '  return <Counter />',
      '}',
      '',
    ].join('\n'))

    const result = (await tool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'extract-component', nodeId: 'pages/Home.tsx:3:11' },
      {} as never,
    )) as { ok: boolean; newFile: string; newComponentName: string }
    expect(result.ok).toBe(true)
    expect(result.newComponentName).toBe('Counter2')
    expect(fs.existsSync(path.join(tmpDir, 'components', 'Counter2.tsx'))).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')).toContain('<Counter2 />')
  })

  it('swap renames the tag, repoints the import, and reports removed/unfilled props', async () => {
    write(tmpDir, 'components/Card.tsx', [
      "export function Card({ title }: { title: string }) {",
      '  return <div className="card">{title}</div>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'components/Tile.tsx', [
      "export function Tile({ heading, subtitle }: { heading: string; subtitle: string }) {",
      '  return <div className="tile">{heading} — {subtitle}</div>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card title="Hi" />',
      '}',
      '',
    ].join('\n'))

    const result = (await tool('studio_codemod').handler!(
      {
        dir: tmpDir,
        verb: 'swap',
        nodeId: 'pages/Home.tsx:3:11',
        newComponentName: 'Tile',
        newComponentSource: 'local',
        newComponentFile: 'components/Tile.tsx',
      },
      {} as never,
    )) as { ok: boolean; removedProps: string[]; unfilledRequiredProps: string[] }
    expect(result.ok).toBe(true)
    expect(result.removedProps).toEqual(['title'])
    expect(result.unfilledRequiredProps).toEqual(['heading', 'subtitle'])
    const text = fs.readFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'utf8')
    expect(text).toContain('<Tile />')
    expect(text).toContain("import { Tile } from '../components/Tile'")
  })

  it('swap refuses when the new name would shadow an existing binding', async () => {
    write(tmpDir, 'components/Card.tsx', [
      'export function Card() {',
      '  return <div>Card</div>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'components/Tile.tsx', [
      'export function Tile() {',
      '  return <div>Tile</div>',
      '}',
      '',
    ].join('\n'))
    write(tmpDir, 'pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      "const Tile = 'not a component'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = (await tool('studio_codemod').handler!(
      {
        dir: tmpDir,
        verb: 'swap',
        nodeId: 'pages/Home.tsx:4:11',
        newComponentName: 'Tile',
        newComponentSource: 'local',
        newComponentFile: 'components/Tile.tsx',
      },
      {} as never,
    )) as { ok: boolean; code: string; reason: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('refused')
    expect(result.reason).toBe('name-shadow')
  })
})
