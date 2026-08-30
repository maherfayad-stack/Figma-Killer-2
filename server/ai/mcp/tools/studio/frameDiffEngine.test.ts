/**
 * frameDiffEngine — the scoring behaviour both `studio_diff_frames` and
 * `studio_compare` depend on.
 *
 * The property that actually matters here is the one `studio_compare`'s
 * verdict is built on: a REAL defect forms one contiguous region covering a
 * meaningful share of the frame, while rasterisation noise never does. If
 * `frameCoveragePercent` stopped separating those two, the pass/fail verdict
 * would become a coin flip and the whole measurement loop would be theatre.
 */
import { describe, expect, it } from 'bun:test'
import { PNG } from 'pngjs'
import { computeFrameDiff, decodePngBuffer, reconcileReference } from './frameDiffEngine'

const W = 200
const H = 200

function solid(r: number, g: number, b: number): PNG {
  const png = new PNG({ width: W, height: H })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r
    png.data[i + 1] = g
    png.data[i + 2] = b
    png.data[i + 3] = 255
  }
  return png
}

function withBlock(base: PNG, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width: W, height: H })
  base.data.copy(png.data)
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4
      png.data[i] = rgb[0]
      png.data[i + 1] = rgb[1]
      png.data[i + 2] = rgb[2]
      png.data[i + 3] = 255
    }
  }
  return png
}

/** Scattered single pixels — the shape antialiasing noise takes, never a block. */
function withSpeckles(base: PNG, count: number): PNG {
  const png = new PNG({ width: W, height: H })
  base.data.copy(png.data)
  for (let n = 0; n < count; n++) {
    const x = (n * 37) % W
    const y = (n * 53) % H
    const i = (y * W + x) * 4
    png.data[i] = 0
    png.data[i + 1] = 0
    png.data[i + 2] = 0
  }
  return png
}

function decode(png: PNG) {
  return decodePngBuffer(PNG.sync.write(png), 'test')
}

describe('computeFrameDiff', () => {
  it('scores two identical images as a perfect match with no regions', () => {
    const a = decode(solid(255, 255, 255))
    const result = computeFrameDiff(a, a, { topN: 5 })
    expect(result.diffPixelCount).toBe(0)
    expect(result.similarityScore).toBe(100)
    expect(result.regions).toEqual([])
  })

  it('surfaces a structural defect as ONE region whose frame coverage is large', () => {
    // A 60x40 block on a 200x200 frame = 2400/40000 = 6% of the frame.
    const base = solid(255, 255, 255)
    const result = computeFrameDiff(decode(base), decode(withBlock(base, 20, 30, 60, 40, [255, 0, 0])), { topN: 5 })

    expect(result.regions).toHaveLength(1)
    const region = result.regions[0]!
    expect(region.frameCoveragePercent).toBeGreaterThan(4)
    // The block's own rect must be inside the reported region.
    expect(region.x).toBeLessThanOrEqual(20)
    expect(region.y).toBeLessThanOrEqual(30)
    expect(region.x + region.width).toBeGreaterThanOrEqual(80)
    expect(region.y + region.height).toBeGreaterThanOrEqual(70)
  })

  it('does NOT let scattered noise form a structural region — the whole basis of the pass verdict', () => {
    // Same total differing-pixel budget as a small defect, but spread out.
    // Every region this produces must stay under the 1.5%-of-frame floor
    // `studio_compare` treats as structural, or antialiasing would fail
    // every screen forever.
    const base = solid(255, 255, 255)
    const result = computeFrameDiff(decode(base), decode(withSpeckles(base, 400)), { topN: 20 })

    for (const region of result.regions) {
      expect(region.frameCoveragePercent).toBeLessThan(1.5)
    }
  })

  it('maps a differing region back to the node ids that overlap it', () => {
    const base = solid(255, 255, 255)
    const result = computeFrameDiff(decode(base), decode(withBlock(base, 20, 30, 60, 40, [255, 0, 0])), {
      topN: 5,
      nodeRects: {
        rects: [
          { nodeId: 'hero', x: 0, y: 0, width: 200, height: 100 },
          { nodeId: 'footer', x: 0, y: 150, width: 200, height: 50 },
        ],
        imageScale: 1,
      },
    })

    expect(result.regions[0]!.nodeIds).toContain('hero')
    expect(result.regions[0]!.nodeIds).not.toContain('footer')
  })

  it('scales CSS-px node rects into the diff image\'s pixel space before mapping — the dpr!=1 regression (mcp-tooling FIX 1)', () => {
    // A 400x400 diff image (e.g. a 200x200 CSS-px frame captured at dpr:2).
    // The differing block sits in the LOWER-RIGHT quadrant of the image —
    // pixel space (300,300)-(340,340) — which corresponds to CSS-px node
    // rect (150,150)-(170,170). Before FIX 1, node rects were intersected
    // directly against the region's IMAGE-space rect with no scaling, so a
    // node living in the lower-right CSS quadrant could never match a region
    // that only ever appears in the upper-left quarter of image space.
    const W2 = 400
    const H2 = 400
    function solid2(r: number, g: number, b: number): PNG {
      const png = new PNG({ width: W2, height: H2 })
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = r
        png.data[i + 1] = g
        png.data[i + 2] = b
        png.data[i + 3] = 255
      }
      return png
    }
    function block2(base: PNG): PNG {
      const png = new PNG({ width: W2, height: H2 })
      base.data.copy(png.data)
      for (let y = 300; y < 340; y++) {
        for (let x = 300; x < 340; x++) {
          const i = (y * W2 + x) * 4
          png.data[i] = 255
          png.data[i + 1] = 0
          png.data[i + 2] = 0
          png.data[i + 3] = 255
        }
      }
      return png
    }
    const base = solid2(255, 255, 255)
    const result = computeFrameDiff(decode(base), decode(block2(base)), {
      topN: 5,
      nodeRects: {
        rects: [
          { nodeId: 'top-left-card', x: 0, y: 0, width: 100, height: 100 }, // CSS px — well away from the defect at any scale
          { nodeId: 'bottom-right-card', x: 140, y: 140, width: 40, height: 40 }, // CSS px (150,150) sits inside this — matches ONLY when scaled by 2
        ],
        imageScale: 2,
      },
    })

    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.nodeIds).toContain('bottom-right-card')
    expect(result.regions[0]!.nodeIds).not.toContain('top-left-card')
  })

  it('ranks regions worst-first, so regions[0] is always the right thing to fix next', () => {
    const base = solid(255, 255, 255)
    let mutated = withBlock(base, 10, 10, 20, 20, [255, 0, 0])
    mutated = withBlock(mutated, 100, 100, 70, 70, [0, 255, 0])
    const result = computeFrameDiff(decode(base), decode(mutated), { topN: 5 })

    expect(result.regions.length).toBeGreaterThanOrEqual(2)
    expect(result.regions[0]!.diffPixels).toBeGreaterThan(result.regions[1]!.diffPixels)
    // The bigger block is the one at (100,100).
    expect(result.regions[0]!.x).toBeGreaterThan(50)
  })

  it('reports truncation rather than silently dropping regions past topN', () => {
    const base = solid(255, 255, 255)
    let mutated = base
    for (let n = 0; n < 6; n++) {
      mutated = withBlock(mutated, 10 + n * 30, 10, 12, 12, [255, 0, 0])
    }
    const result = computeFrameDiff(decode(base), decode(mutated), { topN: 2 })
    expect(result.regions).toHaveLength(2)
    expect(result.regionsTruncated).toBe(true)
  })
})

