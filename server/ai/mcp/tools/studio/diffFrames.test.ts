import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import sharp from 'sharp'
import { diffFramesTool } from './diffFrames'
import { registerDesignReference } from '../../../../handlers/studio/designReferenceStore'

function makePng(width: number, height: number, colorAt: (x: number, y: number) => [number, number, number, number]): string {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const [r, g, b, a] = colorAt(x, y)
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = a
    }
  }
  return PNG.sync.write(png).toString('base64')
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const RED: [number, number, number, number] = [255, 0, 0, 255]

interface DiffFramesData {
  width: number
  height: number
  diffPixelCount: number
  similarityScore: number
  regions: Array<{ x: number; y: number; width: number; height: number; diffPercent: number; nodeIds: string[] }>
}

interface ToolResult {
  ok: boolean
  error?: string
  data?: DiffFramesData
  images?: Array<{ mimeType: string; data: string }>
}

describe('studio_diff_frames', () => {
  it('reports a near-zero diff for two identical images', async () => {
    const a = makePng(64, 64, () => WHITE)
    const b = makePng(64, 64, () => WHITE)

    const result = (await diffFramesTool.handler!({ baseline: a, reference: b }, {} as never)) as ToolResult
    expect(result.ok).toBe(true)
    expect(result.data!.diffPixelCount).toBe(0)
    expect(result.data!.similarityScore).toBe(100)
    expect(result.data!.regions).toEqual([])
  })

  it('finds a differing region and maps it back to intersecting nodeIds', async () => {
    const width = 96
    const height = 96
    // A solid red block from (32,32) to (64,64) on the reference only.
    const a = makePng(width, height, () => WHITE)
    const b = makePng(width, height, (x, y) => (x >= 32 && x < 64 && y >= 32 && y < 64 ? RED : WHITE))

    const nodeRects = [
      { nodeId: 'hero', x: 0, y: 0, width: 30, height: 30 }, // does not overlap the diff
      { nodeId: 'card', x: 20, y: 20, width: 40, height: 40 }, // overlaps the diff block
      { nodeId: 'footer', x: 80, y: 80, width: 10, height: 10 }, // far away
    ]

    const result = (await diffFramesTool.handler!(
      { baseline: a, reference: b, nodeRects, topN: 5 },
      {} as never,
    )) as ToolResult
    const data = result.data!

    expect(data.diffPixelCount).toBeGreaterThan(0)
    expect(data.similarityScore).toBeLessThan(100)
    expect(data.regions.length).toBeGreaterThan(0)

    const topRegion = data.regions[0]!
    expect(topRegion.diffPercent).toBeGreaterThan(0)
    expect(topRegion.nodeIds).toContain('card')
    expect(topRegion.nodeIds).not.toContain('footer')
  })

  it('scales nodeRects by nodeRectsImageScale before mapping — the dpr!=1 regression (mcp-tooling FIX 1)', async () => {
    // A 192x192 diff image (a 96x96 CSS-px frame captured at an
    // effective scale of 2). The differing block sits in the
    // lower-right quadrant of image space, (64,64)-(128,128), which
    // corresponds to CSS-px node rect (32,32)-(64,64).
    const width = 192
    const height = 192
    const a = makePng(width, height, () => WHITE)
    const b = makePng(width, height, (x, y) => (x >= 64 && x < 128 && y >= 64 && y < 128 ? RED : WHITE))

    const nodeRects = [
      { nodeId: 'top-left', x: 0, y: 0, width: 30, height: 30 }, // CSS px — never overlaps at any realistic scale
      { nodeId: 'bottom-right', x: 20, y: 20, width: 40, height: 40 }, // CSS px — overlaps the defect ONLY when scaled by 2
    ]

    const withoutScale = (await diffFramesTool.handler!(
      { baseline: a, reference: b, nodeRects, topN: 5 },
      {} as never,
    )) as ToolResult
    // Default (no imageScale) intersects the unscaled CSS-px rects directly
    // against the image-space region — the pre-FIX-1 behaviour, kept as the
    // explicit default for backward compatibility with dpr:1 callers — so
    // neither node (both living in the CSS-px upper-left quadrant) overlaps
    // a region that only ever appears in the lower-right of image space.
    expect(withoutScale.data!.regions[0]!.nodeIds).not.toContain('bottom-right')

    const withScale = (await diffFramesTool.handler!(
      { baseline: a, reference: b, nodeRects, nodeRectsImageScale: 2, topN: 5 },
      {} as never,
    )) as ToolResult
    expect(withScale.data!.regions[0]!.nodeIds).toContain('bottom-right')
    expect(withScale.data!.regions[0]!.nodeIds).not.toContain('top-left')
  })

  it('refuses to diff two differently-sized images with a clear message', async () => {
    const a = makePng(64, 64, () => WHITE)
    const b = makePng(32, 32, () => WHITE)

    const result = (await diffFramesTool.handler!({ baseline: a, reference: b }, {} as never)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('64x64')
    expect(result.error).toContain('32x32')
  })

  it('returns a diff PNG as an image attachment', async () => {
    const a = makePng(32, 32, () => WHITE)
    const b = makePng(32, 32, (x, y) => (x < 4 && y < 4 ? RED : WHITE))

    const result = (await diffFramesTool.handler!({ baseline: a, reference: b }, {} as never)) as ToolResult
    expect(result.images).toBeDefined()
    expect(result.images!.length).toBe(1)
    expect(result.images![0]!.mimeType).toBe('image/png')
    expect(result.images![0]!.data.length).toBeGreaterThan(0)
  })

  it('refuses when both or neither of reference/referenceId are provided', async () => {
    const a = makePng(8, 8, () => WHITE)
    const neither = (await diffFramesTool.handler!({ baseline: a }, {} as never)) as ToolResult
    expect(neither.ok).toBe(false)

    const both = (await diffFramesTool.handler!({ baseline: a, reference: a, referenceId: 'x' }, {} as never)) as ToolResult
    expect(both.ok).toBe(false)
  })
})

interface ReconciledToolResult extends ToolResult {
  data?: DiffFramesData & {
    dimensionReconciliation?: { method: 'exact' | 'resampled'; referenceId: string; referenceOriginal: { width: number; height: number } }
  }
}

describe('studio_diff_frames — referenceId (registered design reference)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-diff-frames-reference-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function registerReferencePng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<string> {
    const bytes = new Uint8Array(
      await sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer(),
    )
    const result = await registerDesignReference(dir, bytes, {})
    if (!result.ok) throw new Error(result.error)
    return result.reference.id
  }

  it('reports ok:false with a clear reason for an unknown referenceId', async () => {
    const baseline = makePng(10, 10, () => WHITE)
    const result = (await diffFramesTool.handler!({ dir, baseline, referenceId: 'nope' }, {} as never)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('nope')
  })

  it('method:"exact" when the registered reference already matches the baseline\'s pixel dimensions', async () => {
    const referenceId = await registerReferencePng(16, 16, { r: 255, g: 255, b: 255 })
    const baseline = makePng(16, 16, (x, y) => (x < 4 && y < 4 ? RED : WHITE))

    const result = (await diffFramesTool.handler!({ dir, baseline, referenceId }, {} as never)) as ReconciledToolResult
    expect(result.ok).toBe(true)
    expect(result.data!.dimensionReconciliation).toEqual({
      method: 'exact',
      referenceId,
      referenceOriginal: { width: 16, height: 16 },
    })
    expect(result.data!.diffPixelCount).toBeGreaterThan(0)
  })

  it('method:"resampled" when dimensions differ but the aspect ratio is close (a dpr/rounding-shaped mismatch)', async () => {
    // 32x32 reference vs a 30x30 baseline — same aspect ratio, different pixel size.
    const referenceId = await registerReferencePng(32, 32, { r: 10, g: 20, b: 30 })
    const baseline = makePng(30, 30, () => WHITE)

    const result = (await diffFramesTool.handler!({ dir, baseline, referenceId }, {} as never)) as ReconciledToolResult
    expect(result.ok).toBe(true)
    expect(result.data!.dimensionReconciliation!.method).toBe('resampled')
    expect(result.data!.dimensionReconciliation!.referenceOriginal).toEqual({ width: 32, height: 32 })
    expect(result.data!.width).toBe(30)
    expect(result.data!.height).toBe(30)
  })

  it('refuses (does not silently stretch) when the aspect ratios diverge beyond tolerance', async () => {
    // Reference is a wide banner (200x50, aspect 4.0); baseline is near-square
    // (60x50, aspect 1.2) — too different to be a resolution mismatch.
    const referenceId = await registerReferencePng(200, 50, { r: 1, g: 1, b: 1 })
    const baseline = makePng(60, 50, () => WHITE)

    const result = (await diffFramesTool.handler!({ dir, baseline, referenceId }, {} as never)) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('aspect ratio')
  })
})
