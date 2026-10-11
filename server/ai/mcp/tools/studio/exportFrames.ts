/**
 * Studio MCP tool — 9.2 `studio_export_frames`, the "export them as images"
 * half of requirement 10.
 *
 * **Server-executed since W4-2A, not browser-bridged.** It used to be
 * `execution: 'bridge'`: a bare declaration whose whole implementation lived
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
 * `requiresWrite: true` + `requiredCapabilities: ['studio.write']` stay. The
 * headless path changes nothing at all, but the live path still temporarily
 * takes over the canvas's pan/zoom/active-page, and a tool's GATE is set by
 * the strongest thing it can do, not the weakest. What the tool LOOP sees is a
 * different question: `sideEffects: 'none'`, because the takeover is restored
 * in a `finally` and nothing outlives the call — so a batch of exports runs
 * beside the other observers and a repeat after a fix is never answered from
 * the stale first capture (AI-5).
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
  execution: 'server-with-bridge-fallback',
  sideEffects: 'none',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Export up to 20 board frames to PNG in one call, as MCP image blocks. Headless on the server by default: no open tab needed, and an open one is never moved. source:\'live\' captures the owner\'s open tab instead — the only way to see unsaved or selection state; the user sees the takeover. Each frame renders at its own authored width; dpr (0.5–3) scales the output. purpose:\'vision\' (default) caps each edge at ~1568px even below the requested dpr (tall mobile screens clamp on height); purpose:\'measurement\' lifts that cap for pixel diffs. Returns per page: status, width/height, image index, nodeRects (node id → frame-local CSS px rect), imageScale (CSS px → this image\'s px) and capturedVia. If neither renderer can run, the error names both reasons. Details: MCP resource studio://tool-notes.',
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
