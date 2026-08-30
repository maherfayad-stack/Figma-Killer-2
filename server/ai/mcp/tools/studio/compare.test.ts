/**
 * studio_compare — handler-level tests for the pieces mcp-tooling's compare
 * fix touched: dpr selection (`captureDprFor`), the `purpose: 'measurement'`
 * capture request (FIX 2), `imageScale` threading into the node-id mapping
 * (FIX 1), pass/verdict composition, plural-page batching (CHANGE A) and the
 * verdict cache (CHANGE B).
 *
 * No real browser is involved — `awaitEditorBridgeForUser` and
 * `awaitStudioLiveReload` are mocked at the module boundary with the EXACT
 * relative specifier `compare.ts` itself imports (same technique as
 * `useDesignReferenceAttachment.test.ts`). Everything else — page/board
 * loading, design-reference registration, `reconcileReference`,
 * `computeFrameDiff`, the verdict cache — runs for real against a temp
 * project directory, so this exercises the actual dpr math, diff engine and
 * mtime-based invalidation, not a re-description of them.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { parseBoardsFile, serializeBoardsFile, upsertFrame } from '@core/studio-board'
import { createScaffoldedPage } from '../../../../handlers/studio/pageScaffold'
import { registerDesignReference } from '../../../../handlers/studio/designReferenceStore'
import type { AiBrowserBridge } from '../../../runtime/types'
import type { AiToolOutput } from '@core/ai'
import { clearCompareVerdictCache } from './compareVerdictCache'

let bridgeCalls: Array<{ toolName: string; input: unknown }> = []
let bridgeImpl: ((toolName: string, input: unknown) => Promise<AiToolOutput>) | null = null

mock.module('../../editorBridge', () => ({
  awaitEditorBridgeForUser: async (): Promise<AiBrowserBridge | null> => {
    if (!bridgeImpl) return null
    return {
      callBrowser: async (toolName: string, input: unknown) => {
        bridgeCalls.push({ toolName, input })
        return bridgeImpl!(toolName, input)
      },
    }
  },
}))

mock.module('./liveReloadPush', () => ({
  awaitStudioLiveReload: async () => {},
}))

const { studioCompareTool } = await import('./compare')

function solidPng(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0]
    png.data[i + 1] = rgb[1]
    png.data[i + 2] = rgb[2]
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

function pngWithBlock(width: number, height: number, block: { x: number; y: number; w: number; h: number }): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255
    png.data[i + 1] = 255
    png.data[i + 2] = 255
    png.data[i + 3] = 255
  }
  for (let y = block.y; y < block.y + block.h; y++) {
    for (let x = block.x; x < block.x + block.w; x++) {
      const idx = (y * width + x) * 4
      png.data[idx] = 255
      png.data[idx + 1] = 0
      png.data[idx + 2] = 0
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-compare-'))
  bridgeCalls = []
  bridgeImpl = null
  clearCompareVerdictCache()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Scaffolds a page and sets its board frame's AUTHORED (CSS px) size. */
function scaffoldPageAt(name: string, width: number, height: number): string {
  const scaffolded = createScaffoldedPage(dir, name)
  if (!scaffolded.ok) throw new Error(scaffolded.conflict)
  const boardsPath = path.join(dir, '.studio', 'boards.json')
  const boardsFile = parseBoardsFile(fs.readFileSync(boardsPath, 'utf8'))
  const board = boardsFile.boards[0]!
  const frame = board.frames.find((f) => f.pageId === scaffolded.pageId)!
  const updatedBoard = upsertFrame(board, { id: frame.id, pageId: frame.pageId, x: frame.x, y: frame.y, width, height })
  const updatedFile = { ...boardsFile, boards: boardsFile.boards.map((b) => (b.id === board.id ? updatedBoard : b)) }
  fs.writeFileSync(boardsPath, serializeBoardsFile(updatedFile))
  return scaffolded.pageId
}

function ctx(): Parameters<NonNullable<typeof studioCompareTool.handler>>[1] {
  return { userId: 'u1', signal: new AbortController().signal } as unknown as Parameters<NonNullable<typeof studioCompareTool.handler>>[1]
}

interface PageResult {
  ok: boolean
  page?: { id: string; title: string }
  fromCache?: boolean
  pass?: boolean
  similarityScore?: number
  capture?: { dimensionMatch: string; dpr: number }
  regions?: Array<{ nodeIds: string[] }>
  worstRegionNodeIds?: string[]
  structuralRegionCount?: number
  verdict?: string
  error?: string
}

