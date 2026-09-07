/**
 * `studio_upload_asset` — the browser half, and (since W9-6) the only Studio
 * tool that still runs in the user's tab because it genuinely needs the user's
 * SESSION.
 *
 * This file used to hold three tools. `studio_set_frame_axes` and
 * `studio_duplicate_frame_as_variant` moved server-side
 * (`server/ai/mcp/tools/studio/frameAxesTools.ts`): both write
 * `.studio/boards.json`, and routing that write through a mutable copy in this
 * store — which then had to be flushed back to the same file — bought nothing
 * but a bridge timeout whenever no tab was open. The open board still shows the
 * change immediately; it re-reads `boards.json` on the live-reload push those
 * tools send.
 *
 * What is left is the upload, which posts real `FormData` to
 * `/admin/api/studio/asset-upload` as the signed-in user. That endpoint's
 * authority is the operator's session, so this is the one place a server-side
 * tool has no honest way to stand in. Every validation (magic-number sniffing,
 * containment, collision-safe naming) still happens server-side exactly as it
 * does for a human upload — nothing here reimplements it.
 */
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { useAdminUi } from '@admin/state/adminUi'
import { aiToolError, aiToolOk, type AiToolOutput, StudioUploadAssetInputSchema } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const AssetUploadResponseSchema = Type.Object({ ok: Type.Boolean(), relPath: Type.Optional(Type.String()), error: Type.Optional(Type.String()) })

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export async function runUploadAsset(rawInput: unknown): Promise<AiToolOutput> {
  const input = parseValue(StudioUploadAssetInputSchema, rawInput)
  const dir = useAdminUi.getState().studioProject?.dir
  if (!dir) return aiToolError('No Studio project is open.')

  let blob: Blob
  try {
    blob = base64ToBlob(input.imageBase64, input.mimeType)
  } catch {
    return aiToolError('imageBase64 is not valid base64 data.')
  }

  const formData = new FormData()
  formData.append('dir', dir)
  if (input.targetDir) formData.append('targetDir', input.targetDir)
  const extension = MIME_TO_EXTENSION[input.mimeType] ?? 'bin'
  formData.append('file', blob, `upload.${extension}`)

  try {
    const body = await apiRequest('/admin/api/studio/asset-upload', {
      method: 'POST',
      body: formData,
      schema: AssetUploadResponseSchema,
    })
    if (!body.ok || !body.relPath) return aiToolError(body.error ?? 'Asset upload failed.')
    return aiToolOk({ relPath: body.relPath })
  } catch (err) {
    return aiToolError(getErrorMessage(err, 'Asset upload failed.'))
  }
}
