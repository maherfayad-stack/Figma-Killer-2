/**
 * `studio_import_project` — capability gating, the pure page-listing helper,
 * and an end-to-end handler run against a stubbed global `fetch` (no real
 * network calls). The handler forwards straight to `runGithubImport`, which
 * already has its own exhaustive unit tests
 * (`server/handlers/__tests__/studioGithubImport.test.ts`); this file only
 * covers the MCP-specific adapter surface: schema, capability gate, and the
 * imported-pages summary this tool adds on top.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { ToolContext } from '../../runtime/types'
import { mcpToolsForCapabilities } from '../registry'
import { listImportedPagePaths } from './studioImportTool'

function fakeCtx(): ToolContext {
  return {
    db: undefined as never, // unused by this tool's handler
    userId: 'u1',
    capabilities: ['ai.tools.write', 'site.structure.edit'],
    scope: 'site',
    conversationId: 'mcp:test',
    snapshot: null,
    signal: new AbortController().signal,
  }
}

describe('studio_import_project — capability gating', () => {
  it('is exposed to a connector with both ai.tools.write and site.structure.edit', () => {
    const tool = mcpToolsForCapabilities(['ai.tools.write', 'site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )
    expect(tool).toBeDefined()
    expect(tool?.execution).toBe('server')
    expect(tool?.mutates).toBe(true)
  })

  it('is hidden from a read-only connector (ai.tools.write missing)', () => {
    const tool = mcpToolsForCapabilities(['site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )
    expect(tool).toBeUndefined()
  })

  it('is hidden from a connector without site.structure.edit', () => {
    const tool = mcpToolsForCapabilities(['ai.tools.write']).find(
      (t) => t.name === 'studio_import_project',
    )
    expect(tool).toBeUndefined()
  })
})

describe('studio_import_project — input schema', () => {
  it('accepts url plus the optional ref/subdir/token fields', () => {
    const tool = mcpToolsForCapabilities(['ai.tools.write', 'site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )!
    const parsed = parseValue(tool.inputSchema, {
      url: 'https://github.com/acme/widgets',
      ref: 'main',
      subdir: 'apps/web',
      token: 'secret',
    })
    expect(parsed).toEqual({
      url: 'https://github.com/acme/widgets',
      ref: 'main',
      subdir: 'apps/web',
      token: 'secret',
    })
  })

  it('strips an unexpected dir field instead of forwarding it (defense in depth)', () => {
    const tool = mcpToolsForCapabilities(['ai.tools.write', 'site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )!
    const parsed = parseValue(tool.inputSchema, {
      url: 'https://github.com/acme/widgets',
      dir: '/etc',
    }) as Record<string, unknown>
    expect(parsed.dir).toBeUndefined()
    expect(parsed.url).toBe('https://github.com/acme/widgets')
  })
})

describe('listImportedPagePaths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-tool-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists discovered page files under pages/', () => {
    fs.mkdirSync(path.join(tmpDir, 'pages', 'marketing'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'pages', 'Home.tsx'), 'export default function Home() { return null }')
    fs.writeFileSync(
      path.join(tmpDir, 'pages', 'marketing', 'Landing.tsx'),
      'export default function Landing() { return null }',
    )

    expect(listImportedPagePaths(tmpDir)).toEqual(['marketing/Landing.tsx', 'Home.tsx'].sort())
  })

  it('returns an empty list when there is no pages/ directory', () => {
    expect(listImportedPagePaths(tmpDir)).toEqual([])
  })
})

/** Builds a fake GitHub-shaped zipball: everything nested under one root folder. */
function buildFakeZipball(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {}
  for (const [relPath, contents] of Object.entries(files)) {
    input[`acme-mcp-import-abcdef1/${relPath}`] = strToU8(contents)
  }
  return zipSync(input)
}

function fakeZipResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
}

describe('studio_import_project — handler', () => {
  const originalFetch = globalThis.fetch
  const createdDirs: string[] = []

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports a repo and summarizes the discovered pages, without ever exposing dir as an input', async () => {
    const zip = buildFakeZipball({
      'pages/Home.tsx': 'export default function Home() { return null }',
      'package.json': '{}',
    })
    let requestedHeaders: Record<string, string> | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      requestedHeaders = init?.headers as Record<string, string>
      return fakeZipResponse(zip)
    }) as typeof fetch

    const owner = 'mcp-import-test-owner'
    const repo = `widgets-${Date.now()}`
    const tool = mcpToolsForCapabilities(['ai.tools.write', 'site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )!
    const result = (await tool.handler!(
      { url: `https://github.com/${owner}/${repo}`, token: 'secret-token' },
      fakeCtx(),
    )) as { dir: string; files: number; skipped: number; pageCount: number; pages: string[] }

    createdDirs.push(result.dir)

    expect(requestedHeaders?.authorization).toBe('Bearer secret-token')
    expect(result.dir.split(path.sep).join('/')).toContain(`studio-workspace-imports/${owner}-${repo}`)
    expect(result.files).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.pageCount).toBe(1)
    expect(result.pages).toEqual(['Home.tsx'])
    // The result never carries the token back to the caller.
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('surfaces GithubImportError as a thrown error carrying its message', async () => {
    const tool = mcpToolsForCapabilities(['ai.tools.write', 'site.structure.edit']).find(
      (t) => t.name === 'studio_import_project',
    )!

    await expect(
      tool.handler!({ url: 'not-a-url' }, fakeCtx()),
    ).rejects.toThrow(/Not a valid GitHub repository URL/)
  })
})
