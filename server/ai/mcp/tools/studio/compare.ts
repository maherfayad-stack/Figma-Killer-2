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
 * ## Batching (mcp-tooling CHANGE A)
 *
 * Takes `pages`, not `page` — the same name-resolved, optional, capped array
 * `studio_screenshot` established first (`resolveRequestedPages`,
 * `MAX_BATCH_PAGES` in `pageNameMatch.ts`). Per-page work (resolve the
 * reference, pick the dpr, capture, diff) happens in a loop; per-batch work
 * (board sync, page load, the live-reload wait) happens ONCE ahead of it, the
 * same split `screenshot.ts` uses for its own `canonicalProject`. One page
 * failing to resolve or having no armed reference never fails the batch — it
 * becomes a `results[]` entry with `ok:false` while every other page still
 * gets measured.
 *
 * `includeImages` defaults to `true` for a single-page call (unchanged
 * behaviour) and to `false` the moment a call resolves to MORE than one page —
 * three images per page was already the expensive part of a single response;
 * twenty pages' worth is not a viable payload, so the model has to ask for
 * images explicitly once it is comparing more than one screen at a time.
 *
 * The top-level `pass` is honest, not optimistic: `true` only when every
 * requested name resolved to a page AND every one of those pages passed. A
 * page that could not be measured (no reference, capture failure, decode
 * failure) is never silently counted as a pass — it shows up in `results[]`
 * with `ok:false` and drags the aggregate down.
 *
 * ## Caching (mcp-tooling CHANGE B)
 *
 * A fix-verify loop calls this tool again and again on pages it has not
 * touched since the last call. `compareVerdictCache.ts` skips the whole
 * capture-and-diff cost — including the bridge connection itself, when EVERY
 * requested page hits — for a page whose source file, imported stylesheets,
 * `.studio/framework.json`, and `.studio/boards.json` are all provably
 * unchanged since the last compare against the SAME reference and thresholds.
 * See that module's doc for exactly what is tracked and why. `forceRecapture`
 * is the explicit escape hatch. Every result names whether it came from cache
 * (`fromCache`).
 *
 * ## The five steps, in one call
 *
 * The same reasoning `screenshot.ts` records for collapsing its own three-step
 * ritual, one level up: an agent that must remember a five-step ritual before
 * every check will skip it, and a partial ritual produces a number that reads
 * as evidence while measuring the wrong thing.
 *
 *   1. Resolve each screen by NAME (`pageNameMatch.ts`) and its reference by
 *      page scope — neither needs a prior lookup call.
 *   2. Place a board frame for any of them that has none (`syncBoardFramesFromDisk`).
 *   3. Pick the capture dpr that lands on the reference's own pixel width, so
 *      the common case is an EXACT-size comparison rather than a resampled
 *      one (the same computation `studio_recommend_export_dpr` exposes).
 *   4. Await the canvas re-read, then capture through the live editor bridge —
 *      skipped entirely for a page the verdict cache already answers.
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
import { join } from 'node:path'
import { createWorkspaceProject, parsePageFile } from '@core/page-parser'
import { collectPageStylesheets } from '@core/studio-sync/collectPageStylesheets'
import type { Page } from '@core/page-tree'
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk, type AiToolImage } from '@core/ai'
import type { AiBrowserBridge, AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/pageScaffold'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import { readDesignReferenceBytes } from '../../../../handlers/studio/designReferenceStore'
import { recordPassingCompare } from '../../../../handlers/studio/pageVerificationStore'
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { resolveDesignReference } from './referenceResolve'
import { awaitEditorBridgeForUser } from '../../editorBridge'
import { awaitStudioLiveReload } from './liveReloadPush'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { MAX_BATCH_PAGES, resolveRequestedPages } from './pageNameMatch'
import {
  buildCompareCacheKey,
  getCachedCompareVerdict,
  setCachedCompareVerdict,
  type CachedCompareVerdict,
} from './compareVerdictCache'
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
    pages: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_BATCH_PAGES,
        description:
          'Which screens to measure, by name — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work. Omit to measure every screen in the project (up to 20) that has a registered reference; a screen with none becomes a per-result error rather than failing the whole call.',
      }),
    ),
    referenceId: Type.Optional(
      Type.String({ description: 'Which registered design reference to measure against, applied to every page in this call. Omit to let each page pick up its OWN scoped reference (or, if none is, the most recently registered one) — which is what you want in the ordinary case, especially when measuring several pages at once.' }),
    ),
    topN: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_TOP_N, description: `How many differing regions to return per page, worst first. Default ${DEFAULT_TOP_N}.` }),
    ),
    passScore: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `Overall similarity percentage required to pass. Default ${DEFAULT_PASS_SCORE}. Raising this toward 100 does not make the screen more accurate — it makes the verdict measure font rasterisation instead of design.` }),
    ),
    maxRegionCoverage: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `The largest share of the frame (percent) any single differing region may cover and still pass. Default ${DEFAULT_MAX_REGION_COVERAGE}. This is the structural test — lower it to catch smaller defects.` }),
    ),
    includeImages: Type.Optional(
      Type.Boolean({
        description:
          'Whether to attach each page\'s three images (your screen, the reference, the diff) to its result. Default true for a SINGLE requested page (unchanged behaviour); default FALSE the moment this call resolves to more than one page — three images per page is already the expensive part of one response, and twenty pages\' worth is not a viable payload, so a multi-page call only gets images if you ask for them. The prescribed loop calls this tool after EVERY fix pass, so pass includeImages:false explicitly even on a single-page call once you already know roughly what is wrong and only need the numbers to confirm a fix landed.',
      }),
    ),
    forceRecapture: Type.Optional(
      Type.Boolean({
        description:
          'Skip the verdict cache and force a fresh capture + diff for every requested page, even if this tool believes nothing has changed since the last compare. The cache tracks each page\'s own source file, its imported stylesheets, .studio/framework.json, and .studio/boards.json — a change OUTSIDE that set (an edited Tailwind config, a new dependency) will not be noticed automatically; set this to true after a change like that. Default false.',
      }),
    ),
  },
  { additionalProperties: false },
)

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
  /** See `compare.ts`'s previous single-page revision / `computeFrameDiff`'s `nodeRects.imageScale` doc for why this has no default. */
  imageScale?: number
  error?: string
}

