/**
 * `studio_compare` — the agent's ruler.
 *
 * `studio_screenshot` gave the agent sight. Sight alone turned out not to be
 * enough: a screen whose subtitle overlapped its heading and whose icons
 * rendered as specks was looked at, and reported as done. "Does this match the
 * design" stayed an opinion, and an agent grading its own homework gives
 * itself a pass.
 *
 * ## Why this is a new tool and not prompt wording
 *
 * The measurement path already existed on paper — `studio_register_design_
 * reference` + `studio_recommend_export_dpr` + `studio_export_frames` +
 * `studio_diff_frames`. For the in-canvas agent it was **unreachable**, not
 * merely tedious: `studio_diff_frames` takes its `baseline` as a base64
 * STRING, while a capture arrives as an MCP *image block*. A model can look at
 * an image block; it cannot transcribe one back into base64 text. There was
 * no sequence of tool calls that got the agent from "I captured the screen" to
 * "I measured the screen". Telling it to measure harder could never have
 * worked.
 *
 * So the capture happens HERE, server-side, and the bytes go straight into the
 * diff engine in-process. Neither the baseline nor the reference transits the
 * model. What comes back is a number, a verdict, and the specific rectangles
 * that are wrong — mapped to node ids.
 *
 * ## The five steps, in one call
 *
 * The same reasoning `screenshot.ts` records for collapsing its own three-step
 * ritual, one level up: an agent that must remember a five-step ritual before
 * every check will skip it, and a partial ritual produces a number that reads
 * as evidence while measuring the wrong thing.
 *
 *   1. Resolve the screen by NAME (`pageNameMatch.ts`) and the reference by
 *      page scope — neither needs a prior lookup call.
 *   2. Place a board frame for it if it has none (`syncBoardFramesFromDisk`).
 *   3. Pick the capture dpr that lands on the reference's own pixel width, so
 *      the common case is an EXACT-size comparison rather than a resampled
 *      one (the same computation `studio_recommend_export_dpr` exposes).
 *   4. Await the canvas re-read, then capture through the live editor bridge.
 *   5. Diff against the reference bytes and score it.
 *
 * ## What `pass` means, and what it does not
 *
 * It does not mean pixel-identity. A browser rasterises text with different
 * hinting and antialiasing than Figma's renderer, so two *correct* renderings
 * of the same screen still differ by a small, irreducible margin of edge
 * pixels. A tool that demanded 100% would report every screen as broken
 * forever and teach the agent to ignore it.
 *
 * `pass` is therefore two conditions, and the second is the one that matters:
 *
 *   - overall similarity at or above `passScore` (default 98%), AND
 *   - no single differing REGION covering more than `maxRegionCoverage` (default
 *     1.5%) of the frame.
 *
 * A structural defect — wrong spacing, a missing element, the wrong button
 * fill, text overlapping a heading — is always a contiguous region well above
 * that coverage floor. Font antialiasing is not: it is spread thinly across
 * every glyph edge and never forms one. The region test is what separates "this
 * is a different design" from "this is the same design on a different
 * rasteriser", which a single global percentage cannot do.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk, type AiToolImage } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/pageScaffold'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import {
  getDesignReference,
  listDesignReferences,
  readDesignReferenceBytes,
} from '../../../../handlers/studio/designReferenceStore'
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'
import { getEditorBridgeForUser } from '../../editorBridge'
import { awaitStudioLiveReload } from './liveReloadPush'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolvePageByName } from './pageNameMatch'
import {
  computeFrameDiff,
  decodePngBase64,
  decodePngBuffer,
  reconcileReference,
  type NodeRect,
} from './frameDiffEngine'

const DEFAULT_TOP_N = 6
const MAX_TOP_N = 20
/** Overall similarity at or above this counts toward a pass. See module doc for why it is not 100. */
const DEFAULT_PASS_SCORE = 98
/** No single differing region may cover more than this share of the frame. The structural test. */
const DEFAULT_MAX_REGION_COVERAGE = 1.5
const DPR_MIN = 0.5
const DPR_MAX = 3

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    page: Type.String({
      minLength: 1,
      description: 'The screen to measure, named the way you named the file — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work.',
    }),
    referenceId: Type.Optional(
      Type.String({ description: 'Which registered design reference to measure against. Omit to use the one scoped to this page (or, if none is, the most recently registered reference) — which is what you want in the ordinary case.' }),
    ),
    topN: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_TOP_N, description: `How many differing regions to return, worst first. Default ${DEFAULT_TOP_N}.` }),
    ),
    passScore: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `Overall similarity percentage required to pass. Default ${DEFAULT_PASS_SCORE}. Raising this toward 100 does not make the screen more accurate — it makes the verdict measure font rasterisation instead of design.` }),
    ),
    maxRegionCoverage: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `The largest share of the frame (percent) any single differing region may cover and still pass. Default ${DEFAULT_MAX_REGION_COVERAGE}. This is the structural test — lower it to catch smaller defects.` }),
    ),
  },
  { additionalProperties: false },
)

