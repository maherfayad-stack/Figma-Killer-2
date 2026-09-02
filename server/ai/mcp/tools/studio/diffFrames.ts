/**
 * Studio MCP tool — 9.2 `studio_diff_frames`: a server-side pixel + region
 * diff between two PNGs the CALLER supplies.
 *
 * Deliberately generic — accepts two base64 PNG buffers, not a coupling to
 * `studio_export_frames`'s or `studio_render_reference`'s specific output
 * shape, so it is independently useful for ANY two same-sized screenshots.
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
 * **Who this is for.** A caller that holds PNG bytes in its own process: an
 * external MCP client that called `studio_export_frames` itself. The
 * in-canvas Studio agent is NOT that caller — it receives a capture as an MCP
 * image block and cannot re-serialise those bytes back into the base64 string
 * `baseline` requires, so for it this tool is unreachable by construction.
 * `studio_compare` (`compare.ts`) is its path: same engine
 * (`frameDiffEngine.ts`), but it captures the baseline itself and neither
 * image ever transits the model.
 *
 * **`referenceId` input** — lets a caller diff against a durably registered
 * design reference (`designReferenceStore.ts`) instead of base64-encoding it
 * on every call. Bytes for the REFERENCE side never transit the model this
 * way, the same principle `studio_fetch_remote_asset` (`mcp-10`) was built
 * on. It is also the only input path that RECONCILES a dimension mismatch
 * (see `reconcileReference`); the `reference` base64 path refuses one
 * outright, with no reconciliation.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { getDesignReference, readDesignReferenceBytes } from '../../../../handlers/studio/designReferenceStore'
import {
  computeFrameDiff,
  decodePngBase64,
  decodePngBuffer,
  reconcileReference,
  type DecodedImage,
  type NodeRect,
} from './frameDiffEngine'

const DEFAULT_TOP_N = 5
const MAX_TOP_N = 20

const NodeRectSchema = Type.Object({
  nodeId: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})

const InputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: 'Absolute project directory. Only used to resolve `referenceId`; ignored otherwise. Defaults to the first project under studio-workspace/.' })),
    baseline: Type.String({ description: 'Base64-encoded PNG bytes — typically a studio_export_frames capture.' }),
    reference: Type.Optional(Type.String({ description: 'Base64-encoded PNG bytes — typically a studio_render_reference capture. Must be the exact same pixel dimensions as `baseline`, or this returns ok:false naming the mismatch (no reconciliation on this path). Provide exactly one of `reference` or `referenceId`.' })),
    referenceId: Type.Optional(Type.String({ description: 'A studio_register_design_reference id instead of base64 bytes — the reference\'s bytes are read server-side and never transit you. Unlike `reference`, a pixel-dimension mismatch is RECONCILED here (dpr-equivalent resampling, aspect-ratio-bounded) rather than refused outright; the result\'s `dimensionReconciliation` field states which path was used. Provide exactly one of `reference` or `referenceId`.' })),
    nodeRects: Type.Optional(Type.Array(NodeRectSchema, {
      description: 'Frame-local node rectangles in CSS px (studio_export_frames\' response returns exactly this shape as `nodeRects`) — used to map each top differing region back to the node ids it overlaps. Omit for a pure pixel/region diff with no node mapping.',
    })),
    nodeRectsImageScale: Type.Optional(Type.Number({
      minimum: 0,
      exclusiveMinimum: 0,
      description: 'Multiplier from `nodeRects`\' CSS-px space into `baseline`\'s actual pixel space — studio_export_frames\' response returns this as `imageScale` alongside `nodeRects` for exactly this purpose. Default 1 (correct for an unscaled dpr:1 capture); REQUIRED whenever `baseline` was captured at any other effective resolution, or the region→node mapping silently targets the wrong nodes (only the top-left portion of the frame could ever map correctly at scale 2).',
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
    'Server-side pixel + region diff between `baseline` (base64 PNG bytes YOU already hold) and EITHER `reference` (base64) OR `referenceId` (a studio_register_design_reference id — its bytes are read here, never transiting you). Returns an overall similarity score, a diff PNG, and the top differing rectangles ranked by differing-pixel count — each with a diffPercent and, when `nodeRects` was supplied, the node ids whose rect intersects it. NOTE: if you are the agent working inside Studio, use studio_compare instead — it captures the screen and measures it in one call, because a capture reaches you as an image you cannot turn back into the base64 `baseline` needs. This tool is for a client that captured the frame in its own process. With `reference`, both images must be the exact same pixel dimensions or this returns ok:false. With `referenceId`, a dimension mismatch is instead RECONCILED by resampling the reference (labelled `dimensionReconciliation.method: "resampled"` — a weaker claim than an exact match, with `dimensionReconciliation.note` naming which axis mismatched and calling out the ~1568px vision-safe capture cap when that looks like the cause) unless the aspect ratios diverge too far to attribute to resolution, in which case it refuses rather than silently stretch the image.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, baseline, reference, referenceId, nodeRects, nodeRectsImageScale, topN, threshold } = input as {
      dir?: string
      baseline: string
      reference?: string
      referenceId?: string
      nodeRects?: NodeRect[]
      nodeRectsImageScale?: number
      topN?: number
      threshold?: number
    }

    if ((reference !== undefined) === (referenceId !== undefined)) {
      return aiToolError('Provide exactly one of `reference` (base64 PNG) or `referenceId` (a studio_register_design_reference id).')
    }

    let a: DecodedImage
    try {
      a = decodePngBase64(baseline, 'baseline')
    } catch (err) {
      return aiToolError(`Could not decode input PNG: ${err instanceof Error ? err.message : String(err)}`)
    }

    let b: DecodedImage
    let dimensionReconciliation: { method: 'exact' | 'resampled'; referenceId: string; referenceOriginal: { width: number; height: number }; note?: string } | undefined

    if (referenceId !== undefined) {
      const dir = resolveToolProjectDir(dirInput, ctx)
      const designRef = getDesignReference(dir, referenceId)
      if (!designRef) {
        return aiToolError(`No design reference "${referenceId}" found for this project — call studio_list_design_references to see what is registered.`)
      }
      const referenceBytes = readDesignReferenceBytes(dir, designRef)
      if (!referenceBytes) {
        return aiToolError(`Design reference "${referenceId}" is registered but its file could not be read from disk.`)
      }
      const reconciled = await reconcileReference(referenceBytes, designRef.width, designRef.height, a.width, a.height)
      if (!reconciled.ok) return aiToolError(reconciled.error)
      try {
        b = decodePngBuffer(reconciled.result.pngBuffer, 'reference')
      } catch (err) {
        return aiToolError(`Could not decode the reconciled reference image: ${err instanceof Error ? err.message : String(err)}`)
      }
      dimensionReconciliation = {
        method: reconciled.result.method,
        referenceId,
        referenceOriginal: { width: designRef.width, height: designRef.height },
        ...(reconciled.result.note ? { note: reconciled.result.note } : {}),
      }
    } else {
      try {
        b = decodePngBase64(reference as string, 'reference')
      } catch (err) {
        return aiToolError(`Could not decode input PNG: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (a.width !== b.width || a.height !== b.height) {
        return aiToolError(
          `baseline (${a.width}x${a.height}) and reference (${b.width}x${b.height}) are different pixel sizes — export/render both at the same width and dpr before diffing.`,
        )
      }
    }

    const diff = computeFrameDiff(a, b, {
      nodeRects: nodeRects ? { rects: nodeRects, imageScale: nodeRectsImageScale ?? 1 } : undefined,
      topN: topN ?? DEFAULT_TOP_N,
      threshold,
    })

    return aiToolOk(
      {
        ok: true,
        width: diff.width,
        height: diff.height,
        diffPixelCount: diff.diffPixelCount,
        diffPercent: diff.diffPercent,
        similarityScore: diff.similarityScore,
        regions: diff.regions,
        regionsTruncated: diff.regionsTruncated,
        ...(dimensionReconciliation ? { dimensionReconciliation } : {}),
      },
      [{ mimeType: 'image/png', data: diff.diffPngBuffer.toString('base64') }],
    )
  },
}

export const studioDiffMcpTools: AiTool[] = [diffFramesTool]
