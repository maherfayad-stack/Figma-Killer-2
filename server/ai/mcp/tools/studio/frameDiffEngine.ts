/**
 * The pixel + region diff engine, extracted from `diffFrames.ts` so the two
 * tools that measure a frame against a design reference share one
 * implementation rather than growing a second one.
 *
 * Two callers, deliberately different in what they can hold:
 *
 *   - `studio_diff_frames` — takes `baseline` as BASE64 from the caller. Built
 *     for an external MCP client (Claude Code, a remote agent) that called
 *     `studio_export_frames` itself and therefore holds the PNG bytes in its
 *     own process.
 *   - `studio_compare` — captures the baseline itself, server-side, and never
 *     lets either image transit the model. This is the only path the IN-CANVAS
 *     agent has: it receives a capture as an MCP *image block*, which it cannot
 *     re-serialise back into a base64 string, so it could never supply
 *     `studio_diff_frames`' `baseline` argument at all. See `compare.ts`.
 *
 * Everything here is pure and synchronous apart from `reconcileReference`,
 * which needs `sharp`.
 */
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import sharp from 'sharp'
import { AI_USER_IMAGE_MAX_EDGE } from '@core/ai'

const DEFAULT_PIXELMATCH_THRESHOLD = 0.1
/** Sum of |Δr|+|Δg|+|Δb|+|Δa| above which a pixel counts as "different" for region bucketing (independent of pixelmatch's own threshold). */
const BYTE_DIFF_THRESHOLD = 32
/** A grid cell must have at least this fraction of its pixels differing to count as "hot" — filters stray single-pixel noise out of region bucketing. */
const HOT_CELL_FRACTION = 0.02
const MAX_GRID_CELLS_PER_AXIS = 48
/**
 * Relative aspect-ratio delta above which reference reconciliation refuses
 * rather than resamples. 5% covers ordinary dpr-rounding / the vision-safe
 * edge clamp; anything past it is treated as a real content-shape mismatch
 * (a different crop, a missing section, the wrong frame), and a non-uniform
 * stretch would silently paper over exactly the defect this measurement
 * exists to surface.
 */
const ASPECT_RATIO_TOLERANCE = 0.05

