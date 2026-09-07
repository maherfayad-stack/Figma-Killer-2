/**
 * `studio_measure_element` — the agent's ruler.
 *
 * Every capture this server takes already measures the frame's boxes: the
 * readiness report carries a `nodeRects` entry for every `[data-node-id]`
 * element, and `studio_screenshot` hands them straight back. What nothing
 * reported was the arithmetic AROUND those rects — the padding inside a box,
 * the margins on it, and the measured distance to the box next to it. So
 * "these cards are too close together" had exactly one answer available: guess
 * the pixels off a screenshot, edit a `gap`, screenshot again. That is the same
 * loop `studio_computed_styles` removed for type, one axis over.
 *
 * The pair that makes this diagnostic rather than merely informative is
 * `gapBeforePx`/`gapAfterPx` next to the parent's own declared
 * `rowGapPx`/`columnGapPx`. When they agree, the `gap` rule is doing what it
 * says. When they disagree, a margin is in play — and no amount of tuning the
 * `gap` will ever close the difference, which is precisely the failure a
 * screenshot cannot distinguish from "the gap value is wrong".
 *
 * Runs on the same headless substrate as `studio_screenshot`, in the same three
 * steps and for the same reason: reconcile the board with disk, wait for the
 * parse to re-read, then measure. An agent measuring a screen it JUST wrote
 * must not have to remember a placement ritual first, and a measurement of the
 * previous version of the file reads as evidence.
 *
 * Deliberately no live-tab fallback. `studio_computed_styles` keeps one because
 * an unsaved in-progress edit is a real thing only that tab holds; this tool
 * asks a question about layout the agent itself just authored, where the tab
 * would only ever be a slower way to read the same file.
 */
import { StudioMeasureElementInputSchema, aiToolError } from '@core/ai'
import type { PreviewAxes } from '@core/studio-board'
import type { AgentFrameInspectRequest } from '@core/studio-capture'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/boardFrames'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { inspectFrameHeadless } from '../../capture/headlessFrameInspect'
import { awaitStudioLiveReload } from './liveReloadPush'
import { resolvePageByName } from './pageNameMatch'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const measureElementTool: AiTool = {
  name: 'studio_measure_element',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Measure what a screen ACTUALLY laid out to, in px: for each element, its frame-local x/y/width/height, its own padding/margin/border, and the measured gap to the elements before and after it — alongside the parent container\'s display, flex-direction, declared row-gap/column-gap and padding. Use it instead of estimating spacing from a screenshot: when the measured gap and the parent\'s declared gap disagree, a margin is in play and editing the gap will never close the difference; when they agree, the gap value itself is what is wrong. Address elements by node id (from studio_screenshot\'s nodeRects), by a CSS selector evaluated inside the rendered frame, or omit both to measure every authored node. Coordinates share studio_screenshot\'s origin (the frame\'s top-left), so a rect from a capture and a rect from here are directly comparable. Needs no Studio browser tab open — the screen is rendered in a headless browser on the server against what is on disk, so it measures the files you just wrote.',
  inputSchema: StudioMeasureElementInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const args = input as {
      dir?: string
      page: string
      nodeIds?: string[]
      selector?: string
      limit?: number
      axes?: Partial<PreviewAxes>
    }
    const dir = resolveToolProjectDir(args.dir, ctx)

    // 1. The board must agree with disk — same first step `studio_screenshot`
    // takes, so a screen written moments ago is measurable without a separate
    // placement call.
    const placed = syncBoardFramesFromDisk(dir)

    const { pages } = await loadStudioPages(dir)
    const page = resolvePageByName(pages, args.page)
    if (!page) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(`No screen matched "${args.page}". This project has: ${known}.`)
    }

    // 2. Awaited, so the measurement below reads the files as they are NOW.
    await awaitStudioLiveReload(ctx.userId, { dir, pageIds: [page.id], boardsChanged: placed.length > 0 })

    const request: AgentFrameInspectRequest = {
      kind: 'measure',
      pageId: page.id,
      ...(args.nodeIds === undefined ? {} : { nodeIds: args.nodeIds }),
      ...(args.selector === undefined ? {} : { selector: args.selector }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }
    const measured = await inspectFrameHeadless({
      userId: ctx.userId,
      dir,
      request,
      ...(args.axes === undefined ? {} : { axes: args.axes }),
    })
    if (!measured.ok) {
      return aiToolError(
        `measure-unavailable (${measured.code}): ${measured.error} This tool renders the screen in a headless browser on the server; it needs a Chromium available to playwright-core, installed with \`bunx playwright install chromium\`.`,
      )
    }

    return {
      ok: true,
      data: {
        ...measured.result,
        dir,
        page: page.title,
        ...(placed.length > 0 ? { newlyPlacedOnBoard: placed } : {}),
      },
    }
  },
}

export const studioMeasureElementMcpTools: AiTool[] = [measureElementTool]
