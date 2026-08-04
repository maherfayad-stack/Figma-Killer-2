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
 *   2. **Wait for the canvas to re-read** (`awaitStudioLiveReload`) — awaited,
 *      not fire-and-forget, because capturing first would photograph the
 *      previous version of the file.
 *   3. **Capture** — relay to the browser-side `studio_export_frames` handler
 *      (`src/admin/pages/site/agent/studioExportFrames.ts`) over the same live
 *      editor bridge every browser tool uses, and return its PNGs as MCP image
 *      blocks.
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
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { syncBoardFramesFromDisk } from '../../../../handlers/studio/pageScaffold'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { awaitEditorBridgeForUser } from '../../editorBridge'
import { awaitStudioLiveReload } from './liveReloadPush'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolveRequestedPages } from './pageNameMatch'

/** The browser capture path's own batch ceiling (`StudioExportFramesInputSchema`). */
const MAX_FRAMES = 20

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
  },
  { additionalProperties: false },
)

export const studioScreenshotTool: AiTool = {
  name: 'studio_screenshot',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'See what a screen actually looks like. Places a board frame for any page file that does not have one yet, waits for the canvas to re-read the files from disk, then captures each requested screen from the live DOM and returns it as a PNG image block. This is how you verify your own work: write the files, then look at them. Name screens the way you named the files ("Checkout"), or omit `pages` to capture the whole project. Each result carries the captured width/height, its index into the response images, and `nodeRects` (node id -> frame-local rect) for feeding studio_diff_frames. Requires the project open in a Studio browser tab.',
  inputSchema: ScreenshotInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pages: requested, dpr, axes } = input as {
      dir?: string
      pages?: string[]
      dpr?: number
      axes?: { direction?: 'ltr' | 'rtl'; colorScheme?: 'light' | 'dark' }
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const bridge = await awaitEditorBridgeForUser(ctx.userId, 'site', ctx.signal)
    if (!bridge) {
      return {
        ok: false,
        error: 'No Studio board is connected. A screenshot is a capture of the live canvas, so it needs the project open in a Studio browser tab. If it IS open, the tab reconnects on its own within a few seconds — just call this again once.',
      }
    }

    // 1. The board must agree with disk before anything is captured.
    const placed = syncBoardFramesFromDisk(dir)

    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_FRAMES)
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return {
        ok: false,
        error: unmatched.length > 0
          ? `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}. This project has: ${known}.`
          : `This project has no screens to capture yet.`,
      }
    }

    // 2. Awaited, so the capture below photographs the files as they are NOW.
    await awaitStudioLiveReload(ctx.userId, { dir, pageIds: ids, boardsChanged: placed.length > 0 })

    // 3. The existing browser capture path, unchanged.
    const captured = await bridge.callBrowser('studio_export_frames', {
      pageIds: ids,
      ...(dpr === undefined ? {} : { dpr }),
      ...(axes === undefined ? {} : { axes }),
    })
    if (!captured.ok) return captured

    return {
      ok: true,
      data: {
        ...(captured.data as Record<string, unknown> | null ?? {}),
        dir,
        ...(placed.length > 0 ? { newlyPlacedOnBoard: placed } : {}),
        ...(unmatched.length > 0 ? { unmatched } : {}),
      },
      ...(captured.images ? { images: captured.images } : {}),
    }
  },
}
