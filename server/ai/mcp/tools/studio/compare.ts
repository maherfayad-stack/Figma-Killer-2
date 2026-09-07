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
 * reference, pick the dpr, diff) happens in a loop; per-batch work (board sync,
 * page load, and — see `captureMissedPages` — the CAPTURE
 * itself) happens ONCE ahead of it, the same split `screenshot.ts` uses for its
 * own `canonicalProject`. One page failing to resolve or having no armed
 * reference never fails the batch — it becomes a `results[]` entry with
 * `ok:false` while every other page still gets measured.
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
 *   4. Await the canvas re-read, then capture every cache-miss page in ONE
 *      call per dpr (`captureMissedPages`) — headlessly by default (W4-2A),
 *      through the live editor bridge only as a fallback — skipped entirely
 *      for a page the verdict cache already answers.
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
 *   - overall similarity at or above `passScore`, AND
 *   - no single differing REGION covering more than `maxRegionCoverage` of the
 *     frame.
 *
 * W9-2 added a third for strict, and made all three come from the resolved
 * fidelity mode rather than from one hardcoded pair. `creative` /
 * `balanced` / `strict` each name their own `passScore` and
 * `maxRegionCoverage` (`FIDELITY_THRESHOLDS`); strict additionally applies an
 * ABSOLUTE per-region area floor, because coverage is a percentage of the
 * frame and a percentage of a tall page is a big rectangle — a 24x24 icon
 * rendered completely wrong is 0.02% of a 375x2400 screen and passed the
 * structural test every time. The mode is resolved per page, so two screens
 * in one batch can be graded differently when their designs were registered
 * differently.
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
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/boardFrames'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import { readDesignReferenceBytes } from '../../../../handlers/studio/designReferenceStore'
import { recordPassingCompare } from '../../../../handlers/studio/pageVerificationStore'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { resolveDesignReference } from './referenceResolve'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import {
  FIDELITY_MODES,
  FIDELITY_THRESHOLDS,
  type FidelityMode,
} from '../../../../handlers/studio/fidelityMode'
import { gradeFrameDiff, resolvePageGrading, type PageGrading } from './compareGrading'
import { captureMissedPages, type PageCapture } from './compareCapture'
import { readAgentSessionFidelityMode, readStudioMeta } from '../../../../handlers/studio/studioMeta'
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
} from './frameDiffEngine'

const DEFAULT_TOP_N = 6
const MAX_TOP_N = 20
// W9-2 — the pass bar is no longer one pair of constants. It comes from the
// resolved fidelity mode's row in `FIDELITY_THRESHOLDS`, resolved PER PAGE
// (a design reference can declare its own mode), and every result reports the
// numbers it was actually graded against under `thresholds` so an agent never
// has to infer them. See `resolveGrading` below.
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
    fidelityMode: Type.Optional(
      Type.Union(FIDELITY_MODES.map((m) => Type.Literal(m)), {
        description: `How strictly to grade, which is the same thing as which thresholds to apply. "creative" (${FIDELITY_THRESHOLDS.creative.passScore}% / ${FIDELITY_THRESHOLDS.creative.maxRegionCoverage}%) is directional only — a pass is not a fidelity claim. "balanced" (${FIDELITY_THRESHOLDS.balanced.passScore}% / ${FIDELITY_THRESHOLDS.balanced.maxRegionCoverage}%) leaves room for deliberate deviation. "strict" (${FIDELITY_THRESHOLDS.strict.passScore}% / ${FIDELITY_THRESHOLDS.strict.maxRegionCoverage}%, plus an absolute ~${FIDELITY_THRESHOLDS.strict.maxRegionPixels}px² per-region area floor that catches a small element rendered entirely wrong) also refuses to grade a screen against a reference that was not registered for it. Omit this: the mode is resolved for you from the design reference, this session, and the project default. Pass it only to grade one call differently on purpose, and never to lower the bar on a screen that is failing.`,
      }),
    ),
    passScore: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `Overall similarity percentage required to pass, overriding the fidelity mode's own. Raising this toward 100 does not make the screen more accurate — it makes the verdict measure font rasterisation instead of design.` }),
    ),
    maxRegionCoverage: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100, description: `The largest share of the frame (percent) any single differing region may cover and still pass, overriding the fidelity mode's own. This is the structural test — lower it to catch smaller defects.` }),
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

