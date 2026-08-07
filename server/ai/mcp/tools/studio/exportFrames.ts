/**
 * Studio MCP tool — 9.2 `studio_export_frames`, the "export them as images"
 * half of requirement 10.
 *
 * Browser-bridged (`execution: 'browser'`, `scope: 'site'`): the actual
 * capture logic lives client-side in
 * `src/admin/pages/site/agent/studioExportFrames.ts` and is dispatched by
 * `executor.ts`'s `'studio_export_frames'` case — this file only declares
 * the tool's name/description/schema/gate, mirroring how `site_render_snapshot`
 * is declared in `server/ai/tools/site/writeTools.ts`. No server handler: the
 * MCP `Server` relays the call to the connector owner's open Site workspace
 * via `editorBridge.ts` (see `server/ai/mcp/server.ts`), same as every other
 * browser tool.
 *
 * `mutates: true` + `requiredCapabilities: ['studio.write']`: this tool does
 * not write to the project's source or `.studio/boards.json`, but it DOES
 * temporarily take over the LIVE canvas's pan/zoom/active-page for the
 * duration of the batch (see `studioExportFrames.ts`'s module doc for why),
 * a real user-visible state change on a shared session — the same category
 * `mutates` is meant to flag, per `AiTool.mutates`'s own doc comment. Gated
 * like every other Studio tool that touches the open editor, not left
 * ungated like the pure-read 9.1 orientation tools.
 */
import { StudioExportFramesInputSchema } from '@core/ai'
import type { AiTool } from '../../../runtime/types'

export const exportFramesTool: AiTool = {
  name: 'studio_export_frames',
  scope: 'site',
  execution: 'browser',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Batch-export up to 20 Studio board frames to PNG in one call, returned as MCP image blocks. Each frame is captured from the SAME live DOM the user sees — the freeze (CanvasAnimationInjector) and scroll-unroll (CanvasScrollUnrollInjector) design-canvas injectors apply automatically, so the export matches what the canvas shows, not a bare re-render. Every frame is captured at its own authored width (Studio frames do not share one breakpoint width — resize with studio_set_frames first if you need a specific size); pass `dpr` (0.5-3, default 1) to scale the OUTPUT resolution. IMPORTANT: the output is capped so NEITHER edge (width OR height) exceeds ~1568px — a vision-safety limit, applied even when it means the requested `dpr` is not fully honoured. A tall mobile screen at dpr:2 is the common case that hits this: its HEIGHT, not its width, gets clamped, which silently degrades studio_compare/studio_diff_frames from an exact-pixel comparison to an interpolated one for that frame — call studio_recommend_export_dpr first and check its height-cap warning. The result lists each page\'s status, captured width/height, its image\'s index into the response\'s image blocks, and `nodeRects` (node id → frame-local rect) — feed those straight into studio_diff_frames\' `nodeRects` to map a visual difference back to source nodes. Requires an open Studio board (studio.write) — temporarily takes over the live canvas\'s pan/zoom/active page for the batch, restoring them afterward; a user actively editing in the same session will see their view jump and selection clear for the duration.',
  inputSchema: StudioExportFramesInputSchema,
}

export const studioExportMcpTools: AiTool[] = [exportFramesTool]