/** The reference to measure against: an explicit id, else this page's own, else the most recent one registered for the project. */
function resolveReference(
  dir: string,
  pageId: string,
  referenceId: string | undefined,
): { ok: true; reference: DesignReference; implicit: boolean } | { ok: false; error: string } {
  if (referenceId !== undefined) {
    const explicit = getDesignReference(dir, referenceId)
    if (!explicit) {
      return { ok: false, error: `No design reference "${referenceId}" is registered for this project — call studio_list_design_references to see what is.` }
    }
    return { ok: true, reference: explicit, implicit: false }
  }

  const scoped = listDesignReferences(dir, pageId, undefined)
  const forPage = scoped.references[scoped.references.length - 1]
  if (forPage) return { ok: true, reference: forPage, implicit: true }

  const all = listDesignReferences(dir, undefined, undefined)
  const mostRecent = all.references[all.references.length - 1]
  if (mostRecent) return { ok: true, reference: mostRecent, implicit: true }

  return {
    ok: false,
    error:
      `There is no design reference registered for this project, so there is nothing to measure "${pageId}" against. If the user gave you a design — a Figma export, an attached image, a URL — register it with studio_register_design_reference (pass pageId:"${pageId}") and call this again. If they did not, say so rather than guessing at a score: without a reference, "does it match" has no answer.`,
  }
}

/** The capture dpr that lands the frame on the reference's own pixel width, so the comparison is exact rather than resampled. */
function captureDprFor(dir: string, pageId: string, referenceWidth: number): number | null {
  const frameWidth = authoredFrameWidth(dir, pageId)
  if (frameWidth === null || frameWidth <= 0) return null
  const ideal = referenceWidth / frameWidth
  return Math.round(Math.min(DPR_MAX, Math.max(DPR_MIN, ideal)) * 10_000) / 10_000
}

interface CapturedFrame {
  ok: boolean
  pageId: string
  width?: number
  height?: number
  imageIndex?: number
  nodeRects?: NodeRect[]
  error?: string
}

