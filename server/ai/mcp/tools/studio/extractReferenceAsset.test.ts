/**
 * studio_extract_reference_asset — its landing goes through the agent write
 * gate like every other agent image landing (`landAgentAsset`, P4-E).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import type { ToolContext } from '../../../runtime/types'
import { studioExtractReferenceAssetMcpTools } from './extractReferenceAsset'
import { registerDesignReference } from '../../../../handlers/studio/designReferenceStore'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'

const tool = studioExtractReferenceAssetMcpTools[0]!

function ctx(): ToolContext {
  return { db: {} as never, userId: 'u1', capabilities: [], conversationId: 'c1', snapshot: null, signal: new AbortController().signal }
}

let dir: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-extract-asset-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }))
  fs.mkdirSync(path.join(dir, 'pages'))
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() {\n  return <div>Home</div>\n}\n')
  const { pages } = await loadStudioPages(dir)
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer()
  const registered = await registerDesignReference(dir, new Uint8Array(png), { pageId: pages[0]!.id, role: 'spec' })
  expect(registered.ok).toBe(true)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('studio_extract_reference_asset — landing', () => {
  it('lands a crop and reports where the site serves it', async () => {
    const result = (await tool.handler!({ dir, page: 'Home', name: 'badge', x: 0, y: 0, width: 4, height: 4 }, ctx())) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ relPath: 'src/assets/badge.png', src: '/src/assets/badge.png', buildSafe: false })
    expect(fs.existsSync(path.join(dir, 'src/assets/badge.png'))).toBe(true)
  })

  it('refuses Studio\'s preview shell as a target folder, which the landing pipeline alone accepted', async () => {
    const result = (await tool.handler!({ dir, page: 'Home', name: 'badge', x: 0, y: 0, width: 4, height: 4, targetDir: 'prototype' }, ctx())) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.code).toBe('protected-path')
    // `prototype/` itself exists — loading the pages scaffolds Studio's shell there.
    expect(fs.existsSync(path.join(dir, 'prototype', 'badge.png'))).toBe(false)
  })
})
