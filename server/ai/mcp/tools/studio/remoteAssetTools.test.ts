/**
 * studio_fetch_remote_asset — the tool layer. The transport's safety (URL
 * validation, SSRF, redirects, size, deadline, content type) is covered in
 * `server/handlers/studio/remoteAssetFetch.test.ts`; this file covers what the
 * TOOL adds on top: the host policy (P4-E, security review of #233 F8) and the
 * agent write gate on the landing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../../../runtime/types'
import { fetchRemoteAssetForAgent, studioRemoteAssetMcpTools } from './remoteAssetTools'
import type { FetchRemoteAssetDeps } from '../../../../handlers/studio/remoteAssetFetch'

const tool = studioRemoteAssetMcpTools[0]!

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-remote-asset-tool-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as never,
    userId: 'u1',
    capabilities: [],
    conversationId: 'c1',
    snapshot: null,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A fake transport that records every URL it was asked for. */
function recordingDeps(calls: string[]): FetchRemoteAssetDeps {
  return {
    allowLoopback: false,
    resolveHostAddresses: async () => ['93.184.216.34'],
    fetchImpl: (async (input: string | URL) => {
      calls.push(String(input))
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch,
  }
}

describe('studio_fetch_remote_asset — tool shape', () => {
  it('is a headless, mutating, studio.write-gated tool', () => {
    expect(tool.name).toBe('studio_fetch_remote_asset')
    expect(tool.execution).toBe('server')
    expect(tool.requiresWrite).toBe(true)
    expect(tool.sideEffects).toBe('write')
    expect(tool.requiredCapabilities).toEqual(['studio.write'])
    expect(tool.description.length).toBeLessThanOrEqual(900)
  })

  it('never accepts image bytes as input — the URL, not the payload, is the whole point', () => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props).toHaveProperty('url')
    expect(props).not.toHaveProperty('imageBase64')
    expect(props).not.toHaveProperty('bytes')
  })
})

describe('studio_fetch_remote_asset — which hosts an agent may name (F8)', () => {
  it('refuses a host nothing vouched for, and makes no request at all', async () => {
    const calls: string[] = []
    const result = await fetchRemoteAssetForAgent(
      { dir, url: 'https://collect.example/pixel.png?d=the-env-file' },
      ctx(),
      recordingDeps(calls),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('host-not-allowed')
    expect(calls).toEqual([])
    expect(fs.existsSync(path.join(dir, 'src/assets'))).toBe(false)
  })

  it('fetches a URL the user pasted into the conversation', async () => {
    const calls: string[] = []
    const url = 'https://brand.example/logo.png'
    const result = await fetchRemoteAssetForAgent({ dir, url }, ctx({ userSuppliedUrls: [url] }), recordingDeps(calls))
    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('src/assets/logo.png')
    expect(calls).toHaveLength(1)
    expect(fs.existsSync(path.join(dir, 'src/assets/logo.png'))).toBe(true)
  })

  it('fetches a Figma asset URL without the user having pasted it', async () => {
    const calls: string[] = []
    const result = await fetchRemoteAssetForAgent({ dir, url: 'https://www.figma.com/api/mcp/asset/abc' }, ctx(), recordingDeps(calls))
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('an unparseable URL still gets the transport\'s own refusal', async () => {
    const result = await fetchRemoteAssetForAgent({ dir, url: 'not a url' }, ctx(), recordingDeps([]))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('remote-fetch-failed')
    expect(String(result.error)).toContain('not a valid')
  })
})

describe('studio_fetch_remote_asset — the landing goes through the agent write gate', () => {
  it('refuses Studio\'s preview shell as a target folder, which the landing pipeline alone accepted', async () => {
    const url = 'https://brand.example/logo.png'
    const result = await fetchRemoteAssetForAgent({ dir, url, targetDir: 'prototype' }, ctx({ userSuppliedUrls: [url] }), recordingDeps([]))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('protected-path')
    expect(fs.existsSync(path.join(dir, 'prototype'))).toBe(false)
  })

  it.each(['.husky', '.vscode', '.github/workflows'])('refuses a host-executed folder as a target: %s (review of #248, finding 7)', async (targetDir) => {
    const url = 'https://brand.example/logo.png'
    const result = await fetchRemoteAssetForAgent({ dir, url, targetDir }, ctx({ userSuppliedUrls: [url] }), recordingDeps([]))
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, ...targetDir.split('/')))).toBe(false)
  })

  it('refuses .studio/ as a target folder', async () => {
    const url = 'https://brand.example/logo.png'
    const result = await fetchRemoteAssetForAgent({ dir, url, targetDir: '.studio/x' }, ctx({ userSuppliedUrls: [url] }), recordingDeps([]))
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, '.studio'))).toBe(false)
  })

  it('reports the site URL a public/ landing is served at', async () => {
    const url = 'https://brand.example/hero image.png'
    const normalized = new URL(url).href
    const result = await fetchRemoteAssetForAgent({ dir, url, targetDir: 'public/img' }, ctx({ userSuppliedUrls: [normalized] }), recordingDeps([]))
    expect(result.ok).toBe(true)
    expect(result.relPath).toBe('public/img/hero-20image.png')
    expect(result.src).toBe('/img/hero-20image.png')
    expect(result.buildSafe).toBe(true)
  })
})
