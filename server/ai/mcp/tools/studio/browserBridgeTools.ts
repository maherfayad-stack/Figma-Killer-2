/**
 * Studio MCP tools — the three browser-bridged (`execution: 'browser'`,
 * `scope: 'site'`) tools that close the WS-12 §6.1 parity matrix's gaps.
 * Same pattern as `exportFrames.ts`: this file only declares name/
 * description/schema/gate. The real mutation runs client-side against the
 * live editor store (`executor.ts`'s dispatch cases) — wrappers over verbs
 * that already exist (`EditorStore.setFrameAxes`/`duplicateFrameAsVariant`,
 * `POST /admin/api/studio/asset-upload`), never a reimplementation of them.
 *
 * All three declare `mutates: true` + `requiredCapabilities: ['studio.write']`,
 * the same posture every other Studio write tool uses.
 */
import {
  StudioSetFrameAxesInputSchema,
  StudioDuplicateFrameAsVariantInputSchema,
  StudioUploadAssetInputSchema,
} from '@core/ai'
import type { AiTool } from '../../../runtime/types'

const setFrameAxesTool: AiTool = {
  name: 'studio_set_frame_axes',
  scope: 'site',
  execution: 'browser',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Override a board frame\'s preview direction/colorScheme/locale — the same "show this screen in RTL/dark/a specific locale" control the toolbar\'s own preview-axes UI drives (EditorStore.setFrameAxes). Addressed by pageId (from studio_list_pages); when a page has more than one frame on the active board, the first one found is targeted unless frameId is given explicitly. A design-review turn should call this BEFORE studio_export_frames/studio_render_reference to check the RTL/dark rendering, not just the default one. Requires an open Studio board (studio.write) — a user actively editing the same session sees the same frame flip.',
  inputSchema: StudioSetFrameAxesInputSchema,
}

const duplicateFrameAsVariantTool: AiTool = {
  name: 'studio_duplicate_frame_as_variant',
  scope: 'site',
  execution: 'browser',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Duplicate a board frame as a new, independently-addressable variant with its own axes override (EditorStore.duplicateFrameAsVariant) — the side-by-side comparison verb: the SAME page rendered twice on the board (e.g. LTR next to RTL) rather than one frame flipping back and forth. Addressed by pageId, same first-match rule as studio_set_frame_axes. Returns { frameId } for the new frame — pass it as frameId to a LATER studio_set_frame_axes call if you need to adjust it again. The new frame lands beside the source on the board, selected. Requires an open Studio board (studio.write).',
  inputSchema: StudioDuplicateFrameAsVariantInputSchema,
}

const uploadAssetTool: AiTool = {
  name: 'studio_upload_asset',
  scope: 'site',
  execution: 'browser',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Land a new image file into the project — wraps the same POST /admin/api/studio/asset-upload endpoint the canvas\'s own asset picker uses (real bytes sniffed against image magic numbers, containment-checked target directory, collision-safe naming; a declared mimeType that does not match the actual bytes is refused). Returns { relPath } — the new file\'s workspace-relative POSIX path, ready to pass as an insert edit\'s import target or a kind:"asset" edit\'s assetPath. This is the ONLY way to land a genuinely NEW image file; studio_apply_edits\' asset-kind edit only repoints an EXISTING import at a file that is already on disk. Requires studio.write.',
  inputSchema: StudioUploadAssetInputSchema,
}

export const studioBrowserBridgeMcpTools: AiTool[] = [
  setFrameAxesTool,
  duplicateFrameAsVariantTool,
  uploadAssetTool,
]
