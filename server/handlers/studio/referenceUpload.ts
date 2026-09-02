/**
 * referenceUpload — `POST/GET/DELETE /admin/api/studio/reference-upload`,
 * the browser HTTP counterpart of `studio_register_design_reference` /
 * `studio_list_design_references` / `studio_delete_design_reference` (MCP
 * tools, `server/ai/mcp/tools/studio/designReferenceTools.ts`). Both sides
 * land on the SAME store (`designReferenceStore.ts`) — there is exactly one
 * place a design reference's bytes are written, sniffed, and recorded,
 * whether the caller is a human attaching a file in the chat composer
 * (`src/admin/pages/site/panels/AgentPanel/DesignReferenceAttachment.tsx`
 * via `src/admin/pages/site/studio/uploadDesignReference.ts`, which
 * specifies this EXACT HTTP contract in its own header comment — coordinate
 * through that shape, not shared files) or an external MCP agent.
 *
 * Same posture as `assetUpload.ts` (`POST /admin/api/studio/asset-upload`),
 * the direct precedent for an authenticated binary upload into a Studio
 * project: the request body is capped by STREAMED byte count
 * (`readFormDataWithLimit`), never `content-length`; the uploaded file's
 * declared name/MIME type are never trusted (the store sniffs real magic
 * numbers via `landAssetBytes`); and `dir` is containment-checked against
 * `projectsRootDir()` before anything touches disk (`trustTier.ts`'s
 * pattern — a caller-supplied absolute `dir` is adversarial input here, same
 * as everywhere else in this file).
 *
 * Contract (mirrors `uploadDesignReference.ts`'s header comment):
 *
 *   POST /admin/api/studio/reference-upload
 *     multipart/form-data: `dir` (optional), `file` (the original,
 *     un-re-encoded image bytes).
 *     -> 200 { ok: true, reference: DesignReference }
 *     -> 4xx { error: string }
 *
 *   GET /admin/api/studio/reference-upload?dir=<dir>
 *     -> 200 { ok: true, reference: DesignReference | null } — see
 *     `getMostRecentDesignReference`'s doc for what "the project's currently
 *     attached reference" means over a store that is addressable-by-many.
 *
 *   DELETE /admin/api/studio/reference-upload?dir=<dir>&id=<id>
 *     -> 200 { ok: true } — always, even for an unknown id (idempotent, see
 *     `removeDesignReference`).
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse } from '../../http'
import { DESIGN_REFERENCE_MAX_BYTES } from '@core/ai'
import { ArchiveIngestError, readFormDataWithLimit } from './archiveIngest'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { getMostRecentDesignReference, registerDesignReference, removeDesignReference } from './designReferenceStore'

const ROUTE_PATH = '/admin/api/studio/reference-upload'

/** Same convention as `assetUpload.ts`'s `AssetUploadFieldsSchema` — the non-file multipart fields, validated before anything touches disk. */
const ReferenceUploadFieldsSchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

/** `resolveProjectDir` accepts any absolute path — re-check it lands under `studio-workspace/` before this route does anything with it, the same extra guard `trustTier.ts` applies. */
function resolveContainedProjectDir(requested: string | null | undefined): string | null {
  const dir = resolveProjectDir(requested)
  return isRealpathContained(dir, projectsRootDir()) ? dir : null
}

export async function tryServeStudioReferenceUpload(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'POST') {
    try {
      const form = await readFormDataWithLimit(req, DESIGN_REFERENCE_MAX_BYTES)

      const dirRaw = form.get('dir')
      const parsedFields = safeParseValue(ReferenceUploadFieldsSchema, {
        dir: typeof dirRaw === 'string' ? dirRaw : undefined,
      })
      if (!parsedFields.ok) return badRequest('invalid reference-upload body')

      const dir = resolveContainedProjectDir(parsedFields.value.dir)
      if (!dir) return badRequest('invalid project directory')

      const file = form.get('file')
      if (!(file instanceof File)) return badRequest('no file was uploaded')
      if (file.size === 0) return badRequest('the uploaded file is empty')
      if (file.size > DESIGN_REFERENCE_MAX_BYTES) {
        return jsonResponse(
          { error: `The image is larger than the ${Math.round(DESIGN_REFERENCE_MAX_BYTES / (1024 * 1024))} MB upload limit.` },
          { status: 413 },
        )
      }

      const bytes = new Uint8Array(await file.arrayBuffer())
      // No `pageId` — a chat-panel attachment is a general project reference,
      // not scoped to one page. `label` records the picked file's own name so
      // a later reader (the panel restoring state, or an MCP list call) has
      // something human-readable beyond the bare id.
      const result = await registerDesignReference(dir, bytes, { label: file.name })
      if (!result.ok) return badRequest(result.error)

      return jsonResponse({ ok: true, reference: result.reference })
    } catch (err) {
      console.error('[studio:referenceUpload]', err)
      if (err instanceof ArchiveIngestError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'GET') {
    try {
      const dir = resolveContainedProjectDir(url.searchParams.get('dir'))
      if (!dir) return new Response('Not found', { status: 404 })
      return jsonResponse({ ok: true, reference: getMostRecentDesignReference(dir) })
    } catch (err) {
      console.error('[studio:referenceUpload]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const dir = resolveContainedProjectDir(url.searchParams.get('dir'))
      if (!dir) return badRequest('invalid project directory')
      const id = url.searchParams.get('id')
      if (!id) return badRequest('missing id')
      removeDesignReference(dir, id)
      // Always `{ ok: true }` — see `removeDesignReference`'s idempotency doc.
      return jsonResponse({ ok: true })
    } catch (err) {
      console.error('[studio:referenceUpload]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