export interface NodeRect {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DecodedImage {
  width: number
  height: number
  data: Uint8Array
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export function decodePngBuffer(buffer: Buffer, label: string): DecodedImage {
  const png = PNG.sync.read(buffer)
  if (png.width <= 0 || png.height <= 0) {
    throw new Error(`${label} PNG decoded to zero size.`)
  }
  return { width: png.width, height: png.height, data: png.data }
}

export function decodePngBase64(base64: string, label: string): DecodedImage {
  return decodePngBuffer(Buffer.from(base64, 'base64'), label)
}

// ---------------------------------------------------------------------------
// Reference reconciliation
// ---------------------------------------------------------------------------

export interface ReferenceReconciliation {
  /** A plain PNG buffer at the EXACT baseline pixel dimensions, ready for `decodePngBuffer`. */
  pngBuffer: Buffer
  method: 'exact' | 'resampled'
  /**
   * Present only when `method === 'resampled'` — names WHICH axis forced the
   * resample and, when it looks like the vision-safe capture cap rather than
   * a genuine size mismatch, says so plainly. Both `studio_compare` and
   * `studio_diff_frames` surface this verbatim in their output rather than
   * leaving the caller to infer it from a bare `method` string — see A2 in
   * STUDIO-FIGMA-PARITY-PLAN.md: `studio_export_frames` clamps BOTH width
   * AND height of every capture to `AI_USER_IMAGE_MAX_EDGE`px, so a frame
   * taller than roughly that at the dpr requested falls into this branch even
   * when `studio_recommend_export_dpr` already matched the reference's width
   * exactly — the "exact-pixel" comparison the whole measurement pipeline is
   * built around silently becomes interpolated for most real mobile screens.
   */
  note?: string
}

/**
 * Reconcile a registered reference's bytes against the baseline's ACTUAL
 * captured dimensions.
 *
 * A registered reference is rarely pixel-identical to a fresh capture — a
 * Figma export is routinely 2x/3x the frame's authored width. The BETTER fix
 * is dpr-matching (capture the frame at the dpr that produces the reference's
 * own pixel size); resampling here is an explicit, LABELLED fallback for when
 * no dpr lands within tolerance (a non-integer ratio, or a reference wider
 * than the shared vision-safe edge cap allows even at `dpr:3`).
 *
 * The REFERENCE is what gets resampled, never the baseline: the baseline is
 * the just-captured, ground-truth pixels being scored and is cheap to
 * re-capture at a different dpr, while the reference is the one thing the
 * store exists to keep intact. The resample is per-call and in-memory — it
 * never touches the bytes on disk.
 */
export async function reconcileReference(
  referenceBytes: Uint8Array,
  referenceWidth: number,
  referenceHeight: number,
  baselineWidth: number,
  baselineHeight: number,
): Promise<{ ok: true; result: ReferenceReconciliation } | { ok: false; error: string }> {
  if (referenceWidth === baselineWidth && referenceHeight === baselineHeight) {
    // `.ensureAlpha()` makes the written PNG's channel count explicit (RGBA)
    // rather than relying on pngjs's own source-format normalization when it
    // is read back — belt-and-braces, not a behavior pngjs actually lacks.
    const pngBuffer = await sharp(referenceBytes).ensureAlpha().png().toBuffer()
    return { ok: true, result: { pngBuffer, method: 'exact' } }
  }

  const referenceAspect = referenceWidth / referenceHeight
  const baselineAspect = baselineWidth / baselineHeight
  const aspectDelta = Math.abs(referenceAspect - baselineAspect) / referenceAspect
  if (aspectDelta > ASPECT_RATIO_TOLERANCE) {
    return {
      ok: false,
      error:
        `The registered reference (${referenceWidth}x${referenceHeight}, aspect ${referenceAspect.toFixed(3)}) and the captured baseline (${baselineWidth}x${baselineHeight}, aspect ${baselineAspect.toFixed(3)}) differ in aspect ratio by ${(aspectDelta * 100).toFixed(1)}% — too much to attribute to a resolution/dpr mismatch. Resampling would stretch one image and could hide a real content difference (a missing section, a different crop, or the wrong frame). Resize the board frame to the reference's own proportions (studio_set_frames), or confirm the reference is actually this screen, before measuring again.`,
    }
  }

  const pngBuffer = await sharp(referenceBytes)
    .resize(baselineWidth, baselineHeight, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer()
  return {
    ok: true,
    result: {
      pngBuffer,
      method: 'resampled',
      note: describeResampleReason(referenceWidth, referenceHeight, baselineWidth, baselineHeight),
    },
  }
}

/** Builds `ReferenceReconciliation.note` — see that field's own doc for why this exists. */
function describeResampleReason(
  referenceWidth: number,
  referenceHeight: number,
  baselineWidth: number,
  baselineHeight: number,
): string {
  const widthMismatch = referenceWidth !== baselineWidth
  const heightMismatch = referenceHeight !== baselineHeight
  const axis = widthMismatch && heightMismatch ? 'width and height' : heightMismatch ? 'height' : 'width'
  // Only the HEIGHT side is a likely vision-cap symptom: studio_recommend_export_dpr
  // already targets an exact WIDTH match, so a lingering width mismatch usually
  // means that recommendation wasn't used, not that the cap fired on width.
  const likelyVisionCap = heightMismatch && baselineHeight >= AI_USER_IMAGE_MAX_EDGE - 1
  return likelyVisionCap
    ? `Resampled the reference (${referenceWidth}x${referenceHeight}) to the captured baseline's size (${baselineWidth}x${baselineHeight}) — the ${axis} did not match. The baseline's height landed at or near the ${AI_USER_IMAGE_MAX_EDGE}px vision-safe capture cap, which studio_export_frames applies to BOTH width and height: this is very likely a tall screen whose full height could not be captured at the dpr that matched the reference's width, not a genuine content mismatch. This comparison is now interpolated, not exact-pixel — treat the score and any region near the bottom of the frame as directional.`
    : `Resampled the reference (${referenceWidth}x${referenceHeight}) to the captured baseline's size (${baselineWidth}x${baselineHeight}) — the ${axis} did not match. This comparison is now interpolated, not exact-pixel.`
}

// ---------------------------------------------------------------------------
// Region detection
// ---------------------------------------------------------------------------

interface RegionCandidate {
  x0: number
  y0: number
  x1: number
  y1: number
  diffPixels: number
}

/** Grid + flood-fill region detection, reading the two ORIGINAL images directly (not pixelmatch's diff-image encoding). */
function findDifferingRegions(a: Uint8Array, b: Uint8Array, width: number, height: number): RegionCandidate[] {
  const cellSize = Math.max(4, Math.ceil(Math.max(width, height) / MAX_GRID_CELLS_PER_AXIS))
  const cols = Math.ceil(width / cellSize)
  const rows = Math.ceil(height / cellSize)
  const cellDiffCounts = new Int32Array(cols * rows)
  const cellPixelCounts = new Int32Array(cols * rows)

  for (let y = 0; y < height; y++) {
    const cellRow = Math.floor(y / cellSize)
    for (let x = 0; x < width; x++) {
      const cellCol = Math.floor(x / cellSize)
      const cellIndex = cellRow * cols + cellCol
      cellPixelCounts[cellIndex]! += 1
      const idx = (y * width + x) * 4
      const diff =
        Math.abs(a[idx]! - b[idx]!) +
        Math.abs(a[idx + 1]! - b[idx + 1]!) +
        Math.abs(a[idx + 2]! - b[idx + 2]!) +
        Math.abs(a[idx + 3]! - b[idx + 3]!)
      if (diff > BYTE_DIFF_THRESHOLD) cellDiffCounts[cellIndex]! += 1
    }
  }

  const isHot = (cellIndex: number): boolean =>
    cellPixelCounts[cellIndex]! > 0 && cellDiffCounts[cellIndex]! / cellPixelCounts[cellIndex]! >= HOT_CELL_FRACTION

  const visited = new Uint8Array(cols * rows)
  const regions: RegionCandidate[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const start = row * cols + col
      if (visited[start] || !isHot(start)) continue

      // 4-connected flood fill (BFS) over hot cells.
      const stack = [start]
      visited[start] = 1
      let minCol = col
      let maxCol = col
      let minRow = row
      let maxRow = row
      let diffPixels = 0

      while (stack.length > 0) {
        const cur = stack.pop()!
        const curRow = Math.floor(cur / cols)
        const curCol = cur % cols
        diffPixels += cellDiffCounts[cur]!
        minCol = Math.min(minCol, curCol)
        maxCol = Math.max(maxCol, curCol)
        minRow = Math.min(minRow, curRow)
        maxRow = Math.max(maxRow, curRow)

        const neighbors = [
          curRow > 0 ? cur - cols : -1,
          curRow < rows - 1 ? cur + cols : -1,
          curCol > 0 ? cur - 1 : -1,
          curCol < cols - 1 ? cur + 1 : -1,
        ]
        for (const n of neighbors) {
          if (n < 0 || visited[n] || !isHot(n)) continue
          visited[n] = 1
          stack.push(n)
        }
      }

      regions.push({
        x0: minCol * cellSize,
        y0: minRow * cellSize,
        x1: Math.min(width, (maxCol + 1) * cellSize),
        y1: Math.min(height, (maxRow + 1) * cellSize),
        diffPixels,
      })
    }
  }

  return regions.sort((r1, r2) => r2.diffPixels - r1.diffPixels)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface DiffRegion extends Rect {
  diffPixels: number
  diffPercent: number
  /** Fraction of the whole frame this region covers, as a percentage — how much of the screen is wrong, as opposed to how wrong it is. */
  frameCoveragePercent: number
  nodeIds: string[]
}

export interface FrameDiffResult {
  width: number
  height: number
  diffPixelCount: number
  diffPercent: number
  similarityScore: number
  regions: DiffRegion[]
  regionsTruncated: boolean
  /** The diff visualisation, PNG bytes. */
  diffPngBuffer: Buffer
}

export interface FrameDiffOptions {
  nodeRects?: readonly NodeRect[]
  topN: number
  /** pixelmatch per-pixel match threshold (0 = strictest, 1 = loosest). */
  threshold?: number
}

/**
 * Score two ALREADY-SAME-SIZE decoded images.
 *
 * Two passes (not one) because pixelmatch's own diff-image encoding
 * (transparent vs. highlighted pixels) is an implementation detail this
 * function should not have to reverse-engineer to bucket regions — the grid
 * pass reads the two ORIGINAL images directly.
 */
export function computeFrameDiff(a: DecodedImage, b: DecodedImage, options: FrameDiffOptions): FrameDiffResult {
  const { width, height } = a
  const diffPng = new PNG({ width, height })
  const diffPixelCount = pixelmatch(a.data, b.data, diffPng.data, width, height, {
    threshold: options.threshold ?? DEFAULT_PIXELMATCH_THRESHOLD,
  })
  const totalPixels = width * height
  const diffPercent = totalPixels > 0 ? (diffPixelCount / totalPixels) * 100 : 0

  const found = findDifferingRegions(a.data, b.data, width, height)
  const regions = found.slice(0, options.topN).map((r): DiffRegion => {
    const rect: Rect = { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }
    const area = rect.width * rect.height
    return {
      ...rect,
      diffPixels: r.diffPixels,
      diffPercent: area > 0 ? Math.min(100, (r.diffPixels / area) * 100) : 0,
      frameCoveragePercent: totalPixels > 0 ? (area / totalPixels) * 100 : 0,
      nodeIds: (options.nodeRects ?? []).filter((n) => rectsIntersect(rect, n)).map((n) => n.nodeId),
    }
  })

  return {
    width,
    height,
    diffPixelCount,
    diffPercent,
    similarityScore: Math.max(0, 100 - diffPercent),
    regions,
    regionsTruncated: found.length > options.topN,
    diffPngBuffer: PNG.sync.write(diffPng),
  }
}