interface CompareData {
  pass: boolean
  passCount: number
  failCount: number
  errorCount: number
  results: PageResult[]
  unmatched?: string[]
}

describe('studio_compare — dpr selection + purpose threading', () => {
  it('requests dpr:2 and purpose:"measurement" for a 390x844 mobile frame against a 780x1688 (2x) reference, and reports an EXACT-pixel match', async () => {
    const pageId = scaffoldPageAt('Checkout', 390, 844)
    const referenceBytes = solidPng(780, 1688)
    const registered = await registerDesignReference(dir, new Uint8Array(referenceBytes), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async (_toolName, input) => {
      const req = input as { dpr?: number; purpose?: string }
      // Assert BEFORE returning — this is the actual dpr/purpose the browser
      // capture would have received.
      expect(req.dpr).toBe(2)
      expect(req.purpose).toBe('measurement')
      const baseline = solidPng(780, 1688)
      return {
        ok: true,
        data: {
          frames: [
            {
              pageId,
              ok: true,
              width: 780,
              height: 1688,
              imageIndex: 0,
              nodeRects: [{ nodeId: 'hero', x: 0, y: 0, width: 390, height: 200 }],
              imageScale: 2,
              warnings: [],
            },
          ],
        },
        images: [{ mimeType: 'image/png', data: baseline.toString('base64') }],
      }
    }

    const result = (await studioCompareTool.handler!({ dir, pages: ['Checkout'], includeImages: false }, ctx())) as {
      ok: boolean
      data?: CompareData
    }

    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.toolName).toBe('studio_export_frames')

    expect(result.ok).toBe(true)
    const data = result.data!
    const page = data.results[0]!
    expect(page.capture!.dimensionMatch).toBe('exact')
    expect(page.capture!.dpr).toBe(2)
    expect(page.similarityScore).toBe(100)
    expect(page.pass).toBe(true)
    expect(page.fromCache).toBe(false)
    expect(data.pass).toBe(true)
  })

  it('maps the worst region back to the right node id using the capture\'s imageScale — not the unscaled CSS-px rect', async () => {
    const pageId = scaffoldPageAt('Landing', 200, 200)
    const referenceBytes = solidPng(400, 400)
    const registered = await registerDesignReference(dir, new Uint8Array(referenceBytes), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async () => {
      // Baseline differs from the reference in the LOWER-RIGHT quadrant of
      // image space, (290,290)-(350,350) — inside CSS-px node rect
      // (140,140)-(180,180) ("bottom-right-card") at imageScale:2, and large
      // enough (2.25% of the frame) to be a structural region.
      const baseline = pngWithBlock(400, 400, { x: 290, y: 290, w: 60, h: 60 })
      return {
        ok: true,
        data: {
          frames: [
            {
              pageId,
              ok: true,
              width: 400,
              height: 400,
              imageIndex: 0,
              nodeRects: [
                { nodeId: 'top-left-card', x: 0, y: 0, width: 100, height: 100 },
                { nodeId: 'bottom-right-card', x: 140, y: 140, width: 40, height: 40 },
              ],
              imageScale: 2,
              warnings: [],
            },
          ],
        },
        images: [{ mimeType: 'image/png', data: baseline.toString('base64') }],
      }
    }

    const result = (await studioCompareTool.handler!(
      { dir, pages: ['Landing'], includeImages: false },
      ctx(),
    )) as { ok: boolean; data: CompareData }

    expect(result.ok).toBe(true)
    const page = result.data.results[0]!
    expect(page.pass).toBe(false)
    expect(page.worstRegionNodeIds).toContain('bottom-right-card')
    expect(page.worstRegionNodeIds).not.toContain('top-left-card')
  })

  it('fails a screen whose diff is concentrated in one large region, and passes a near-identical one after forceRecapture — pass/verdict gating', async () => {
    const pageId = scaffoldPageAt('Pricing', 100, 100)
    const referenceBytes = solidPng(100, 100)
    const registered = await registerDesignReference(dir, new Uint8Array(referenceBytes), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    // A 40x40 block on a 100x100 frame = 16% of the frame — well past the
    // default 1.5% structural-region floor.
    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [
          {
            pageId,
            ok: true,
            width: 100,
            height: 100,
            imageIndex: 0,
            nodeRects: [],
            imageScale: 1,
            warnings: [],
          },
        ],
      },
      images: [{ mimeType: 'image/png', data: pngWithBlock(100, 100, { x: 10, y: 10, w: 40, h: 40 }).toString('base64') }],
    })

    const failing = (await studioCompareTool.handler!(
      { dir, pages: ['Pricing'], includeImages: false },
      ctx(),
    )) as { ok: boolean; data: CompareData }
    expect(failing.ok).toBe(true)
    const failingPage = failing.data.results[0]!
    expect(failingPage.pass).toBe(false)
    expect(failingPage.structuralRegionCount).toBeGreaterThan(0)
    expect(failingPage.verdict).toContain('structural')

    // Same page, this time an identical capture — but nothing tracked by the
    // cache actually changed, so this MUST pass forceRecapture to see it;
    // without it the cached (failing) verdict from above would still win.
    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [
          { pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] },
        ],
      },
      images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
    })
    const passing = (await studioCompareTool.handler!(
      { dir, pages: ['Pricing'], includeImages: false, forceRecapture: true },
      ctx(),
    )) as { ok: boolean; data: CompareData }
    expect(passing.ok).toBe(true)
    expect(passing.data.results[0]!.pass).toBe(true)
  })
})

