import { describe, expect, it } from 'bun:test'
import { PNG } from 'pngjs'
import { diffFramesTool } from './diffFrames'

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
})
