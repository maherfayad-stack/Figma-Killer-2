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
import { StudioMeasureElementInputSchema, toolRefusal } from '@core/ai'
import type { PreviewAxes } from '@core/studio-board'
import type { AgentFrameInspectRequest } from '@core/studio-capture'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/boardFrames'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { inspectFrameHeadless } from '../../capture/headlessFrameInspect'
import { resolvePageByName } from './pageNameMatch'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const measureElementTool: AiTool = {
  name: 'studio_measure_element',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'cache',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Measure what a screen actually laid out to, in px: per element, frame-local x/y/width/height, its padding, margin and border, and the measured gap to its neighbours, beside the parent\'s display, flex-direction, declared row-gap/column-gap and padding. Use it instead of estimating spacing from a picture: when the measured gap and the declared gap disagree, a margin is in play and editing the gap will not close it. Address elements by node id (from studio_screenshot\'s nodeRects), by a CSS selector inside the frame, or neither to measure every authored node. Coordinates share studio_screenshot\'s origin. Renders headless on the server from what is on disk.',
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
      return toolRefusal('no-such-page', `No screen matched "${args.page}".`, { remedy: `This project has: ${known}.` })
    }

    // W9-5 lever 2 — no live-reload wait. `inspectFrameHeadless` has no live
    // bridge path at all: it always renders server-side and re-parses from
    // disk on every navigation, so nudging an open tab and waiting for its
    // answer bought a full browser round trip for a measurement that was
    // already current.
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
      return toolRefusal('measure-unavailable', measured.error, {
        remedy: 'This tool renders the screen in a headless browser on the server; it needs a Chromium available to playwright-core, installed with `bunx playwright install chromium`. Report that rather than calling again unchanged.',
        details: { headlessCode: measured.code },
      })
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