describe('studio_compare — batching (CHANGE A)', () => {
  it('one page failing to capture does not fail the batch — the other page still gets measured, and the aggregate is honest', async () => {
    const pageIdA = scaffoldPageAt('Alpha', 100, 100)
    const pageIdB = scaffoldPageAt('Beta', 100, 100)
    // Both scoped to their OWN page — `resolveDesignReference` would
    // otherwise fall back to "the most recent reference in the project" for
    // a page with none of its own, masking the failure this test wants.
    for (const pageId of [pageIdA, pageIdB]) {
      const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
      if (!registered.ok) throw new Error(registered.error)
    }

    // Beta's frame fails to render; Alpha's succeeds — a per-page capture
    // failure, not a reference-resolution failure.
    bridgeImpl = async (_toolName, input) => {
      const { pageIds } = input as { pageIds: string[] }
      const pageId = pageIds[0]!
      if (pageId === pageIdB) {
        return { ok: true, data: { frames: [{ pageId, ok: false, error: 'frame not on board' }] } }
      }
      return {
        ok: true,
        data: {
          frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
        },
        images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
      }
    }

    const result = (await studioCompareTool.handler!(
      { dir, pages: ['Alpha', 'Beta'], includeImages: false },
      ctx(),
    )) as { ok: boolean; data: CompareData }

    expect(result.ok).toBe(true)
    expect(result.data.results).toHaveLength(2)
    const alpha = result.data.results.find((r) => r.page?.title === 'Alpha')!
    const beta = result.data.results.find((r) => r.page?.title === 'Beta')!
    expect(alpha.ok).toBe(true)
    expect(alpha.pass).toBe(true)
    expect(beta.ok).toBe(false)
    expect(beta.error).toBeDefined()

    // Honest aggregate: one page could not be evaluated, so the top-level
    // verdict is NOT a silent pass even though the one measured page passed.
    expect(result.data.pass).toBe(false)
    expect(result.data.passCount).toBe(1)
    expect(result.data.errorCount).toBe(1)
  })

  it('a name that matches no screen at all lands in unmatched, not results, and still drags the aggregate down', async () => {
    const pageId = scaffoldPageAt('Alpha', 100, 100)
    const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
      },
      images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
    })

    const result = (await studioCompareTool.handler!(
      { dir, pages: ['Alpha', 'DoesNotExist'], includeImages: false },
      ctx(),
    )) as { ok: boolean; data: CompareData }

    expect(result.ok).toBe(true)
    expect(result.data.results).toHaveLength(1)
    expect(result.data.unmatched).toEqual(['DoesNotExist'])
    expect(result.data.pass).toBe(false)
  })

  it('defaults includeImages to true for one page and to false for more than one', async () => {
    const pageIdA = scaffoldPageAt('Alpha', 100, 100)
    const pageIdB = scaffoldPageAt('Beta', 100, 100)
    for (const pageId of [pageIdA, pageIdB]) {
      const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
      if (!registered.ok) throw new Error(registered.error)
    }

    bridgeImpl = async (_toolName, input) => {
      const { pageIds } = input as { pageIds: string[] }
      const pageId = pageIds[0]!
      return {
        ok: true,
        data: {
          frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
        },
        images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
      }
    }

    const single = (await studioCompareTool.handler!({ dir, pages: ['Alpha'] }, ctx())) as { ok: boolean; images?: unknown[] }
    expect(single.images).toBeDefined()
    expect(single.images!.length).toBe(3)

    const batch = (await studioCompareTool.handler!({ dir, pages: ['Alpha', 'Beta'], forceRecapture: true }, ctx())) as { ok: boolean; images?: unknown[] }
    expect(batch.images).toBeUndefined()
  })
})

