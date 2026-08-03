/**
 * studio_register_design_reference / studio_list_design_references /
 * studio_read_design_reference / studio_delete_design_reference /
 * studio_recommend_export_dpr — handler coverage against a real temp project
 * directory and real sharp-encoded PNG bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { studioDesignReferenceMcpTools } from './designReferenceTools'

function tool(name: string) {
  const t = studioDesignReferenceMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-design-reference-tools-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function pngBase64(width: number, height: number): Promise<string> {
  const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 4, g: 5, b: 6, alpha: 1 } } })
    .png()
    .toBuffer()
  return bytes.toString('base64')
}

describe('tool shapes', () => {
  it('register and delete are mutating and gated; list/read/recommend are not', () => {
    expect(tool('studio_register_design_reference').mutates).toBe(true)
    expect(tool('studio_register_design_reference').requiredCapabilities).toEqual(['studio.write'])
    expect(tool('studio_delete_design_reference').mutates).toBe(true)
    expect(tool('studio_delete_design_reference').requiredCapabilities).toEqual(['studio.write'])
    expect(tool('studio_list_design_references').requiredCapabilities ?? []).toEqual([])
    expect(tool('studio_read_design_reference').requiredCapabilities ?? []).toEqual([])
    expect(tool('studio_recommend_export_dpr').requiredCapabilities ?? []).toEqual([])
    for (const name of ['studio_register_design_reference', 'studio_list_design_references', 'studio_read_design_reference', 'studio_delete_design_reference', 'studio_recommend_export_dpr']) {
      expect(tool(name).execution).toBe('server')
    }
  })
})

describe('studio_register_design_reference', () => {
  it('registers a real PNG from imageBase64', async () => {
    const imageBase64 = await pngBase64(20, 15)
    const result = await tool('studio_register_design_reference').handler!(
      { dir, imageBase64, pageId: 'src/screens/Home.tsx', label: 'Home' },
      {} as never,
    ) as { ok: boolean; reference: { id: string; width: number; height: number } }
    expect(result.ok).toBe(true)
    expect(result.reference.width).toBe(20)
    expect(result.reference.height).toBe(15)
  })

  it('refuses when both or neither of url/imageBase64 are given', async () => {
    const neither = await tool('studio_register_design_reference').handler!({ dir }, {} as never) as { ok: boolean; error?: string }
    expect(neither.ok).toBe(false)

    const both = await tool('studio_register_design_reference').handler!(
      { dir, url: 'https://example.com/x.png', imageBase64: 'AAAA' },
      {} as never,
    ) as { ok: boolean; error?: string }
    expect(both.ok).toBe(false)
  })
})

describe('studio_list_design_references / studio_read_design_reference / studio_delete_design_reference', () => {
  it('round-trips register -> list -> read (metadata only, then with image) -> delete', async () => {
    const imageBase64 = await pngBase64(8, 8)
    const registered = await tool('studio_register_design_reference').handler!(
      { dir, imageBase64, pageId: 'p1' },
      {} as never,
    ) as { reference: { id: string; mimeType: string } }
    const id = registered.reference.id

    const listed = await tool('studio_list_design_references').handler!({ dir }, {} as never) as {
      totalCount: number
      references: Array<{ id: string }>
    }
    expect(listed.totalCount).toBe(1)
    expect(listed.references[0]!.id).toBe(id)

    const readMeta = await tool('studio_read_design_reference').handler!({ dir, referenceId: id }, {} as never) as {
      ok: boolean
      data: { reference: { id: string } }
      images?: unknown[]
    }
    expect(readMeta.ok).toBe(true)
    expect(readMeta.data.reference.id).toBe(id)
    expect(readMeta.images ?? []).toEqual([])

    const readImage = await tool('studio_read_design_reference').handler!(
      { dir, referenceId: id, includeImage: true },
      {} as never,
    ) as { ok: boolean; images: Array<{ mimeType: string; data: string }> }
    expect(readImage.ok).toBe(true)
    expect(readImage.images.length).toBe(1)
    expect(readImage.images[0]!.mimeType).toBe('image/png')
    expect(readImage.images[0]!.data.length).toBeGreaterThan(0)

    const deleted = await tool('studio_delete_design_reference').handler!({ dir, referenceId: id }, {} as never) as { ok: boolean; removed: boolean }
    expect(deleted.ok).toBe(true)
    expect(deleted.removed).toBe(true)

    const afterDelete = await tool('studio_read_design_reference').handler!({ dir, referenceId: id }, {} as never) as { ok: boolean; error?: string }
    expect(afterDelete.ok).toBe(false)
  })

  it('studio_delete_design_reference is idempotent for an unknown id', async () => {
    const result = await tool('studio_delete_design_reference').handler!(
      { dir, referenceId: '11111111-1111-1111-1111-111111111111' },
      {} as never,
    ) as { ok: boolean; removed: boolean }
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(false)
  })
})

describe('studio_recommend_export_dpr', () => {
  function writeBoardsFile(frames: Array<{ pageId: string; width?: number; height?: number }>): void {
    const boardsDir = path.join(dir, '.studio')
    fs.mkdirSync(boardsDir, { recursive: true })
    fs.writeFileSync(
      path.join(boardsDir, 'boards.json'),
      JSON.stringify({
        version: 1,
        boards: [{ id: 'b1', name: 'Board 1', notes: [], docs: [], frames: frames.map((f, i) => ({ id: `f${i}`, x: 0, y: 0, ...f })) }],
      }),
    )
  }

  it('recommends an exact dpr match when the ratio is reachable', async () => {
    writeBoardsFile([{ pageId: 'src/screens/Home.tsx', width: 400 }])
    const registered = await tool('studio_register_design_reference').handler!(
      { dir, imageBase64: await pngBase64(800, 600), pageId: 'src/screens/Home.tsx' },
      {} as never,
    ) as { reference: { id: string } }

    const result = await tool('studio_recommend_export_dpr').handler!(
      { dir, pageId: 'src/screens/Home.tsx', referenceId: registered.reference.id },
      {} as never,
    ) as {
      ok: boolean
      recommendedDpr: number
      dprClamped: boolean
      exactWidthMatchExpected: boolean
      expectedCapturedWidth: number
    }
    expect(result.ok).toBe(true)
    expect(result.recommendedDpr).toBe(2)
    expect(result.dprClamped).toBe(false)
    expect(result.exactWidthMatchExpected).toBe(true)
    expect(result.expectedCapturedWidth).toBe(800)
  })

  it('flags dprClamped when the ideal ratio is outside 0.5-3', async () => {
    writeBoardsFile([{ pageId: 'p1', width: 200 }])
    const registered = await tool('studio_register_design_reference').handler!(
      { dir, imageBase64: await pngBase64(2000, 100), pageId: 'p1' },
      {} as never,
    ) as { reference: { id: string } }

    const result = await tool('studio_recommend_export_dpr').handler!(
      { dir, pageId: 'p1', referenceId: registered.reference.id },
      {} as never,
    ) as { ok: boolean; recommendedDpr: number; dprClamped: boolean; exactWidthMatchExpected: boolean; note?: string }
    expect(result.ok).toBe(true)
    expect(result.recommendedDpr).toBe(3)
    expect(result.dprClamped).toBe(true)
    expect(result.exactWidthMatchExpected).toBe(false)
    expect(result.note).toBeDefined()
  })

  it('errors clearly when the page has no board frame', async () => {
    writeBoardsFile([])
    const registered = await tool('studio_register_design_reference').handler!(
      { dir, imageBase64: await pngBase64(100, 100), pageId: 'p1' },
      {} as never,
    ) as { reference: { id: string } }

    const result = await tool('studio_recommend_export_dpr').handler!(
      { dir, pageId: 'does-not-exist', referenceId: registered.reference.id },
      {} as never,
    ) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does-not-exist')
  })
})
