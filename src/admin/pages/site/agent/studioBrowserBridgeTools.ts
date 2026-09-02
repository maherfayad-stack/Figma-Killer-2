/**
 * Browser-side implementations for the three WS-12 §6.1 parity-gap tools —
 * `studio_set_frame_axes`, `studio_duplicate_frame_as_variant`,
 * `studio_upload_asset`. Dispatched by `executor.ts`, same as every other
 * browser-bridged Studio tool (`studioExportFrames.ts` is the direct
 * precedent this file follows).
 *
 * All three are thin wrappers over verbs that already exist and are already
 * tested — `EditorStore.setFrameAxes`/`duplicateFrameAsVariant` (the SAME
 * actions the toolbar's own preview-axes/duplicate-as-variant controls call)
 * and `POST /admin/api/studio/asset-upload` (the SAME endpoint the canvas's
 * asset picker uses). Nothing here reimplements their behaviour.
 */
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { useAdminUi } from '@admin/state/adminUi'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  StudioSetFrameAxesInputSchema,
  StudioDuplicateFrameAsVariantInputSchema,
  StudioUploadAssetInputSchema,
} from '@core/ai'
import type { EditorStore } from '@site/store/types'
import type { Board, BoardFrame } from '@core/studio-board'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getAgentStoreApi } from './storeRef'

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * The first frame on the ACTIVE board matching `pageId` (or the SPECIFIC
 * `frameId` when given) — the addressing rule `studio_set_frame_axes`/
 * `studio_duplicate_frame_as_variant`'s own tool descriptions state. `null`
 * when there is no active board, or no matching frame on it.
 */
function findFrame(store: EditorStore, pageId: string, frameId: string | undefined): { board: Board; frame: BoardFrame } | null {
  const board = store.boards.boards.find((b) => b.id === store.activeBoardId)
  if (!board) return null
  const frame = frameId
    ? board.frames.find((f) => f.id === frameId)
    : board.frames.find((f) => f.pageId === pageId)
  if (!frame) return null
  return { board, frame }
}

export function runSetFrameAxes(rawInput: unknown): AiToolOutput {
  const input = parseValue(StudioSetFrameAxesInputSchema, rawInput)
  const store = getStoreState()
  const found = findFrame(store, input.pageId, input.frameId)
  if (!found) {
    return aiToolError(
      input.frameId
        ? `Frame not found on the active board: ${input.frameId}`
        : `No frame for page "${input.pageId}" on the active board. Place it on the board first (studio_create_page auto-places one).`,
    )
  }
  store.setFrameAxes(found.frame.id, input.axes)
  return aiToolOk({ frameId: found.frame.id })
}

export function runDuplicateFrameAsVariant(rawInput: unknown): AiToolOutput {
  const input = parseValue(StudioDuplicateFrameAsVariantInputSchema, rawInput)
  const store = getStoreState()
  const found = findFrame(store, input.pageId, input.frameId)
  if (!found) {
    return aiToolError(
      input.frameId
        ? `Frame not found on the active board: ${input.frameId}`
        : `No frame for page "${input.pageId}" on the active board. Place it on the board first (studio_create_page auto-places one).`,
    )
  }
  const newFrameId = store.duplicateFrameAsVariant(found.frame.id, input.axes)
  if (!newFrameId) return aiToolError('Could not duplicate the frame — the active board or source frame disappeared mid-call.')
  return aiToolOk({ frameId: newFrameId })
}

// ---------------------------------------------------------------------------
// studio_upload_asset
// ---------------------------------------------------------------------------

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