interface PageCompareSuccess {
  ok: true
  page: { id: string; title: string }
  fromCache: boolean
  pass: boolean
  verdict: string
  reference: { id: string; label?: string; width: number; height: number; autoSelected: boolean }
  similarityScore: number
  diffPercent: number
  thresholds: { passScore: number; maxRegionCoverage: number }
  capture: CachedCompareVerdict['capture']
  structuralRegionCount: number
  regions: CachedCompareVerdict['regions']
  regionsTruncated: boolean
  worstRegionNodeIds?: string[]
  images?: { screen: number; reference: number; diff: number }
}

interface PageCompareFailure {
  ok: false
  page: { id: string; title: string }
  error: string
}

type PageCompareResult = PageCompareSuccess | PageCompareFailure

/**
 * The absolute files whose mtimes gate this page's cache entry, or `null`
 * when they cannot be safely determined (no decodable source location, or the
 * discovery parse itself failed) — a `null` means "never use the cache for
 * this page", not "no dependencies". `project` is built lazily by the caller
 * and shared across every page in the batch that needs this, mirroring
 * `screenshot.ts`'s `canonicalProject`.
 */
function compareCacheDepFiles(
  dir: string,
  page: Page,
  project: ReturnType<typeof createWorkspaceProject>,
): string[] | null {
  const relFile = resolvePageSourceFile(page)
  if (!relFile) return null
  const absFile = join(dir, ...relFile.split('/'))
  let stylesheetFiles: string[]
  try {
    const parsed = parsePageFile(absFile, dir, project, { workspaceRoot: dir })
    stylesheetFiles = collectPageStylesheets(parsed, relFile, project, dir).map((s) => s.absPath)
  } catch (err) {
    console.error(`[studio_compare] could not discover ${relFile}'s stylesheets for cache tracking:`, err)
    return null
  }
  return [
    absFile,
    ...stylesheetFiles,
    join(dir, '.studio', 'framework.json'),
    join(dir, '.studio', 'boards.json'),
  ]
}

