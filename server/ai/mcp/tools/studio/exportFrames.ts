/**
 * Studio MCP tool — 9.2 `studio_export_frames`, the "export them as images"
 * half of requirement 10.
 *
 * **Server-executed since W4-2A, not browser-bridged.** It used to be
 * `execution: 'browser'`: a bare declaration whose whole implementation lived
 * client-side in `src/admin/pages/site/agent/studioExportFrames.ts`, relayed
 * to the connector owner's open Site workspace. That made every export
 * conditional on a browser tab being open, cost a canvas pan + frame mount +
 * settle wait per call, and visibly hijacked the viewport of anyone editing at
 * the time.
 *
 * The handler here routes instead: headless first (a server-side Chromium
 * rendering Studio's own parse output — see `capture/headlessCapture.ts`),
 * the live editor bridge as fallback and as the deliberate choice for the
 * things only an open tab knows. The client-side implementation is unchanged
 * and still reachable — `captureFrames` calls it over the same bridge under
 * the same `'studio_export_frames'` protocol name, so `executor.ts`'s dispatch
 * needs no change and the live path behaves exactly as it always has.
 *
 * `mutates: true` + `requiredCapabilities: ['studio.write']` stay. The headless
 * path mutates nothing at all, but the live path still temporarily takes over
 * the canvas's pan/zoom/active-page, and a tool's gate is set by the strongest
 * thing it can do, not the weakest.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { StudioExportFramesInputSchema } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { captureFrames, type CaptureSource } from '../../capture/captureFrames'
import { resolveToolProjectDir } from './resolveToolProjectDir'

/**
 * `StudioExportFramesInputSchema` is the BROWSER handler's input contract and
 * is shared with the client, which has no notion of capture routing. `source`
 * is a server-side routing choice, so it is composed on here rather than added
 * there — the browser handler must keep receiving exactly the fields it
 * understands.
 */
const ExportFramesInputSchema = Type.Composite([
  StudioExportFramesInputSchema,
  Type.Object({
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    source: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('headless'), Type.Literal('live')], {
        description:
          'Which renderer takes the picture. "auto" (default) renders headlessly on the server from what is ON DISK, falling back to the open editor tab only if the headless browser cannot run — this is what you want for verifying files you just wrote, and it never disturbs a tab someone is working in. "live" forces the capture to come from the connector owner\'s OPEN Studio tab, which is the only way to see state that exists nowhere else: the user\'s current selection, an in-progress edit that has not been saved to disk yet, or a board the user has re-framed without persisting. "headless" forbids the live fallback, so a missing headless browser is reported as an error instead of silently taking over someone\'s tab.',
      }),
    ),
  }),
])

export const exportFramesTool: AiTool = {
  name: 'studio_export_frames',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Batch-export up to 20 Studio board frames to PNG in one call, returned as MCP image blocks. By default this runs in a headless browser ON THE SERVER: it needs NO Studio browser tab open, and it never scrolls, zooms, or re-pages a tab that is open. It renders the same parse output the canvas renders, so the freeze (CanvasAnimationInjector) and scroll-unroll (CanvasScrollUnrollInjector) design-canvas injectors apply exactly as they do on the board. Pass `source: "live"` to capture from the connector owner\'s OPEN editor tab instead — the only path that can see state which exists nowhere but that tab (the current selection, an unsaved in-progress edit, an unpersisted board re-frame); it costs a canvas takeover the user will see. Every frame is captured at its own authored width (Studio frames do not share one breakpoint width — resize with studio_set_frames first if you need a specific size); pass `dpr` (0.5-3, default 1) to scale the OUTPUT resolution. IMPORTANT: by default (`purpose: \'vision\'`) the output is capped so NEITHER edge (width OR height) exceeds ~1568px — a vision-safety limit for an image you intend to actually look at, applied even when it means the requested `dpr` is not fully honoured. A tall mobile screen at dpr:2 is the common case that hits this: its HEIGHT, not its width, gets clamped. If you only need the pixels for a pixel-diff and will not look at this specific image yourself, pass `purpose: \'measurement\'` instead — it lifts that clamp to a much larger total-pixel budget so a tall screen keeps its true requested dpr (studio_compare does this automatically for its own internal capture). The result lists each page\'s status, captured width/height, its image\'s index into the response\'s image blocks, `nodeRects` (node id → frame-local CSS-px rect), and `imageScale` — the multiplier from `nodeRects`\' CSS-px space into THIS image\'s actual pixel space (derived from the real captured size, so it stays correct even when the effective ratio was clamped) — plus `capturedVia` ("headless" or "live") saying which renderer answered. If neither renderer can run, the error names BOTH reasons rather than blaming a missing board.',
  inputSchema: ExportFramesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageIds, dpr, purpose, axes, source } = input as {
      dir?: string
      pageIds: string[]
      dpr?: number
      purpose?: 'vision' | 'measurement'
      axes?: { direction?: 'ltr' | 'rtl'; colorScheme?: 'light' | 'dark' }
      source?: CaptureSource
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const captured = await captureFrames({
      userId: ctx.userId,
      dir,
      pageIds,
      ...(dpr === undefined ? {} : { dpr }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(axes === undefined ? {} : { axes }),
      ...(source === undefined ? {} : { source }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!captured.output.ok) return captured.output

    return {
      ok: true,
      data: {
        ...((captured.output.data as Record<string, unknown> | null) ?? {}),
        dir,
        capturedVia: captured.source,
        ...(captured.source === 'live' && captured.headlessFailure
          ? { headlessFallbackReason: captured.headlessFailure.error }
          : {}),
      },
      ...(captured.output.images ? { images: captured.output.images } : {}),
    }
  },
}

export const studioExportMcpTools: AiTool[] = [exportFramesTool]
