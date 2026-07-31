/**
 * uploadStudioAsset — client for `POST /admin/api/studio/asset-upload`
 * (WS-8.3). The one sanctioned exception to "always use `apiRequest`": a file
 * upload with progress needs `XMLHttpRequest` (`fetch` exposes no upload
 * progress events) — same technique `useUploadQueue` already uses for CMS
 * media, scoped down to Studio's single-file endpoint.
 *
 * Response is validated the same way the fetch path would (`compiledCheck`
 * against a TypeBox schema) since XHR hands back parsed JSON directly rather
 * than a `Response` `readEnvelope`/`apiRequest` could consume.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

const AssetUploadResponseSchema = Type.Object({
  ok: Type.Boolean(),
  /** Workspace-relative POSIX path of the written file — feeds `kind: 'asset'`'s `assetPath`. */
  relPath: Type.String(),
})
export type AssetUploadResponse = Static<typeof AssetUploadResponseSchema>

export interface UploadStudioAssetOptions {
  /** Workspace-relative directory to write into. Server defaults to `src/assets` when omitted. */
  targetDir?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Reads the `{ error }` envelope off an XHR JSON response, same shape every studio route returns on failure. */
function extractXhrErrorMessage(xhr: XMLHttpRequest): string | null {
  const response = xhr.response as unknown
  if (response && typeof response === 'object' && 'error' in response) {
    const errorField = (response as { error?: unknown }).error
    if (typeof errorField === 'string') return errorField
  }
  return null
}

export function uploadStudioAsset(file: File, options: UploadStudioAssetOptions = {}): Promise<AssetUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/admin/api/studio/asset-upload', true)
    xhr.withCredentials = true
    xhr.responseType = 'json'

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = xhr.response as unknown
        if (!compiledCheck(AssetUploadResponseSchema, data)) {
          reject(new Error('Server response did not match the expected shape'))
          return
        }
        resolve(data as AssetUploadResponse)
      } else {
        reject(new Error(extractXhrErrorMessage(xhr) ?? `Upload failed with ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort()
        return
      }
      options.signal.addEventListener('abort', () => xhr.abort())
    }

    const body = new FormData()
    const overrideDir = getStudioWorkspaceDir()
    if (overrideDir) body.set('dir', overrideDir)
    if (options.targetDir) body.set('targetDir', options.targetDir)
    body.set('file', file)
    xhr.send(body)
  })
}