export const studioCompareTool: AiTool = {
  name: 'studio_compare',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Measure one or more screens against the design they are supposed to match, and get a verdict instead of an opinion. Captures each live screen at the resolution that matches its registered design reference, diffs server-side, and returns { pass, results[] }. Each results[] entry carries { pass, similarityScore, regions[] } plus, by default (single page only — see includeImages), three images: your screen, the reference, and the diff. Each region is a rectangle that is actually wrong, worst first, with the node ids inside it — so "it looks off" becomes "this 240x88 block at y=412 is 71% different and covers these nodes". Name screens the way you named the files ("Checkout"), or pass several at once ("Checkout", "Cart", "Confirm") to verify a whole flow in one call instead of one round trip per screen — the reference for each is picked up automatically from the one registered for that page. Repeat calls on a page you have not written to since the last compare are usually served from an internal verdict cache (results[].fromCache) — no recapture, no bridge round trip — unless you pass forceRecapture. `pass` is deliberately NOT pixel-identity — a browser and Figma rasterise text differently, so it requires high overall similarity AND no single differing region big enough to be structural; the top-level `pass` is true only when EVERY requested page resolved to a screen and passed — a page with no registered reference or a failed capture becomes a results[] entry with ok:false and always drags the top-level verdict down, never a silent pass. A failing result is a work list: fix the largest region first, then call this again. capture.dimensionMatch is "resampled", not "exact", whenever the captured screen could not be produced at the reference\'s own pixel size — the vision-safe capture cap (~1568px, applied to BOTH width and height) is the usual cause on a tall mobile screen, and capture.dimensionMatchNote names the axis and explains it when this fires: treat that verdict as directional, not exact-pixel. Use this rather than studio_diff_frames — a capture reaches you as an image you cannot turn back into the base64 that tool wants.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const {
      dir: dirInput,
      pages: requested,
      referenceId,
      topN,
      passScore,
      maxRegionCoverage,
      includeImages,
      forceRecapture,
    } = input as {
      dir?: string
      pages?: string[]
      referenceId?: string
      topN?: number
      passScore?: number
      maxRegionCoverage?: number
      includeImages?: boolean
      forceRecapture?: boolean
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    // 1 + 2. Board sync + page load never need the bridge — do them before
    // deciding whether the bridge is needed at all, so an all-cache-hit batch
    // never touches it.
    const placed = syncBoardFramesFromDisk(dir)
    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_BATCH_PAGES)
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(
        unmatched.length > 0
          ? `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}. This project has: ${known}.`
          : `This project has no screens to compare yet.`,
      )
    }

    const pageById = new Map(pages.map((p) => [p.id, p]))
    const cap = topN ?? DEFAULT_TOP_N
    const requiredScore = passScore ?? DEFAULT_PASS_SCORE
    const coverageLimit = maxRegionCoverage ?? DEFAULT_MAX_REGION_COVERAGE

    // 1 (reference half). Resolve each page's reference and cache key up
    // front — cheap, no bridge, no capture — so the cache lookup below can
    // decide whether the bridge is needed at all.
    interface PlanEntry {
      pageId: string
      page: Page
      referenceError?: string
      reference?: DesignReference
      autoSelected?: boolean
      cacheKey?: string
      cached?: CachedCompareVerdict | null
    }
    const plan: PlanEntry[] = ids.map((pageId) => {
      const page = pageById.get(pageId)!
      const resolved = resolveDesignReference(dir, pageId, referenceId)
      if (!resolved.ok) return { pageId, page, referenceError: resolved.error }
      const cacheKey = buildCompareCacheKey(dir, pageId, resolved.reference.id, requiredScore, coverageLimit, cap)
      const cached = forceRecapture ? null : getCachedCompareVerdict(cacheKey)
      return {
        pageId,
        page,
        reference: resolved.reference,
        autoSelected: resolved.implicit,
        cacheKey,
        cached,
      }
    })

    const needsCapture = plan.some((p) => !p.referenceError && !p.cached)
    let bridge: AiBrowserBridge | null = null
    if (needsCapture) {
      bridge = await awaitEditorBridgeForUser(ctx.userId, 'site', ctx.signal)
      if (!bridge) {
        return aiToolError('No Studio board is connected. Measuring captures the live canvas, so it needs the project open in a Studio browser tab. If it IS open, the tab reconnects on its own within a few seconds — just call this again once.')
      }
      // 4. Awaited once for every page that actually needs a fresh capture —
      // a page served from cache never re-reads the board at all.
      const missPageIds = plan.filter((p) => !p.referenceError && !p.cached).map((p) => p.pageId)
      await awaitStudioLiveReload(ctx.userId, { dir, pageIds: missPageIds, boardsChanged: true })
    }

    // Built lazily, ONCE for the whole batch, and only if some page's cache
    // entry actually needs writing — mirrors `screenshot.ts`'s
    // `canonicalProject` (shared per-batch work built exactly once).
    let sharedProject: ReturnType<typeof createWorkspaceProject> | undefined

    const results: PageCompareResult[] = []
    const images: AiToolImage[] = []
    const singlePage = ids.length === 1
    const wantImages = includeImages ?? singlePage

    for (const entry of plan) {
      const title = entry.page.title
      if (entry.referenceError) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: entry.referenceError })
        continue
      }
      const ref = entry.reference!
      const autoSelected = entry.autoSelected!

      if (entry.cached) {
        const c = entry.cached
        const result: PageCompareSuccess = {
          ok: true,
          page: { id: entry.pageId, title },
          fromCache: true,
          pass: c.pass,
          verdict: c.verdict,
          reference: { id: ref.id, ...(ref.label ? { label: ref.label } : {}), width: ref.width, height: ref.height, autoSelected },
          similarityScore: c.similarityScore,
          diffPercent: c.diffPercent,
          thresholds: { passScore: requiredScore, maxRegionCoverage: coverageLimit },
          capture: c.capture,
          structuralRegionCount: c.structuralRegionCount,
          regions: c.regions,
          regionsTruncated: c.regionsTruncated,
          ...(c.worstRegionNodeIds ? { worstRegionNodeIds: c.worstRegionNodeIds } : {}),
        }
        if (wantImages) {
          const screenIdx = images.push({ mimeType: 'image/png', data: c.images.screenBase64 }) - 1
          const referenceIdx = images.push({ mimeType: c.images.referenceMimeType, data: c.images.referenceBase64 }) - 1
          const diffIdx = images.push({ mimeType: 'image/png', data: c.images.diffBase64 }) - 1
          result.images = { screen: screenIdx, reference: referenceIdx, diff: diffIdx }
        }
        results.push(result)
        continue
      }

      // MISS. 3 + 4. Capture at the dpr that makes the comparison exact.
      const referenceBytes = readDesignReferenceBytes(dir, ref)
      if (!referenceBytes) {
        results.push({
          ok: false,
          page: { id: entry.pageId, title },
          error: `Design reference "${ref.id}" is registered but its file could not be read from disk — it may have been removed outside Studio.`,
        })
        continue
      }

      const dpr = captureDprFor(dir, entry.pageId, ref.width)
      const captured = await bridge!.callBrowser('studio_export_frames', {
        pageIds: [entry.pageId],
        ...(dpr === null ? {} : { dpr }),
        // This capture is measured server-side with pixelmatch, not shown to
        // the model by default — the vision-safe ~1568px edge clamp exists for
        // a reason that does not apply here (A2). Model visibility is decided
        // separately, below, by `includeImages`.
        purpose: 'measurement',
      })
      if (!captured.ok) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: captured.error ?? `Could not capture "${title}".` })
        continue
      }

      const frames = ((captured.data as { frames?: CapturedFrame[] } | null)?.frames ?? [])
      const frame = frames[0]
      if (!frame || !frame.ok || frame.imageIndex === undefined) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `Could not capture "${title}": ${frame?.error ?? 'the frame did not render.'}` })
        continue
      }
      const capturedImage = captured.images?.[frame.imageIndex]
      if (!capturedImage) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `The capture of "${title}" returned no image data.` })
        continue
      }

      // 5. Score it. Both images stay in this process.
      let baseline: ReturnType<typeof decodePngBase64>
      try {
        baseline = decodePngBase64(capturedImage.data, 'captured screen')
      } catch (err) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `Could not decode the captured screen: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }

      const reconciled = await reconcileReference(referenceBytes, ref.width, ref.height, baseline.width, baseline.height)
      if (!reconciled.ok) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: reconciled.error })
        continue
      }

      let referenceImage: ReturnType<typeof decodePngBuffer>
      try {
        referenceImage = decodePngBuffer(reconciled.result.pngBuffer, 'reference')
      } catch (err) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `Could not decode the design reference: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }

      const diff = computeFrameDiff(baseline, referenceImage, {
        nodeRects: frame.nodeRects ? { rects: frame.nodeRects, imageScale: frame.imageScale ?? 1 } : undefined,
        topN: cap,
      })

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

      const captureMeta: CachedCompareVerdict['capture'] = {
        width: diff.width,
        height: diff.height,
        dpr: dpr ?? 1,
        dimensionMatch: reconciled.result.method,
        ...(reconciled.result.note ? { dimensionMatchNote: reconciled.result.note } : {}),
      }
      const referenceBase64 = Buffer.from(referenceBytes).toString('base64')
      const diffBase64 = diff.diffPngBuffer.toString('base64')

      const result: PageCompareSuccess = {
        ok: true,
        page: { id: entry.pageId, title },
        fromCache: false,
        pass,
        verdict,
        reference: { id: ref.id, ...(ref.label ? { label: ref.label } : {}), width: ref.width, height: ref.height, autoSelected },
        similarityScore: diff.similarityScore,
        diffPercent: diff.diffPercent,
        thresholds: { passScore: requiredScore, maxRegionCoverage: coverageLimit },
        capture: captureMeta,
        structuralRegionCount: structuralRegions.length,
        regions: diff.regions,
        regionsTruncated: diff.regionsTruncated,
        ...(worstRegion && !pass ? { worstRegionNodeIds: worstRegion.nodeIds } : {}),
      }
      if (wantImages) {
        const screenIdx = images.push({ mimeType: 'image/png', data: capturedImage.data }) - 1
        const referenceIdx = images.push({ mimeType: ref.mimeType, data: referenceBase64 }) - 1
        const diffIdx = images.push({ mimeType: 'image/png', data: diffBase64 }) - 1
        result.images = { screen: screenIdx, reference: referenceIdx, diff: diffIdx }
      }
      results.push(result)

      // Write-through: discover this page's dependency files (parse cost paid
      // ONLY on a miss, alongside the much larger capture+diff cost already
      // just paid) and cache the verdict for next time.
      if (!sharedProject) sharedProject = createWorkspaceProject(dir)
      const depFiles = compareCacheDepFiles(dir, entry.page, sharedProject)
      if (depFiles && entry.cacheKey) {
        setCachedCompareVerdict(entry.cacheKey, depFiles, {
          pass,
          verdict,
          similarityScore: diff.similarityScore,
          diffPercent: diff.diffPercent,
          capture: captureMeta,
          structuralRegionCount: structuralRegions.length,
          regions: diff.regions,
          regionsTruncated: diff.regionsTruncated,
          ...(worstRegion && !pass ? { worstRegionNodeIds: worstRegion.nodeIds } : {}),
          images: { screenBase64: capturedImage.data, referenceBase64, referenceMimeType: ref.mimeType, diffBase64 },
        })
      }
    }

    // verification-gate item 2 — durably record every PASSING result, cache
    // hit or fresh capture alike (a cache hit still means the page's CURRENT
    // on-disk bytes pass: `compareVerdictCache`'s own validity check already
    // requires every tracked file's mtime to be unchanged since the verdict
    // was computed). This is what lets a completely separate process — the
    // Stop hook's checker script, spawned by the `claude` CLI with no access
    // to this server's memory — answer "has this page been verified since it
    // was last written" without re-running a capture.
    for (const result of results) {
      if (result.ok && result.pass) recordPassingCompare(dir, result.page.id, result.reference.id)
    }

    const passCount = results.filter((r) => r.ok && r.pass).length
    const errorCount = results.filter((r) => !r.ok).length
    const failCount = results.length - passCount - errorCount
    // Honest aggregate: an unmatched name or a per-page error is never a
    // silent pass.
    const pass = unmatched.length === 0 && results.length > 0 && results.every((r) => r.ok && r.pass)

    return aiToolOk(
      {
        ok: true,
        dir,
        pass,
        passCount,
        failCount,
        errorCount,
        results,
        ...(unmatched.length > 0 ? { unmatched } : {}),
        ...(placed.length > 0 ? { newlyPlacedOnBoard: placed } : {}),
      },
      images,
    )
  },
}

export const studioCompareMcpTools: AiTool[] = [studioCompareTool]
