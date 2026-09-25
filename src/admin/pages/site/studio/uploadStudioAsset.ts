/**
 * uploadStudioAsset — client for `POST /admin/api/studio/asset-upload`
 * (WS-8.3): land an image in a directory the caller names, because it is
 * about to repoint an existing import at it. A file upload with progress, so
 * it goes through `apiUploadRequest` — `@core/http`'s one XHR upload client,
 * which validates the body against the schema below exactly as `apiRequest`
 * would.
 */
import { apiUploadRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

const AssetUploadResponseSchema = Type.Object({
  ok: Type.Boolean(),
  /** Workspace-relative POSIX path of the written file — feeds `kind: 'asset'`'s `assetPath`. */
  relPath: Type.String(),
  /**
   * The site-root URL when the file landed under the app's `public/`, else
   * `null` (a file in `src/assets` is reachable only through an import). The
   * server's `assetSiteUrl.ts` decides; this client never derives a URL.
   */
  src: Type.Union([Type.String(), Type.Null()]),
  width: Type.Union([Type.Number(), Type.Null()]),
  height: Type.Union([Type.Number(), Type.Null()]),
  /** True when identical bytes already sat in the target directory and that file was reused. */
  deduped: Type.Boolean(),
})
export type AssetUploadResponse = Static<typeof AssetUploadResponseSchema>

export interface UploadStudioAssetOptions {
  /** Workspace-relative directory to write into. Server defaults to `src/assets` when omitted. */
  targetDir?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export async function uploadStudioAsset(file: File, options: UploadStudioAssetOptions = {}): Promise<AssetUploadResponse> {
  const body = new FormData()
  // `studioWriteDir()`, the same helper every other Studio write uses: the
  // explicit selection, else the dir the last load actually read. The bare
  // localStorage override skipped the second half, so a session with no
  // explicit selection could land the file in a different project.
  const dir = studioWriteDir()
  if (dir) body.set('dir', dir)
  if (options.targetDir) body.set('targetDir', options.targetDir)
  body.set('file', file)
  return apiUploadRequest('/admin/api/studio/asset-upload', {
    body,
    schema: AssetUploadResponseSchema,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