describe('studio_compare — verdict cache (CHANGE B)', () => {
  it('serves the second call from cache (no bridge call) when nothing tracked has changed, and misses again once the page\'s own stylesheet is edited', async () => {
    const pageId = scaffoldPageAt('Cached', 100, 100)
    const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
      },
      images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
    })

    const first = (await studioCompareTool.handler!({ dir, pages: ['Cached'] }, ctx())) as { ok: boolean; data: CompareData }
    expect(first.data.results[0]!.fromCache).toBe(false)
    expect(bridgeCalls).toHaveLength(1)

    const second = (await studioCompareTool.handler!({ dir, pages: ['Cached'] }, ctx())) as { ok: boolean; data: CompareData }
    expect(second.data.results[0]!.fromCache).toBe(true)
    expect(second.data.results[0]!.pass).toBe(first.data.results[0]!.pass)
    expect(second.data.results[0]!.similarityScore).toBe(first.data.results[0]!.similarityScore)
    // No new bridge call for the cache hit — this is the whole point.
    expect(bridgeCalls).toHaveLength(1)

    // Edit the page's OWN stylesheet — untouched by anything else in this
    // test — and the cache must miss again.
    const stylesFile = path.join(dir, 'pages', 'Cached.module.css')
    const bumped = new Date(fs.statSync(stylesFile).mtime.getTime() + 5000)
    fs.appendFileSync(stylesFile, '\n.extra { color: currentColor; }\n')
    fs.utimesSync(stylesFile, bumped, bumped)

    const third = (await studioCompareTool.handler!({ dir, pages: ['Cached'] }, ctx())) as { ok: boolean; data: CompareData }
    expect(third.data.results[0]!.fromCache).toBe(false)
    expect(bridgeCalls).toHaveLength(2)
  })

  it('forceRecapture always misses even when nothing tracked changed', async () => {
    const pageId = scaffoldPageAt('Forced', 100, 100)
    const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
      },
      images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
    })

    await studioCompareTool.handler!({ dir, pages: ['Forced'] }, ctx())
    expect(bridgeCalls).toHaveLength(1)

    const forced = (await studioCompareTool.handler!({ dir, pages: ['Forced'], forceRecapture: true }, ctx())) as { ok: boolean; data: CompareData }
    expect(forced.data.results[0]!.fromCache).toBe(false)
    expect(bridgeCalls).toHaveLength(2)
  })

  it('never touches the bridge at all when every requested page is a cache hit', async () => {
    const pageId = scaffoldPageAt('NoBridge', 100, 100)
    const registered = await registerDesignReference(dir, new Uint8Array(solidPng(100, 100)), { pageId })
    if (!registered.ok) throw new Error(registered.error)

    bridgeImpl = async () => ({
      ok: true,
      data: {
        frames: [{ pageId, ok: true, width: 100, height: 100, imageIndex: 0, nodeRects: [], imageScale: 1, warnings: [] }],
      },
      images: [{ mimeType: 'image/png', data: solidPng(100, 100).toString('base64') }],
    })
    await studioCompareTool.handler!({ dir, pages: ['NoBridge'] }, ctx())
    expect(bridgeCalls).toHaveLength(1)

    // Now break the bridge entirely (simulates "no board connected") — a
    // cache-only call must still succeed because it never needs the bridge.
    bridgeImpl = null
    const cached = (await studioCompareTool.handler!({ dir, pages: ['NoBridge'] }, ctx())) as { ok: boolean; data: CompareData }
    expect(cached.ok).toBe(true)
    expect(cached.data.results[0]!.fromCache).toBe(true)
  })
})
