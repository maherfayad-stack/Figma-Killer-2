/**
 * studio_fetch_remote_asset — lands a URL's bytes into the project without
 * ever routing them through the calling model. See `remoteFetchPolicy.ts` for
 * which hosts an agent may name (P4-E, security review of #233 F8),
 * `server/handlers/studio/remoteAssetFetch.ts` for the transport's safety
 * reasoning (scheme, pinned DNS, no redirect, byte cap, deadline, content
 * type, magic bytes), and `agentWriteSupport.ts`'s `landAgentAsset` for the
 * landing (the agent write gate, the project lock, `assetLanding.ts`).
 *
 * `execution: 'server'` — like `studio_upload_asset`, there is nothing here
 * the live editor needs to mediate: the fetch,
 * the sniff, the sanitize, and the write are all plain filesystem/network
 * operations this process can do directly, the same posture every other
 * headless Studio write tool (`studio_apply_edits`, `studio_create_page`,
 * `studio_install_deps`) already uses.
 */
import { StudioFetchRemoteAssetInputSchema, toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { remoteFetchRefusal } from './remoteFetchPolicy'
import { isRefusal, landAgentAsset } from './agentWriteSupport'
import { fetchRemoteBytes, type FetchRemoteAssetDeps } from '../../../../handlers/studio/remoteAssetFetch'

/**
 * The handler, with the transport injectable so a test can drive it against a
 * local server. Three gates, in order, each before any cost the next one
 * would incur: which host (`remoteFetchPolicy.ts` — no request at all for a
 * host the agent may not name), the transport (`fetchRemoteBytes` — SSRF,
 * redirects, size, deadline, content type, magic bytes), then the landing
 * (`landAgentAsset` — the agent write gate on the target directory, the
 * project write lock, `assetLanding.ts`).
 */
export async function fetchRemoteAssetForAgent(
  input: { dir?: string; url: string; targetDir?: string },
  ctx: ToolContext,
  deps: FetchRemoteAssetDeps = {},
): Promise<Record<string, unknown>> {
  const dir = resolveToolProjectDir(input.dir, ctx)
  const refused = remoteFetchRefusal(input.url, ctx, { allowLoopback: deps.allowLoopback })
  if (refused) return refused
  const fetched = await fetchRemoteBytes(input.url, deps)
  if (!fetched.ok) return toolRefusal('remote-fetch-failed', fetched.error)
  const landed = await landAgentAsset(dir, ctx, input.targetDir, fetched.bytes, fetched.filenameHint)
  if (isRefusal(landed)) return landed
  return { ok: true, dir, ...landed }
}

const fetchRemoteAssetTool: AiTool = {
  name: 'studio_fetch_remote_asset',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Fetch an image URL SERVER-SIDE and land it as a new project file, so its bytes never pass through your context. Only from: Figma asset hosts (the URLs a Figma connector returns), the stock photo host, or a URL the user pasted into this conversation — any other host refuses host-not-allowed before a request is made. No redirect is followed; the response must be an image content type whose bytes match it, under 25 MB and 30 s; SVG is sanitized. Lands in targetDir (default src/assets) through the agent write gate. Returns { relPath, src, buildSafe, width, height, deduped }: import relPath from the file that shows it; src is its site URL, which a production build serves only when buildSafe is true. An identical file already there is reused. For a photo you do not have a URL for, use studio_find_image. Requires studio.write.',
  inputSchema: StudioFetchRemoteAssetInputSchema,
  handler: async (input, ctx: ToolContext) =>
    fetchRemoteAssetForAgent(input as { dir?: string; url: string; targetDir?: string }, ctx),
}

export const studioRemoteAssetMcpTools: AiTool[] = [fetchRemoteAssetTool]