export const studioCompareTool: AiTool = {
  name: 'studio_compare',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Measure a screen against the design it is supposed to match, and get a verdict instead of an opinion. Captures the live screen at the resolution that matches the registered design reference, diffs the two server-side, and returns { pass, similarityScore, regions[] } plus three images: your screen, the reference, and the diff. Each region is a rectangle that is actually wrong, worst first, with the node ids inside it — so "it looks off" becomes "this 240x88 block at y=412 is 71% different and covers these nodes". Name the screen the way you named the file ("Checkout"); the reference is picked up automatically from the ones registered for that page. `pass` is deliberately NOT pixel-identity — a browser and Figma rasterise text differently, so it requires high overall similarity AND no single differing region big enough to be structural. A failing result is a work list: fix the largest region first, then call this again. Use this rather than studio_diff_frames — a capture reaches you as an image you cannot turn back into the base64 that tool wants.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, page, referenceId, topN, passScore, maxRegionCoverage } = input as {
      dir?: string
      page: string
      referenceId?: string
      topN?: number
      passScore?: number
      maxRegionCoverage?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const bridge = getEditorBridgeForUser(ctx.userId, 'site')
    if (!bridge) {
      return aiToolError('No Studio board is open in a browser. Measuring means capturing the live canvas — open the project in Studio and try again.')
    }

    // 1 + 2. Reconcile the board with disk, then resolve the screen by name.
    syncBoardFramesFromDisk(dir)
    const { pages } = await loadStudioPages(dir)
    const match = resolvePageByName(pages, page)
    if (!match) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(`No screen matched "${page}". This project has: ${known}.`)
    }

    const resolved = resolveReference(dir, match.id, referenceId)
    if (!resolved.ok) return aiToolError(resolved.error)
    const { reference } = resolved

    const referenceBytes = readDesignReferenceBytes(dir, reference)
    if (!referenceBytes) {
      return aiToolError(`Design reference "${reference.id}" is registered but its file could not be read from disk — it may have been removed outside Studio.`)
    }

    // 3 + 4. Capture at the dpr that makes the comparison exact.
    const dpr = captureDprFor(dir, match.id, reference.width)
    await awaitStudioLiveReload(ctx.userId, { dir, pageIds: [match.id], boardsChanged: true })

    const captured = await bridge.callBrowser('studio_export_frames', {
      pageIds: [match.id],
      ...(dpr === null ? {} : { dpr }),
    })
    if (!captured.ok) return captured

    const frames = ((captured.data as { frames?: CapturedFrame[] } | null)?.frames ?? [])
    const frame = frames[0]
    if (!frame || !frame.ok || frame.imageIndex === undefined) {
      return aiToolError(`Could not capture "${match.title}": ${frame?.error ?? 'the frame did not render.'}`)
    }
    const capturedImage = captured.images?.[frame.imageIndex]
    if (!capturedImage) {
      return aiToolError(`The capture of "${match.title}" returned no image data.`)
    }

    // 5. Score it. Both images stay in this process.
    const baseline = (() => {
      try {
        return decodePngBase64(capturedImage.data, 'captured screen')
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err))
      }
    })()
    if (baseline instanceof Error) {
      return aiToolError(`Could not decode the captured screen: ${baseline.message}`)
    }

    const reconciled = await reconcileReference(referenceBytes, reference.width, reference.height, baseline.width, baseline.height)
    if (!reconciled.ok) return aiToolError(reconciled.error)

    let referenceImage
    try {
      referenceImage = decodePngBuffer(reconciled.result.pngBuffer, 'reference')
    } catch (err) {
      return aiToolError(`Could not decode the design reference: ${err instanceof Error ? err.message : String(err)}`)
    }

    const cap = topN ?? DEFAULT_TOP_N
    const diff = computeFrameDiff(baseline, referenceImage, { nodeRects: frame.nodeRects, topN: cap })

    const requiredScore = passScore ?? DEFAULT_PASS_SCORE
    const coverageLimit = maxRegionCoverage ?? DEFAULT_MAX_REGION_COVERAGE
    const worstRegion = diff.regions[0]
    const structuralRegions = diff.regions.filter((r) => r.frameCoveragePercent > coverageLimit)
    const pass = diff.similarityScore >= requiredScore && structuralRegions.length === 0

    const verdict = pass
      ? `Matches the reference: ${diff.similarityScore.toFixed(2)}% similar, no structural differences. Remaining differences are below the ${coverageLimit}%-of-frame floor — that is text rasterisation, not design.`
      : diff.similarityScore < requiredScore && structuralRegions.length > 0
        ? `Does NOT match: ${diff.similarityScore.toFixed(2)}% similar (needs ${requiredScore}%), and ${structuralRegions.length} region(s) are large enough to be structural. Fix the largest region first — it is listed first in regions[] with the node ids it covers — then measure again.`
        : structuralRegions.length > 0
          ? `Does NOT match: overall similarity is fine (${diff.similarityScore.toFixed(2)}%) but ${structuralRegions.length} region(s) differ structurally — something in a specific place is wrong, not the whole screen. Start with regions[0].`
          : `Does NOT match: ${diff.similarityScore.toFixed(2)}% similar (needs ${requiredScore}%), spread thinly rather than concentrated in one region. Usually a colour, a font, or a global spacing value that is slightly off everywhere.`

    const images: AiToolImage[] = [
      { mimeType: 'image/png', data: capturedImage.data },
      { mimeType: reference.mimeType, data: Buffer.from(referenceBytes).toString('base64') },
      { mimeType: 'image/png', data: diff.diffPngBuffer.toString('base64') },
    ]

    return aiToolOk(
      {
        ok: true,
        pass,
        verdict,
        page: { id: match.id, title: match.title },
        reference: {
          id: reference.id,
          ...(reference.label ? { label: reference.label } : {}),
          width: reference.width,
          height: reference.height,
          autoSelected: resolved.implicit,
        },
        similarityScore: diff.similarityScore,
        diffPercent: diff.diffPercent,
        thresholds: { passScore: requiredScore, maxRegionCoverage: coverageLimit },
        capture: {
          width: diff.width,
          height: diff.height,
          dpr: dpr ?? 1,
          dimensionMatch: reconciled.result.method,
        },
        structuralRegionCount: structuralRegions.length,
        regions: diff.regions,
        regionsTruncated: diff.regionsTruncated,
        ...(worstRegion && !pass
          ? { worstRegionNodeIds: worstRegion.nodeIds }
          : {}),
        images: { 0: 'your screen', 1: 'the design reference', 2: 'the diff' },
      },
      images,
    )
  },
}

export const studioCompareMcpTools: AiTool[] = [studioCompareTool]