interface PageCompareSuccess {
  ok: true
  page: { id: string; title: string }
  fromCache: boolean
  pass: boolean
  verdict: string
  reference: { id: string; label?: string; width: number; height: number; autoSelected: boolean }
  similarityScore: number
  diffPercent: number
  thresholds: { fidelityMode: FidelityMode; passScore: number; maxRegionCoverage: number; maxRegionPixels: number | null }
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
    'Measure one or more screens against the design they are supposed to match, and get a verdict instead of an opinion. Captures each screen at the resolution that matches its registered design reference, diffs server-side, and returns { pass, results[] }. It does NOT need a Studio browser tab open and never disturbs one that is: the capture runs headlessly on the server against what is on disk, falling back to an open editor tab only if the headless browser cannot run (`capturedVia` says which answered, and a failure of BOTH names both reasons rather than blaming a missing board). Each results[] entry carries { pass, similarityScore, regions[] } plus, by default (single page only — see includeImages), three images: your screen, the reference, and the diff. Each region is a rectangle that is actually wrong, worst first, with the node ids inside it — so "it looks off" becomes "this 240x88 block at y=412 is 71% different and covers these nodes". Name screens the way you named the files ("Checkout"), or pass several at once ("Checkout", "Cart", "Confirm") to verify a whole flow in one call instead of one round trip per screen — the reference for each is picked up automatically from the one registered for that page. Repeat calls on a page you have not written to since the last compare are usually served from an internal verdict cache (results[].fromCache) — no recapture, no bridge round trip — unless you pass forceRecapture. `pass` is deliberately NOT pixel-identity — a browser and Figma rasterise text differently, so it requires high overall similarity AND no single differing region big enough to be structural; the top-level `pass` is true only when EVERY requested page resolved to a screen and passed — a page with no registered reference or a failed capture becomes a results[] entry with ok:false and always drags the top-level verdict down, never a silent pass. A failing result is a work list: fix the largest region first, then call this again. capture.dimensionMatch is "resampled", not "exact", whenever the captured screen could not be produced at the reference\'s own pixel size — the vision-safe capture cap (~1568px, applied to BOTH width and height) is the usual cause on a tall mobile screen, and capture.dimensionMatchNote names the axis and explains it when this fires: treat that verdict as directional, not exact-pixel. Use this rather than studio_diff_frames — a capture reaches you as an image you cannot turn back into the base64 that tool wants.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const {
      dir: dirInput,
      pages: requested,
      referenceId,
      topN,
      fidelityMode: fidelityModeArg,
      passScore,
      maxRegionCoverage,
      includeImages,
      forceRecapture,
    } = input as {
      dir?: string
      pages?: string[]
      referenceId?: string
      topN?: number
      fidelityMode?: FidelityMode
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
    // Tier 4 of the precedence chain, read once for the whole batch — it is
    // the same account and the same project for every page in the call.
    const projectFidelityMode = readAgentSessionFidelityMode(readStudioMeta(dir), studioAgentUserKey(ctx.userId)) ?? undefined

    // 1 (reference half). Resolve each page's reference and cache key up
    // front — cheap, no bridge, no capture — so the cache lookup below can
    // decide whether the bridge is needed at all.
    interface PlanEntry {
      pageId: string
      page: Page
      referenceError?: string
      reference?: DesignReference
      autoSelected?: boolean
      /** The resolved mode and the numbers it produced, per page — see the map below for why this is not one value for the batch. */
      grading?: PageGrading
      cacheKey?: string
      cached?: CachedCompareVerdict | null
    }
    const plan: PlanEntry[] = ids.map((pageId) => {
      const page = pageById.get(pageId)!
      const resolved = resolveDesignReference(dir, pageId, referenceId)
      if (!resolved.ok) return { pageId, page, referenceError: resolved.error }

      // W9-2 — the bar is resolved PER PAGE (`compareGrading.ts`), and a
      // strict call against a project-wide stand-in is refused there rather
      // than graded.
      const graded = resolvePageGrading({
        pageTitle: page.title,
        pageId,
        resolved,
        toolArg: fidelityModeArg,
        turn: ctx.fidelityMode,
        project: projectFidelityMode,
        passScore,
        maxRegionCoverage,
      })
      if (!graded.ok) return { pageId, page, referenceError: graded.error }
      const { grading } = graded
      const cacheKey = buildCompareCacheKey(dir, pageId, resolved.reference.id, grading.mode, grading.requiredScore, grading.coverageLimit, cap)
      const cached = forceRecapture ? null : getCachedCompareVerdict(cacheKey)
      return {
        pageId,
        page,
        reference: resolved.reference,
        autoSelected: resolved.implicit,
        grading,
        cacheKey,
        cached,
      }
    })

    // 3 + 4. Every cache-miss page is captured up front, batched — see
    // `captureMissedPages`. The per-page loop below only reads the results.
    const captureTargets = plan
      .filter((p) => !p.referenceError && !p.cached)
      .map((p) => ({ pageId: p.pageId, dpr: captureDprFor(dir, p.pageId, p.reference!.width) }))
    const dprByPageId = new Map(captureTargets.map((t) => [t.pageId, t.dpr]))
    let captures = new Map<string, PageCapture>()
    let capturedVia: 'headless' | 'live' | 'none' = 'none'
    if (captureTargets.length > 0) {
      // W9-5 lever 2 — the live-reload wait is NOT paid here. It only ever
      // mattered to an open tab, and the headless path (the default, and what
      // answers every capture on a host with Chromium) re-parses from disk on
      // every navigation. `captureFrames` now owns it and pays it only when it
      // actually falls back to the live bridge — see `reloadBeforeLiveFallback`.
      const captured = await captureMissedPages(ctx.userId, dir, captureTargets, ctx.signal)
      captures = captured.captures
      capturedVia = captured.source
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
          thresholds: {
            fidelityMode: entry.grading!.mode,
            passScore: entry.grading!.requiredScore,
            maxRegionCoverage: entry.grading!.coverageLimit,
            maxRegionPixels: entry.grading!.maxRegionPixelsAt1x,
          },
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

      // MISS. The capture already happened, batched, above.
      const referenceBytes = readDesignReferenceBytes(dir, ref)
      if (!referenceBytes) {
        results.push({
          ok: false,
          page: { id: entry.pageId, title },
          error: `Design reference "${ref.id}" is registered but its file could not be read from disk — it may have been removed outside Studio.`,
        })
        continue
      }

      const dpr = dprByPageId.get(entry.pageId) ?? null
      const capture = captures.get(entry.pageId)
      if (!capture) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `Could not capture "${title}": the board returned no frame for it.` })
        continue
      }
      if (!capture.ok) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: capture.error })
        continue
      }
      const frame = capture.frame
      if (!frame.ok || frame.imageIndex === undefined) {
        results.push({ ok: false, page: { id: entry.pageId, title }, error: `Could not capture "${title}": ${frame.error ?? 'the frame did not render.'}` })
        continue
      }
      const capturedImage = capture.images?.[frame.imageIndex]
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

      const grading = entry.grading!
      const worstRegion = diff.regions[0]
      const { pass, verdict, structuralRegions, regionPixelLimit } =
        gradeFrameDiff(diff, grading, authoredFrameWidth(dir, entry.pageId))

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
        thresholds: {
          fidelityMode: grading.mode,
          passScore: grading.requiredScore,
          maxRegionCoverage: grading.coverageLimit,
          maxRegionPixels: regionPixelLimit,
        },
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
    // Recorded under the CALLING account's key: this pass is what unblocks
    // that account's Stop gate, and must never unblock anybody else's.
    const agentUserKey = studioAgentUserKey(ctx.userId)
    for (const result of results) {
      if (result.ok && result.pass) {
        // The mode is recorded WITH the pass, not inferred later: the Stop
        // gate reads this file from a different process and has no way to
        // reconstruct which bar this verdict cleared.
        recordPassingCompare(dir, agentUserKey, result.page.id, result.reference.id, result.thresholds.fidelityMode)
      }
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
        // Which renderer produced this batch's captures. "none" means every
        // requested page was served from the verdict cache, so nothing was
        // captured at all.
        capturedVia,
        results,
        ...(unmatched.length > 0 ? { unmatched } : {}),
        ...(placed.length > 0 ? { newlyPlacedOnBoard: placed } : {}),
      },
      images,
    )
  },
}

export const studioCompareMcpTools: AiTool[] = [studioCompareTool]