describe('reconcileReference', () => {
  it('reports an exact match without resampling when the sizes already agree', async () => {
    const bytes = PNG.sync.write(solid(10, 20, 30))
    const result = await reconcileReference(bytes, W, H, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.method).toBe('exact')
  })

  it('resamples a proportional size difference — a 2x Figma export against a 1x capture', async () => {
    const big = new PNG({ width: W * 2, height: H * 2 })
    const bytes = PNG.sync.write(big)
    const result = await reconcileReference(bytes, W * 2, H * 2, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.method).toBe('resampled')
      expect(decodePngBuffer(result.result.pngBuffer, 'ref').width).toBe(W)
    }
  })

  it('refuses a large aspect-ratio divergence rather than stretching over a real content difference', async () => {
    const wide = new PNG({ width: 400, height: 100 })
    const result = await reconcileReference(PNG.sync.write(wide), 400, 100, W, H)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('aspect ratio')
  })

  it('names the vision-safe capture cap when a resample looks caused by it (A2)', async () => {
    // studio_export_frames clamps BOTH width and height at ~1568px. A
    // baseline whose captured HEIGHT lands right at that cap, while its
    // WIDTH still matches the reference, is the routine tall-mobile-screen
    // case — the note should call this out by name rather than leave the
    // caller to infer it from a bare `method: "resampled"`.
    const referenceWidth = 400
    const referenceHeight = 1600
    const baselineWidth = 400
    const baselineHeight = 1568
    const reference = new PNG({ width: referenceWidth, height: referenceHeight })
    const result = await reconcileReference(
      PNG.sync.write(reference),
      referenceWidth,
      referenceHeight,
      baselineWidth,
      baselineHeight,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.method).toBe('resampled')
      expect(result.result.note).toBeDefined()
      expect(result.result.note).toContain('vision-safe')
      expect(result.result.note).toContain('height')
    }
  })

  it('does not claim the vision-safe cap for a much taller baseline — the measurement-purpose false-positive (mcp-tooling FIX 2)', async () => {
    // `studio_compare` now captures under `purpose: 'measurement'`, whose
    // ceiling (4096px) is nowhere near the vision-safe cap (1568px). Before
    // tightening the heuristic to a near-cap band, ANY baselineHeight >=
    // 1567 (with no upper bound) satisfied the old `>=` check, so a
    // legitimately much-taller measurement capture would have been
    // misattributed to the vision-safety limit — a false story about why the
    // resample happened.
    const referenceWidth = 400
    const referenceHeight = 4200
    const baselineWidth = 400
    const baselineHeight = 4096
    const reference = new PNG({ width: referenceWidth, height: referenceHeight })
    const result = await reconcileReference(
      PNG.sync.write(reference),
      referenceWidth,
      referenceHeight,
      baselineWidth,
      baselineHeight,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.method).toBe('resampled')
      expect(result.result.note).toBeDefined()
      expect(result.result.note).not.toContain('vision-safe')
      expect(result.result.note).toContain('height')
    }
  })

  it('names the mismatched axis without claiming the vision cap when the resample is not near it', async () => {
    // Small width-only mismatch, well within the 5% aspect-ratio tolerance,
    // and both dimensions far below the vision-safe cap.
    const result = await reconcileReference(PNG.sync.write(new PNG({ width: 208, height: H })), 208, H, W, H)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.method).toBe('resampled')
      expect(result.result.note).toBeDefined()
      expect(result.result.note).not.toContain('vision-safe')
      expect(result.result.note).toContain('width')
    }
  })
})
