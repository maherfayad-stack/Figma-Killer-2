/**
 * `studio_upload_asset` — land image bytes the model holds as a new project
 * file, through the ONE agent image landing (`landAgentAsset`): the agent
 * write gate on the target folder, the project write lock, the turn write log,
 * and `assetLanding.ts`' sniffed type, `wx` names and containment.
 *
 * ## Why it is a server tool now (review of #248, F6)
 *
 * It used to be the one Studio tool relayed to the user's open tab: the tab
 * decoded the base64 and POSTed it to `/admin/api/studio/asset-upload` as the
 * signed-in user. That route is the CANVAS's upload, where the user chooses
 * the folder, so it deliberately does not consult the agent write gate
 * (`agentWriteRefusal` is for agent writes only; a Studio writer acting for
 * the user must not call it). An agent upload therefore reached folders every
 * other agent landing refuses — Studio's preview shell `prototype/` among
 * them — held no project write lock, and was never recorded in the turn's
 * write log.
 *
 * The session was never the real authority either: a tool call is already
 * gated on `studio.write` by `executeAiTool`, exactly like
 * `studio_fetch_remote_asset` and `studio_find_image`, which land bytes
 * server-side through `landAgentAsset`. So this is one more caller of that
 * function, and no tab needs to be open.
 */
import { StudioUploadAssetInputSchema, toolRefusal } from '@core/ai'
import type { Static } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { isRefusal, landAgentAsset } from './agentWriteSupport'
import { sniffImageExtension } from '../../../../handlers/studio/assetLanding'
import { MAX_ASSET_UPLOAD_BYTES } from '../../../../handlers/studio/assetUpload'

type UploadAssetInput = Static<typeof StudioUploadAssetInputSchema>

/** The sniffed extension each declared type must turn out to be. */
const EXTENSION_FOR_MIME: Readonly<Record<UploadAssetInput['mimeType'], string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Standard base64, padding optional, whitespace ignored. `null` for anything else — never a lenient decode of garbage. */
function decodeBase64(text: string): Uint8Array | null {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) return null
  return new Uint8Array(Buffer.from(compact, 'base64'))
}

export async function uploadAssetForAgent(input: UploadAssetInput, ctx: ToolContext): Promise<Record<string, unknown>> {
  const dir = resolveToolProjectDir(input.dir, ctx)
  const bytes = decodeBase64(input.imageBase64)
  if (bytes === null) return toolRefusal('invalid-input', 'imageBase64 is not valid base64 data.')
  if (bytes.length > MAX_ASSET_UPLOAD_BYTES) {
    return toolRefusal('file-too-large', `The image is ${bytes.length.toLocaleString('en-US')} bytes, over the ${MAX_ASSET_UPLOAD_BYTES.toLocaleString('en-US')}-byte limit.`)
  }
  const sniffed = sniffImageExtension(bytes)
  if (sniffed !== EXTENSION_FOR_MIME[input.mimeType]) {
    return toolRefusal('invalid-input', `The bytes are ${sniffed === null ? 'not a recognized image' : sniffed.toUpperCase()}, not the ${input.mimeType} they were declared as, so nothing was written.`)
  }
  const landed = await landAgentAsset(dir, ctx, input.targetDir, bytes, `upload.${sniffed}`)
  if (isRefusal(landed)) return landed
  return { ok: true, dir, ...landed }
}

const uploadAssetTool: AiTool = {
  name: 'studio_upload_asset',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Land image bytes you hold (base64 PNG, JPEG or WebP, up to 25 MB) as a new file in the project. The bytes are sniffed and must match mimeType; a new, uniquely named file is written in targetDir (default src/assets) through the agent write gate — never over an existing file, never in .studio, .git or prototype/. Returns { relPath, src, buildSafe, width, height, deduped }: import relPath from the file that shows it; src is its site URL, which a production build serves only when buildSafe is true. An identical file already there is reused. When the image is at an http(s) URL, use studio_fetch_remote_asset instead, so its bytes never pass through your context. Requires studio.write.',
  inputSchema: StudioUploadAssetInputSchema,
  handler: async (input, ctx: ToolContext) => uploadAssetForAgent(input as UploadAssetInput, ctx),
}

export const studioUploadAssetMcpTools: AiTool[] = [uploadAssetTool]
