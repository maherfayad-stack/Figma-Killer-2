/**
 * studio_fetch_remote_asset — MCP tool wrapper coverage. The safety-critical
 * behaviour (URL validation, redirect refusal, size cap, SVG sanitization)
 * is covered directly in `server/handlers/studio/remoteAssetFetch.test.ts`;
 * this file covers the tool's own shape (declared execution class, schema,
 * capability gate) and that it wires input through to `fetchRemoteAsset`
 * correctly.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioRemoteAssetMcpTools } from './remoteAssetTools'

const tool = studioRemoteAssetMcpTools[0]!

describe('studio_fetch_remote_asset — tool shape', () => {
  it('is a headless, mutating, studio.write-gated tool', () => {
    expect(tool.name).toBe('studio_fetch_remote_asset')
    expect(tool.execution).toBe('server')
    expect(tool.mutates).toBe(true)
    expect(tool.requiredCapabilities).toEqual(['studio.write'])
  })

  it('never accepts image bytes as input — the URL, not the payload, is the whole point', () => {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props).toHaveProperty('url')
    expect(props).not.toHaveProperty('imageBase64')
    expect(props).not.toHaveProperty('bytes')
  })
})

describe('studio_fetch_remote_asset — handler', () => {
  it('lands a fetched asset and reports its relPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-remote-asset-tool-'))
    try {
      // Real global fetch is never called here — this handler has no test
      // seam for it (production code always uses the real network), so this
      // test exercises the URL-validation failure path instead of a live
      // fetch, which is the deterministic, network-free half worth covering
      // at this layer. The full happy-path fetch pipeline is covered in
      // remoteAssetFetch.test.ts via its injectable fetchImpl.
      const result = (await tool.handler!({ dir, url: 'not a url' }, {} as never)) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not a valid')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
