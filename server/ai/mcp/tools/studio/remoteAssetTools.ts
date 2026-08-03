/**
 * studio_fetch_remote_asset — lands a URL's bytes into the project without
 * ever routing them through the calling model. See `server/handlers/studio/
 * remoteAssetFetch.ts` for the fetch-side safety reasoning (scheme
 * restriction, no redirect followed, streamed size cap) and `assetLanding.ts`
 * for the write pipeline this shares with `studio_upload_asset`.
 *
 * `execution: 'server'` — unlike `studio_upload_asset` (browser-bridged,
 * because the model hands it bytes the BROWSER then POSTs as multipart form
 * data), there is nothing here the live editor needs to mediate: the fetch,
 * the sniff, the sanitize, and the write are all plain filesystem/network
 * operations this process can do directly, the same posture every other
 * headless Studio write tool (`studio_apply_edits`, `studio_create_page`,
 * `studio_install_deps`) already uses.
 */
import { StudioFetchRemoteAssetInputSchema } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { fetchRemoteAsset } from '../../../../handlers/studio/remoteAssetFetch'

const fetchRemoteAssetTool: AiTool = {
  name: 'studio_fetch_remote_asset',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Fetch an http(s) URL SERVER-SIDE and land the response as a new image file in the project — the way to bring in an asset another tool (e.g. a connected Figma MCP server\'s export/download tool) already returned as a URL, WITHOUT round-tripping its bytes through your own context the way studio_upload_asset\'s imageBase64 input requires. The URL is fetched here; no redirect is ever followed; the response is capped at 25 MB by streamed byte count; the actual bytes are sniffed against real image magic numbers to decide the written extension (a declared/URL-suggested extension is never trusted); an SVG response is sanitized before it touches disk. Returns { relPath } — the new file\'s workspace-relative POSIX path, ready to pass as an insert edit\'s import target or a kind:"asset" edit\'s assetPath, same shape studio_upload_asset returns. Fails with a plain error (never a partial write) for a non-http(s) URL, an unreachable host, a redirect response, a non-2xx status, an oversized body, or content that does not sniff as a recognized image format. Requires studio.write.',
  inputSchema: StudioFetchRemoteAssetInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, url, targetDir } = input as { dir?: string; url: string; targetDir?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = await fetchRemoteAsset(dir, url, targetDir)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, dir, relPath: result.relPath, bytesWritten: result.bytesWritten }
  },
}

export const studioRemoteAssetMcpTools: AiTool[] = [fetchRemoteAssetTool]
