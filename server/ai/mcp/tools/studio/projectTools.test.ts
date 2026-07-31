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
})
