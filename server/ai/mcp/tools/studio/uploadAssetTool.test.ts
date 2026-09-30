/**
 * studio_upload_asset — lands through the ONE agent image landing
 * (`landAgentAsset`), so it obeys the agent write gate like every other agent
 * landing (review of #248, F6). It used to be relayed to the browser, which
 * posted to the canvas's own upload route: that route serves the USER, so it
 * never asks the agent gate, and an agent could land files in Studio's
 * preview shell `prototype/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../../../runtime/types'
import { studioUploadAssetMcpTools } from './uploadAssetTool'

const tool = studioUploadAssetMcpTools[0]!

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-upload-asset-tool-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function ctx(): ToolContext {
  return {
    db: {} as never,
    userId: 'u1',
    capabilities: ['studio.write'],
    conversationId: 'c1',
    snapshot: null,
    signal: new AbortController().signal,
  }
}

async function upload(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  expect(tool.handler).toBeDefined()
  return (await tool.handler!({ dir, ...input }, ctx())) as Record<string, unknown>
}

/** Every file under `dir`, project-relative. */
function filesIn(root: string): string[] {
  const out: string[] = []
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const abs = path.join(at, entry.name)
      if (entry.isDirectory()) walk(abs)
      else out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

describe('studio_upload_asset — a server tool on the agent landing (F6)', () => {
  it('runs on the server, gated on studio.write, with no browser tab involved', () => {
    expect(tool.execution).toBe('server')
    expect(tool.requiresWrite).toBe(true)
    expect(tool.requiredCapabilities).toEqual(['studio.write'])
  })

  it('lands a PNG in src/assets by default', async () => {
    const result = await upload({ imageBase64: PNG_BASE64, mimeType: 'image/png' })
    expect(result.ok).toBe(true)
    expect(String(result.relPath)).toMatch(/^src\/assets\/upload(-\d+)?\.png$/)
    expect(fs.existsSync(path.join(dir, ...String(result.relPath).split('/')))).toBe(true)
  })

  for (const targetDir of ['prototype', 'Prototype', '.studio', '.git/hooks', '.husky', '.claude']) {
    it(`refuses targetDir "${targetDir}" through the agent write gate and writes nothing`, async () => {
      const result = await upload({ imageBase64: PNG_BASE64, mimeType: 'image/png', targetDir })
      expect(result.ok).toBe(false)
      expect(['protected-path', 'needs-user', 'path-outside-project']).toContain(String(result.code))
      expect(filesIn(dir)).toEqual([])
    })
  }

  it('refuses bytes that are not the declared type', async () => {
    const result = await upload({ imageBase64: PNG_BASE64, mimeType: 'image/jpeg' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
    expect(filesIn(dir)).toEqual([])
  })

  it('refuses text that is not base64 instead of decoding it leniently', async () => {
    const result = await upload({ imageBase64: '!!!not-base64!!!', mimeType: 'image/png' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })
})
