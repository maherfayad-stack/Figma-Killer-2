/**
 * assetUpload — `POST /admin/api/studio/asset-upload`, the write-side sibling
 * of `studioAsset.ts`'s read-only asset endpoint (WS-8.3). Lands one image
 * file into the workspace so it can back either:
 *
 *   - a `kind: 'asset'` studio edit (`studioWriteback.ts`), which repoints an
 *     EXISTING `import heroImg from '...'` at the new file, or
 *   - a literal `src="..."` prop, written through the ordinary `kind: 'prop'`
 *     edit the client already has.
 *
 * Exported as its own sub-router (`tryServeStudioAssetUpload`) rather than
 * added inline to `studio.ts` — see that file's module doc and
 * `STUDIO_SUB_ROUTERS` for the composition pattern every parallel-wave route
 * follows; wiring this one in is the orchestrator's job (`meta-04`).
 *
 * Body is `multipart/form-data`:
 *   - `dir`       — the project directory (same field every studio route uses).
 *   - `targetDir` — optional, workspace-relative. Defaults to `src/assets`
 *     when omitted; the caller is expected to pass the directory an existing
 *     import already points at when replacing that import's target.
 *   - `file`      — the uploaded image.
 *
 * Response: `{ ok: true, relPath }` — the new file's workspace-relative POSIX
 * path, exactly the shape `kind: 'asset'`'s `assetPath` field expects and
 * `resolveContainedAssetPath` (`studioWriteback.ts`) re-validates before it is
 * ever used to rewrite an import.
 *
 * SECURITY — this is a write path into the user's repo, so every input is
 * adversarial, not just the happy path:
 *
 *   - `targetDir` gets the full guard set `resolveStudioAssetResponse` (the
 *     READ side) already established: absolute/UNC/drive-letter rejection,
 *     `..`/empty segments on EITHER separator, `EXCLUDED_WORKSPACE_DIR_NAMES`,
 *     lexical containment under `dir`, THEN containment on the REAL path of
 *     the nearest EXISTING ancestor (the target dir itself may not exist yet)
 *     — a workspace can arrive from GitHub, and git stores symlinks, so a
 *     textual check alone is bypassable.
 *   - The request body is capped by STREAMED byte count
 *     (`readFormDataWithLimit`), not `content-length` — a spoofed/missing
 *     header can't bypass the cap.
 *   - The file's declared name and MIME type are never trusted. The actual
 *     bytes are sniffed against real image magic numbers to decide both
 *     whether to accept it AND which extension to write it with — a
 *     `.png`-named, `image/png`-declared upload whose bytes are something
 *     else is rejected outright, not written with a lying extension. An SVG
 *     is sanitized before it touches disk.
 *   - The final filename is DERIVED (sanitized base name + sniffed
 *     extension), never the raw client-supplied name — no path separators,
 *     no traversal, no surprise overwrite of an unrelated file (collisions
 *     get a numeric suffix instead of clobbering).
 *
 * All of the above (containment, sniffing, SVG sanitization, collision-safe
 * naming) lives in `assetLanding.ts` — this route is now a thin HTTP shell
 * around `landAssetBytes`, the SAME landing pipeline `studio_fetch_remote_
 * asset` (`remoteAssetFetch.ts`) uses for a server-side URL fetch instead of
 * a multipart upload. One implementation, two callers, never two copies of
 * the same security-sensitive write path.
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse } from '../../http'
import { ArchiveIngestError, readFormDataWithLimit } from './archiveIngest'
import { resolveProjectDir } from '../studioProjects'
import { landAssetBytes } from './assetLanding'

/** Per-file cap for an asset upload — tighter than the general archive-import cap; a single image has no business exceeding this. */
export const MAX_ASSET_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

const AssetUploadFieldsSchema = Type.Object({
  // Optional, same convention as every other studio route's `dir` field
  // (`SaveBodySchema` etc.) — `resolveProjectDir(undefined)` falls back to
  // the first project on disk, so a client that hasn't overridden the active
  // workspace still uploads against the right project.
  dir: Type.Optional(Type.String()),
  targetDir: Type.Optional(Type.String()),
})

export interface AssetUploadDeps {
  /**
   * Overrides the real `resolveProjectDir` — test-only, mirrors
   * `ImportUploadDeps.projectsRoot` in `studio/importUpload.ts`. Without this
   * seam, a test that omits `dir` (a real, supported request shape — see
   * `SaveBodySchema`'s identical `Type.Optional`) would fall back to THIS
   * repo's own real `studio-workspace/` and could write a test fixture into
   * it, which is never allowed.
   */
  resolveDir?: (requested: string | null | undefined) => string
}

// `_url` is unused (this route only branches on `pathname`) but kept in the
// signature so this sub-router matches the shape `tryServeStudio` already
// composes (`req, url, pathname`) — see `server/handlers/studio.ts`.
export async function tryServeStudioAssetUpload(
  req: Request,
  _url: URL,
  pathname: string,
  deps: AssetUploadDeps = {},
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/asset-upload' || req.method !== 'POST') return null

  try {
    const form = await readFormDataWithLimit(req, MAX_ASSET_UPLOAD_BYTES)

    const dirRaw = form.get('dir')
    const targetDirRaw = form.get('targetDir')
    const parsedFields = safeParseValue(AssetUploadFieldsSchema, {
      dir: typeof dirRaw === 'string' ? dirRaw : undefined,
      targetDir: typeof targetDirRaw === 'string' ? targetDirRaw : undefined,
    })
    if (!parsedFields.ok) return badRequest('invalid asset-upload body')

    const file = form.get('file')
    if (!(file instanceof File)) return badRequest('no file was uploaded')
    if (file.size === 0) return badRequest('the uploaded file is empty')
    if (file.size > MAX_ASSET_UPLOAD_BYTES) {
      return jsonResponse(
        { error: `The image is larger than the ${Math.round(MAX_ASSET_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.` },
        { status: 413 },
      )
    }

    const resolveDir = deps.resolveDir ?? resolveProjectDir
    const dir = resolveDir(parsedFields.value.dir)
    const bytes = new Uint8Array(await file.arrayBuffer())

    const landed = landAssetBytes(dir, parsedFields.value.targetDir, bytes, file.name)
    if (!landed.ok) return badRequest(landed.error)

    return jsonResponse({ ok: true, relPath: landed.relPath })
  } catch (err) {
    console.error('[studio]', err)
    if (err instanceof ArchiveIngestError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
