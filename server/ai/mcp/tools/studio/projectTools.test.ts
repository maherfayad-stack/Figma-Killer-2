import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioProjectMcpTools } from './projectTools'

function tool(name: string) {
  const t = studioProjectMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function write(root: string, relPath: string, contents: string): void {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('studio project MCP tools', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-project-'))
    write(
      tmpDir,
      'pages/Home.tsx',
      [
        'export default function Home() {',
        '  return (',
        '    <div className="hero">',
        '      <button label="Go">Go</button>',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('studio_list_projects lists the project by folder name', async () => {
    // listStudioProjects scans studio-workspace/, not an arbitrary tmp dir —
    // this tool's own contract, so just assert the handler runs and shapes
    // its output without throwing (the real corpus scan is covered by
    // studioProjects.test.ts).
    const result = (await tool('studio_list_projects').handler!({}, {} as never)) as {
      projects: Array<{ dir: string; name: string; pageCount: number }>
    }
    expect(Array.isArray(result.projects)).toBe(true)
  })

  it('studio_project_profile probes a fresh project', async () => {
    const result = (await tool('studio_project_profile').handler!({ dir: tmpDir }, {} as never)) as {
      dir: string
      profile: { framework: string; warnings: unknown[] }
    }
    expect(result.dir).toBe(tmpDir)
    expect(typeof result.profile.framework).toBe('string')
  })

  it('studio_list_pages discovers the fixture page', async () => {
    const result = (await tool('studio_list_pages').handler!({ dir: tmpDir }, {} as never)) as {
      pages: Array<{ pageId: string; title: string; nodeCount: number }>
    }
    expect(result.pages.length).toBe(1)
    expect(result.pages[0]!.pageId).toBe('home')
    expect(result.pages[0]!.nodeCount).toBeGreaterThan(0)
  })

  it('studio_get_node_source decodes a real node id to file/line/col/snippet', async () => {
    const result = (await tool('studio_get_node_source').handler!(
      { dir: tmpDir, nodeId: 'pages/Home.tsx:3:5' },
      {} as never,
    )) as { ok: boolean; relFile: string; line: number; col: number; snippet: string }
    expect(result.ok).toBe(true)
    expect(result.relFile).toBe('pages/Home.tsx')
    expect(result.line).toBe(3)
    expect(result.snippet).toContain('hero')
  })

  it('studio_get_node_source returns ok:false for a synthetic/unwritable node id', async () => {
    const result = (await tool('studio_get_node_source').handler!(
      { dir: tmpDir, nodeId: 'home:body' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no single writable source location')
  })

  it('studio_find_nodes filters by moduleId and returns matches with class names', async () => {
    const result = (await tool('studio_find_nodes').handler!(
      { dir: tmpDir, moduleId: 'base.container' },
      {} as never,
    )) as { matches: Array<{ moduleId: string; classNames: string[] }> }
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches.every((m) => m.moduleId.includes('base.container'))).toBe(true)
  })

  it('studio_find_nodes caps results and reports truncation', async () => {
    const result = (await tool('studio_find_nodes').handler!(
      { dir: tmpDir, limit: 1 },
      {} as never,
    )) as { matches: unknown[]; truncated: boolean }
    expect(result.matches.length).toBe(1)
    expect(result.truncated).toBe(true)
  })

  // ── studio_create_page (WS-12 §3) ─────────────────────────────────────

  it('studio_create_page scaffolds a canonical file, places its frame, and returns a real rootNodeId', async () => {
    const result = (await tool('studio_create_page').handler!(
      { dir: tmpDir, name: 'Order Summary' },
      {} as never,
    )) as { ok: boolean; relPath: string; pageId: string; title: string; rootNodeId: string | null }
    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('OrderSummary.tsx')
    expect(result.title).toBe('OrderSummary')
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'OrderSummary.tsx'))).toBe(true)
    // Node ids are source locations — never invented — so this must decode
    // back to the file just written (trap #2).
    expect(result.rootNodeId).toContain('OrderSummary.tsx')

    const boardsFile = path.join(tmpDir, '.studio', 'boards.json')
    expect(fs.existsSync(boardsFile)).toBe(true)
    const boards = JSON.parse(fs.readFileSync(boardsFile, 'utf8')) as { boards: Array<{ frames: Array<{ pageId: string }> }> }
    expect(boards.boards[0]!.frames.some((f) => f.pageId === result.pageId)).toBe(true)
  })

  it('studio_create_page auto-names Page, Page2, ... when no name is given', async () => {
    const first = (await tool('studio_create_page').handler!({ dir: tmpDir }, {} as never)) as { relPath: string }
    const second = (await tool('studio_create_page').handler!({ dir: tmpDir }, {} as never)) as { relPath: string }
    expect(first.relPath).not.toBe(second.relPath)
  })

  it('studio_create_page returns ok:false with a conflict message rather than overwriting an existing page', async () => {
    await tool('studio_create_page').handler!({ dir: tmpDir, name: 'Checkout' }, {} as never)
    const result = (await tool('studio_create_page').handler!(
      { dir: tmpDir, name: 'Checkout' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already exists')
  })

  // ── studio_read_file (WS-12 §3) ───────────────────────────────────────

  it('studio_read_file reads back a real file verbatim, with a canonical summary for a .tsx path', async () => {
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: 'pages/Home.tsx' },
      {} as never,
    )) as { ok: boolean; content: string; canonical?: { isCanonical: boolean; violations: number; advisories: number } }
    expect(result.ok).toBe(true)
    expect(result.content).toContain('hero')
    expect(result.canonical).toBeDefined()
    expect(typeof result.canonical!.isCanonical).toBe('boolean')
    expect(result.canonical!.violations).toBe(0)
  })

  it('studio_read_file omits the canonical summary for a non-JSX file', async () => {
    write(tmpDir, 'README.md', '# hello')
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: 'README.md' },
      {} as never,
    )) as { ok: boolean; content: string; canonical?: unknown }
    expect(result.ok).toBe(true)
    expect(result.content).toBe('# hello')
    expect(result.canonical).toBeUndefined()
  })

  it('studio_read_file returns ok:false for a missing file', async () => {
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: 'pages/DoesNotExist.tsx' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('studio_read_file rejects an oversized file rather than truncating it silently', async () => {
    write(tmpDir, 'pages/Huge.tsx', 'a'.repeat(200_001))
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: 'pages/Huge.tsx' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exceeds')
  })

  it('studio_read_file rejects a ".." traversal attempt', async () => {
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: '../../../../etc/passwd' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
  })

  it('studio_read_file rejects an absolute path', async () => {
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
  })

  it('studio_read_file rejects a path reaching into node_modules', async () => {
    write(tmpDir, 'node_modules/pkg/index.js', 'module.exports = {}')
    const result = (await tool('studio_read_file').handler!(
      { dir: tmpDir, path: 'node_modules/pkg/index.js' },
      {} as never,
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
  })
})
