/**
 * `studio_screenshot` — the agent's eyes.
 *
 * The Studio agent authors screens by writing `.tsx`/`.module.css` files
 * directly into the open project (`claudeCliToolSurface.ts` grants
 * `Write`/`Edit` scoped to the project `cwd`). Everything else it needs, the
 * filesystem already gives it. The one thing a file write cannot give it is
 * sight: whether the screen it just wrote actually looks like the thing it was
 * asked for.
 *
 * Nothing watches the workspace directory, so a freshly written page is real,
 * parseable, and completely invisible until three things happen in order. This
 * tool is those three things in one call, deliberately — an agent that has to
 * remember a three-step ritual before every look will skip it, and a partial
 * ritual produces a stale image that reads as evidence:
 *
 *   1. **Reconcile the board with disk** (`syncBoardFramesFromDisk`) — place a
 *      frame for every page file that does not have one. Additive and
 *      idempotent: an existing frame keeps its position and size, and a frame
 *      whose file was deleted is left alone.
 *   2. **Capture** — hand the resolved page ids to `capture/captureFrames.ts`,
 *      which renders them in a server-side headless browser and, only if that
 *      cannot run, falls back to relaying to the open editor tab. Return the
 *      PNGs as MCP image blocks.
 *
 * Step 2 stopped needing an open browser tab in W4-2A. That matters most
 * exactly here: step 1 has just made DISK the source of truth, and this tool
 * exists to look at files the agent itself wrote — so the honest renderer is
 * the one that reads those files, not the one that happens to be mounted in
 * someone's tab. It also means a capture no longer scrolls, zooms, or re-pages
 * a canvas the user is working in.
 *
 * W9-5 lever 2 — waiting for the canvas to re-read (`awaitStudioLiveReload`)
 * used to be its own step between the two above, paid on EVERY call. It is
 * meaningless to the headless renderer, which re-parses from disk on every
 * navigation, so `captureFrames` now owns it and pays it only on the live-tab
 * fallback (`reloadBeforeLiveFallback`) — where a stale photograph really
 * would read as evidence.
 *
 * `studio_export_frames` still exists and still does step 3 alone; it stays in
 * the MCP registry for external clients that manage their own board. It is
 * simply not what the in-canvas agent is offered, because for the agent the
 * three steps are never independent.
 *
 * Page selection is by NAME, not by page id. The agent that just wrote
 * `pages/Checkout.tsx` knows it wrote `Checkout` — making it call
 * `studio_list_pages` first to translate that into an id is a round trip
 * bought with nothing. `"Checkout"`, `"Checkout.tsx"`, `"pages/Checkout.tsx"`
 * and the raw page id all resolve to the same frame.
 *
 * ## Several widths without touching the board (AI-16)
 *
 * `widths` renders each screen at each breakpoint through the same headless
 * path, one capture per width, with the width carried in the capture grant
 * (`CaptureGrant.frameWidth`) — never written to `.studio/boards.json`. The
 * old way to check a phone screen at desktop width was to resize its frame,
 * look, and resize it back, which mutated the user's board and left it wrong
 * whenever a turn ended between the two. A width override is headless-only:
 * the live tab can photograph a frame only at its board width, so when
 * headless cannot run this refuses instead of returning the board width in
 * place of the one that was asked for.
 */
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal, type AiToolImage } from '@core/ai'
import { createWorkspaceProject } from '@core/page-parser'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/boardFrames'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { canonicalSummaryForFile } from '../../../../handlers/studio/canonicalPageCheck'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { captureFrames } from '../../capture/captureFrames'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { MAX_BATCH_PAGES, resolveRequestedPages } from './pageNameMatch'

/** The browser capture path's own batch ceiling (`StudioExportFramesInputSchema`) — now the shared family-wide cap (`pageNameMatch.ts`'s `MAX_BATCH_PAGES`). */
const MAX_FRAMES = MAX_BATCH_PAGES
/** Breakpoints one responsive check may ask for — phone, tablet, desktop, wide. */
const MAX_WIDTHS = 4
const MIN_CAPTURE_WIDTH = 240
const MAX_CAPTURE_WIDTH = 2560

const ScreenshotInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pages: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_FRAMES,
        description:
          'Which screens to capture, by name — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work. Omit to capture every screen in the project (up to 20).',
      }),
    ),
    dpr: Type.Optional(
      Type.Number({
        minimum: 0.5,
        maximum: 3,
        description: 'Output pixel-density multiplier applied to each frame\'s native captured size (2 for a retina-equivalent PNG). Default 1.',
      }),
    ),
    axes: Type.Optional(
      Type.Object(
        {
          direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
          colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
        },
        {
          description:
            'Capture under a temporary direction/color-scheme override, restored afterward — how to look at the RTL or dark rendering without leaving the user\'s session in that state.',
        },
      ),
    ),
    widths: Type.Optional(
      Type.Array(Type.Integer({ minimum: MIN_CAPTURE_WIDTH, maximum: MAX_CAPTURE_WIDTH }), {
        minItems: 1,
        maxItems: MAX_WIDTHS,
        description:
          'Responsive check: render each screen at each of these CSS widths, e.g. [375, 768, 1280], instead of its board width. The board is never resized — the override exists only inside this capture — and each frame keeps its own height (tall content is unrolled). Headless only: when the headless browser cannot run this refuses rather than photograph another width. Screens x widths is capped at 20.',
      }),
    ),
  },
  { additionalProperties: false },
)

