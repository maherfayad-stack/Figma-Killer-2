/**
 * dropStudioAsset — the browser half of `POST /admin/api/studio/asset-drop`:
 * land an image that is about to be referenced by a LITERAL URL, and get that
 * URL back. Three callers: a file dropped on a frame (D2 G15), the
 * inspector's "Replace image" on an `<img>` with a string `src`, and the Fill
 * section's image upload.
 *
 * A thin client on purpose. Nothing here inspects the bytes, decides a
 * directory, sanitises anything or derives a URL — every one of those is the
 * server's, in `assetDrop.ts`, the `landAssetBytes` pipeline, and
 * `assetSiteUrl.ts` (the one "file on disk → URL" rule). A client-side copy
 * of any of them would be a second, weaker rule that could only ever disagree
 * with the authoritative one. IMG-1 deleted the last such copies
 * (`cssUrlForAssetPath`, and the inspector's `'/' + relPath` that wrote
 * `src="/src/assets/x.png"`, a URL that 404s in a production build).
 *
 * Distinct from `uploadStudioAsset.ts` for the reason the two ROUTES are
 * distinct: that one is told where the file belongs, because it is about to
 * repoint an existing import at it. A literal has no import, so the server
 * answers "which directory in this project can back a literal, and what is
 * the literal" and this call carries that answer back.
 */
import { apiUploadRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

/**
 * The landing in `public/`, referenced by `src`. IMG-10's import convention
 * will join this as a union member discriminated by `mode` with no `src`, so
 * every caller that reads `src` without checking `mode` stops compiling then.
 */
const AssetDropPublicResponseSchema = Type.Object({
  ok: Type.Literal(true),
  mode: Type.Literal('public'),
  /** Workspace-relative POSIX path of the file the image lives in. */
  relPath: Type.String(),
  /** The literal an `<img src>` or CSS `url()` uses, e.g. `/photo.png`. Written verbatim, never re-derived. */
  src: Type.String(),
  /** Intrinsic size from the file's header; `null` when the format does not say. */
  width: Type.Union([Type.Number(), Type.Null()]),
  height: Type.Union([Type.Number(), Type.Null()]),
  /** True when identical bytes were already in `public/` and that file was reused. */
  deduped: Type.Boolean(),
})

const AssetDropResponseSchema = AssetDropPublicResponseSchema

export type DroppedStudioAsset = Static<typeof AssetDropResponseSchema>

export interface DropStudioAssetOptions {
  /**
   * P5-B (IMG-8) — fraction of the bytes sent, 0..1. The canvas drop fills
   * its ghost with it, which is why this goes through `apiUploadRequest`
   * (XHR) rather than `apiRequest` (`fetch` reports no upload progress).
   */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Land `file` in the open project and return where it went.
 *
 * Throws `ApiError` on any refusal, carrying the server's own sentence — the
 * caller toasts it verbatim rather than inventing a second explanation for a
 * decision it did not make. A lost response is retried with an idempotency
 * key (`IDEMPOTENT_REPLAY_PATHS`, which `apiUploadRequest` reads exactly as
 * `apiRequest` does), and the server replays the first answer.
 */
export async function dropStudioAsset(file: File, options: DropStudioAssetOptions = {}): Promise<DroppedStudioAsset> {
  const formData = new FormData()
  const dir = studioWriteDir()
  if (dir) formData.append('dir', dir)
  formData.append('file', file, file.name)

  return apiUploadRequest('/admin/api/studio/asset-drop', {
    body: formData,
    schema: AssetDropResponseSchema,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
