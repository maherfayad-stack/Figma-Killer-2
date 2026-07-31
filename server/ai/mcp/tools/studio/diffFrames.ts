/**
 * Studio MCP tool — 9.2 `studio_diff_frames`, the third leg of the visual-
 * audit trio (WS-9.2): a server-side pixel + region diff between two PNGs.
 *
 * Deliberately generic — accepts two base64 PNG buffers, not a coupling to
 * `studio_export_frames`'s or `studio_render_reference`'s specific output
 * shape, so it is independently useful for ANY two same-sized screenshots
 * (`studio_export_frames` vs `studio_render_reference` is the intended WS-9.2
 * pairing, but nothing here assumes it).
 *
 * The entire value of this tool over a bare pixelmatch call is the
 * **per-region → node-id mapping**: an overall similarity score alone tells
 * an agent "something differs," not where or what — `mcp-tooling.md`'s own
 * rule ("a diff tool returns a score and the top differing rectangles mapped
 * to node ids — not 'the images look different'"). The caller supplies
 * `nodeRects` (frame-local node rectangles — `studio_export_frames`'s
 * response already returns exactly this shape per frame) and this tool
 * intersects each top differing rectangle against them.
 *
 * Algorithm:
 *   1. `pixelmatch` computes the official diff pixel count + diff PNG (used
 *      for the overall score and the returned image).
 *   2. Independently, a coarse grid (adaptive cell size) buckets per-pixel
 *      byte differences, then 4-connected "hot" cells are flood-filled into
 *      merged rectangles — the top N by total differing pixels are returned,
 *      each with the node ids whose rect intersects it.
 * Two passes (not one) because pixelmatch's own diff-image encoding
 * (transparent vs. highlighted pixels) is an implementation detail this tool
 * should not have to reverse-engineer to bucket regions — the grid pass reads
 * the two ORIGINAL images directly.
 */
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool } from '../../../runtime/types'

const DEFAULT_TOP_N = 5
const MAX_TOP_N = 20
const DEFAULT_THRESHOLD = 0.1
/** Sum of |Δr|+|Δg|+|Δb|+|Δa| above which a pixel counts as "different" for region bucketing (independent of pixelmatch's own threshold). */
const BYTE_DIFF_THRESHOLD = 32
/** A grid cell must have at least this fraction of its pixels differing to count as "hot" — filters stray single-pixel noise out of region bucketing. */
const HOT_CELL_FRACTION = 0.02
const MAX_GRID_CELLS_PER_AXIS = 48

interface NodeRectInput {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function decodePng(base64: string, label: string): { width: number; height: number; data: Uint8Array } {
  const buffer = Buffer.from(base64, 'base64')
  const png = PNG.sync.read(buffer)
  if (png.width <= 0 || png.height <= 0) {
    throw new Error(`${label} PNG decoded to zero size.`)
  }
  return { width: png.width, height: png.height, data: png.data }
}

interface RegionCandidate {
  x0: number
  y0: number
  x1: number
  y1: number
  diffPixels: number
}

/** Grid + flood-fill region detection, reading the two ORIGINAL images directly (not pixelmatch's diff-image encoding). */
function findDifferingRegions(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): RegionCandidate[] {
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

const NodeRectSchema = Type.Object({
  nodeId: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})

const InputSchema = Type.Object(
  {
    baseline: Type.String({ description: 'Base64-encoded PNG bytes — typically a studio_export_frames capture.' }),
    reference: Type.String({ description: 'Base64-encoded PNG bytes — typically a studio_render_reference capture. Must be the exact same pixel dimensions as `baseline`.' }),
    nodeRects: Type.Optional(Type.Array(NodeRectSchema, {
      description: 'Frame-local node rectangles (studio_export_frames\' response returns exactly this shape as `nodeRects`) — used to map each top differing region back to the node ids it overlaps. Omit for a pure pixel/region diff with no node mapping.',
    })),
    topN: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOP_N, description: `Number of top differing regions to return, ranked by differing-pixel count. Default ${DEFAULT_TOP_N}.` })),
    threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'pixelmatch per-pixel match threshold (0 = strictest, 1 = loosest). Default 0.1.' })),
  },
  { additionalProperties: false },
)

export const diffFramesTool: AiTool = {
  name: 'studio_diff_frames',
  scope: 'shared',
  execution: 'server',
  description:
    'Server-side pixel + region diff between two same-sized PNGs (base64). Returns an overall similarity score, a diff PNG (as an image block), and the top differing rectangles ranked by differing-pixel count — each with a diffPercent and, when `nodeRects` was supplied, the node ids whose rect intersects it. This is the "the hero section is 78% different, nodes X and Y" tool, not a bare screenshot comparator: pair it with studio_export_frames\' `nodeRects` output and studio_get_node_source to go straight from a visual defect to the exact source location. `baseline` and `reference` must be the exact same pixel dimensions — export/render at the same width and dpr, or this returns ok:false naming the mismatch.',
  inputSchema: InputSchema,
  handler: async (input) => {
    const { baseline, reference, nodeRects, topN, threshold } = input as {
      baseline: string
      reference: string
      nodeRects?: NodeRectInput[]
      topN?: number
      threshold?: number
    }

    let a: { width: number; height: number; data: Uint8Array }
    let b: { width: number; height: number; data: Uint8Array }
    try {
      a = decodePng(baseline, 'baseline')
      b = decodePng(reference, 'reference')
    } catch (err) {
      return aiToolError(`Could not decode input PNG: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (a.width !== b.width || a.height !== b.height) {
      return aiToolError(
        `baseline (${a.width}x${a.height}) and reference (${b.width}x${b.height}) are different pixel sizes — export/render both at the same width and dpr before diffing.`,
      )
    }
    const { width, height } = a

    const diffPng = new PNG({ width, height })
    const numDiffPixels = pixelmatch(a.data, b.data, diffPng.data, width, height, {
      threshold: threshold ?? DEFAULT_THRESHOLD,
    })
    const totalPixels = width * height
    const diffPercent = totalPixels > 0 ? (numDiffPixels / totalPixels) * 100 : 0
    const similarityScore = Math.max(0, 100 - diffPercent)

    const regions = findDifferingRegions(a.data, b.data, width, height)
    const cap = topN ?? DEFAULT_TOP_N
    const topRegions = regions.slice(0, cap).map((r) => {
      const rect: Rect = { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }
      const area = rect.width * rect.height
      const nodeIds = (nodeRects ?? [])
        .filter((n) => rectsIntersect(rect, n))
        .map((n) => n.nodeId)
      return {
        ...rect,
        diffPixels: r.diffPixels,
        diffPercent: area > 0 ? Math.min(100, (r.diffPixels / area) * 100) : 0,
        nodeIds,
      }
    })

    const diffPngBuffer = PNG.sync.write(diffPng)
    return aiToolOk(
      {
        ok: true,
        width,
        height,
        diffPixelCount: numDiffPixels,
        diffPercent,
        similarityScore,
        regions: topRegions,
        regionsTruncated: regions.length > cap,
      },
      [{ mimeType: 'image/png', data: diffPngBuffer.toString('base64') }],
    )
  },
}

export const studioDiffMcpTools: AiTool[] = [diffFramesTool]