export const studioScreenshotTool: AiTool = {
  name: 'studio_screenshot',
  scope: 'shared',
  execution: 'server-with-bridge-fallback',
  sideEffects: 'cache',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'See what a screen actually looks like. Places a board frame for any page file that does not have one yet, waits for the parse to re-read the files from disk, then renders each requested screen and returns it as a PNG image block. This is how you verify your own work: write the files, then look at them. It does NOT need a Studio browser tab open, and it never disturbs one that is — the capture runs in a headless browser on the server against what is ON DISK, which is exactly what you just wrote; the open editor tab is used only as a fallback when the headless browser cannot run. `capturedVia` in the result says which path answered. Name screens the way you named the files ("Checkout"), or omit `pages` to capture the whole project. Pass `widths` (e.g. [375, 768, 1280]) to see each screen at those breakpoints without resizing the board; every frame then carries `requestedWidth`. Each result carries the captured width/height, its index into the response images, `nodeRects` (node id -> frame-local rect, so a spot on the image maps back to the nodes under it), and — for a .tsx/.jsx screen — `canonical: { isCanonical, violations, advisories }`, the WS-13 canonical-JSX self-check, run against the file you just wrote so a non-literal prop/className, a spread prop, a Sass/CSS-in-JS import, an unresolvable dynamic map, or a likely unnecessary wrapper element shows up on the very call your own "write, then look" loop already makes. It does NOT catch a hardcoded colour, a fixed pixel width, or a literal inline style object — those are values the system prompt\'s own rules ban, not structural editability breaks; studio_measure_reference and careful reading remain how you catch those.',
  inputSchema: ScreenshotInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pages: requested, dpr, axes, widths } = input as {
      dir?: string
      pages?: string[]
      dpr?: number
      axes?: { direction?: 'ltr' | 'rtl'; colorScheme?: 'light' | 'dark' }
      widths?: number[]
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    // 1. The board must agree with disk before anything is captured.
    const placed = syncBoardFramesFromDisk(dir)

    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_FRAMES)
    const uniqueWidths = widths ? [...new Set(widths)] : undefined
    if (uniqueWidths && ids.length * uniqueWidths.length > MAX_FRAMES) {
      return toolRefusal('invalid-input', `${ids.length} screens at ${uniqueWidths.length} widths is ${ids.length * uniqueWidths.length} captures, over the ${MAX_FRAMES}-capture cap.`, {
        remedy: 'Name fewer screens in pages, or check fewer widths per call.',
      })
    }
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return toolRefusal(
        'no-such-page',
        unmatched.length > 0
          ? `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}. This project has: ${known}.`
          : 'This project has no screens to capture yet.',
      )
    }

    // 2. Capture — headless first, the live editor tab as fallback. The
    // routing lives in `capture/captureFrames.ts`; this tool is indifferent to
    // which path answered beyond reporting it, because both produce the same
    // frames from the same parse output. Headless is the RIGHT default here
    // specifically because step 1 just made disk the source of truth: this
    // tool exists to look at files the agent has already written. Only the
    // live-tab fallback pays the live-reload wait (`reloadBeforeLiveFallback`).
    const capture = (frameWidth?: number) => captureFrames({
      userId: ctx.userId,
      dir,
      pageIds: ids,
      reloadBeforeLiveFallback: { boardsChanged: placed.length > 0 },
      ...(dpr === undefined ? {} : { dpr }),
      ...(axes === undefined ? {} : { axes }),
      ...(frameWidth === undefined ? {} : { frameWidth }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    // AI-16 — one capture per width, and never a board write in between: each
    // width is a capture-time override (`CaptureFramesRequest.frameWidth`),
    // headless only, so a responsive check leaves the board exactly as it was.
    let captured: Awaited<ReturnType<typeof captureFrames>>
    if (uniqueWidths) {
      const frames: Array<Record<string, unknown>> = []
      const images: AiToolImage[] = []
      let source: Awaited<ReturnType<typeof captureFrames>>['source'] = 'none'
      for (const width of uniqueWidths) {
        const atWidth = await capture(width)
        if (!atWidth.output.ok) return atWidth.output
        const data = atWidth.output.data as { frames?: Array<Record<string, unknown>> } | null
        for (const frame of data?.frames ?? []) {
          frames.push({
            ...frame,
            requestedWidth: width,
            ...(typeof frame.imageIndex === 'number' ? { imageIndex: frame.imageIndex + images.length } : {}),
          })
        }
        images.push(...(atWidth.output.images ?? []))
        source = atWidth.source
      }
      captured = { source, output: { ok: true, data: { frames, source, widths: uniqueWidths }, images } }
    } else {
      captured = await capture()
    }
    if (!captured.output.ok) return captured.output

    // A6 (STUDIO-FIGMA-PARITY-PLAN.md): re-arm the WS-13 canonical-JSX
    // self-check on the one path guaranteed to run right after a real write —
    // the agent's own prescribed workflow calls this tool after every edit.
    // `studio_read_file` (the check's only OTHER wiring) is withheld from the
    // in-canvas agent in favour of native Read/Write/Edit, which are not
    // server-mediated the way an MCP tool call is, so there is no per-call
    // hook to attach this to instead — see `canonicalPageCheck.ts`'s doc.
    // Bounded by the same `ids`/`MAX_FRAMES` cap the capture itself already
    // enforces; never fails the call (`canonicalSummaryForFile` never throws).
    const rawData = captured.output.data as { frames?: Array<Record<string, unknown>> } | null
    const pageById = new Map(pages.map((p) => [p.id, p]))
    // Built ONCE for the whole batch (up to MAX_FRAMES pages) and reused —
    // see `canonicalPageCheck.ts`'s doc for why a workspace-aware project is
    // required for an accurate result, and why re-scanning per page would be
    // wasteful.
    const canonicalProject = rawData?.frames?.some((f) => f.ok === true) ? createWorkspaceProject(dir) : undefined
    const framesWithCanonical = rawData?.frames?.map((frame) => {
      const pageId = typeof frame.pageId === 'string' ? frame.pageId : undefined
      if (frame.ok !== true || !pageId || !canonicalProject) return frame
      const page = pageById.get(pageId)
      const relFile = page ? resolvePageSourceFile(page) : null
      if (!relFile) return frame
      const canonical = canonicalSummaryForFile(join(dir, ...relFile.split('/')), dir, relFile, canonicalProject)
      return canonical ? { ...frame, canonical } : frame
    })

    return {
      ok: true,
      data: {
        ...(rawData ?? {}),
        ...(framesWithCanonical ? { frames: framesWithCanonical } : {}),
        dir,
        // Which path took the picture. `headless` means no editor tab was
        // involved at all; `live` means it came from the open tab (and, if
        // `headlessFallbackReason` is present, only because headless could
        // not run — that reason is the actionable one).
        capturedVia: captured.source,
        ...(captured.source === 'live' && captured.headlessFailure
          ? { headlessFallbackReason: captured.headlessFailure.error }
          : {}),
        ...(placed.length > 0 ? { newlyPlacedOnBoard: placed } : {}),
        ...(unmatched.length > 0 ? { unmatched } : {}),
      },
      ...(captured.output.images ? { images: captured.output.images } : {}),
    }
  },
}
