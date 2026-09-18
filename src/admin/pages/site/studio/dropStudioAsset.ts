/**
 * dropStudioAsset — the browser half of D2 G15: post the file the user dropped
 * onto a frame to `POST /admin/api/studio/asset-drop`, and get back the literal
 * an `<img src>` can be written with.
 *
 * A thin client on purpose. Nothing here inspects the bytes, decides a
 * directory or sanitises anything — every one of those is the server's, in
 * `assetDrop.ts` and the `landAssetBytes` pipeline it shares with the ordinary
 * upload. A client-side format check would be a second, weaker copy of the
 * rule that could only ever disagree with the authoritative one.
 *
 * Distinct from `uploadStudioAsset.ts` (the inspector's image-fill picker) for
 * the reason the two ROUTES are distinct: that one is told where the file
 * belongs, because it is about to repoint an existing import at it. A dropped
 * file has no import and no picker, and the element it is about to write takes
 * a literal `src` — so the server answers "which directory in this project can
 * back a literal, and what is the literal" and this call carries that answer
 * back.
 */
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

const AssetDropResponseSchema = Type.Object({
  ok: Type.Boolean(),
  /** Workspace-relative POSIX path of the file that was written. */
  relPath: Type.String(),
  /** The literal an `<img src>` uses — the file at the site root, e.g. `/photo.png`. */
  src: Type.String(),
})

export interface DroppedStudioAsset {
  relPath: string
  src: string
}

/**
 * Land `file` in the open project and return where it went.
 *
 * Throws `ApiError` on any refusal, carrying the server's own sentence — the
 * caller toasts it verbatim rather than inventing a second explanation for a
 * decision it did not make.
 */
export async function dropStudioAsset(file: File): Promise<DroppedStudioAsset> {
  const formData = new FormData()
  const dir = studioWriteDir()
  if (dir) formData.append('dir', dir)
  formData.append('file', file, file.name)

  const body = await apiRequest('/admin/api/studio/asset-drop', {
    method: 'POST',
    body: formData,
    schema: AssetDropResponseSchema,
  })
  return { relPath: body.relPath, src: body.src }
}
