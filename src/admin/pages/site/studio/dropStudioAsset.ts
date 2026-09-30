/**
 * dropStudioAsset — the browser half of `POST /admin/api/studio/asset-drop`
 * (and of its URL twin, `asset-drop-url`, IMG-5): land an image and get back
 * how the source should reference it — a LITERAL URL, or (IMG-10, when the
 * page it is dropped into imports its images) the file an import should
 * name. Callers: every image gesture through `landImageSource.ts`, the
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
import { apiRequest, apiUploadRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

const LandingFields = {
  /** Workspace-relative POSIX path of the file the image lives in. */
  relPath: Type.String(),
  /** Intrinsic size from the file's header; `null` when the format does not say. */
  width: Type.Union([Type.Number(), Type.Null()]),
  height: Type.Union([Type.Number(), Type.Null()]),
  /** True when identical bytes were already there and that file was reused. */
  deduped: Type.Boolean(),
}

/**
 * The two answers a landing can give, discriminated by `mode` (IMG-10,
 * OD-12). `public`: the file is in `public/` and `src` is the literal an
 * `<img src>` or CSS `url()` writes verbatim. `import`: the project imports
 * its images, so the file landed beside the ones it already imports and has
 * NO literal — the insert writes `src={__assetImport}` and the server spells
 * the import. A caller that reads `src` has to check `mode` first; that is the
 * point of the union.
 */
const AssetDropResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), mode: Type.Literal('public'), src: Type.String(), ...LandingFields }),
  Type.Object({ ok: Type.Literal(true), mode: Type.Literal('import'), ...LandingFields }),
])

export type DroppedStudioAsset = Static<typeof AssetDropResponseSchema>
export type PublicStudioAsset = Extract<DroppedStudioAsset, { mode: 'public' }>

export interface DropStudioAssetOptions {
  /**
   * P5-B (IMG-8) — fraction of the bytes sent, 0..1. The canvas drop fills
   * its ghost with it, which is why this goes through `apiUploadRequest`
   * (XHR) rather than `apiRequest` (`fetch` reports no upload progress).
   */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /**
   * IMG-10 — the workspace-relative source file the image is about to be
   * written INTO. Present only for an element insert: it is what lets the
   * server read that file's own convention (import vs. `public/`) and answer
   * `mode: 'import'`. Absent — a replace of a literal `src`, a background
   * `url()`, the free canvas — the answer is always `public`, because each of
   * those writes a literal.
   */
  pageRel?: string
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
  if (options.pageRel) formData.append('pageRel', options.pageRel)
  formData.append('file', file, file.name)

  return apiUploadRequest('/admin/api/studio/asset-drop', {
    body: formData,
    schema: AssetDropResponseSchema,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * {@link dropStudioAsset} for an image dragged out of another browser tab
 * (IMG-5, OD-13): the server fetches `url` through the SSRF guard
 * (`asset-drop-url.ts`) and lands it exactly as a dropped file lands. The
 * browser never fetches it — a cross-origin image is unreadable here anyway,
 * and a fetch from the admin origin would carry nothing the server's does not.
 */
export async function dropStudioAssetUrl(
  url: string,
  options: Pick<DropStudioAssetOptions, 'signal' | 'pageRel'> = {},
): Promise<DroppedStudioAsset> {
  const dir = studioWriteDir()
  return apiRequest('/admin/api/studio/asset-drop-url', {
    method: 'POST',
    body: { url, ...(dir ? { dir } : {}), ...(options.pageRel ? { pageRel: options.pageRel } : {}) },
    schema: AssetDropResponseSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * A landing that has to be a literal: the replace of a string `src`, a
 * background `url()`, a loose layer. Every one of those calls omits
 * `pageRel`, so the server can only answer `public` — this turns that
 * contract into a type, and an impossible answer into a loud error instead of
 * a `src` of `undefined` written into someone's file.
 */
export function requirePublicAsset(asset: DroppedStudioAsset): PublicStudioAsset {
  if (asset.mode !== 'public') throw new Error('The server answered an import landing for a literal write.')
  return asset
}
