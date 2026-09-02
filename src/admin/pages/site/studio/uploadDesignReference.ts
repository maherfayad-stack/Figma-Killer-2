/**
 * uploadDesignReference — client for the design-reference upload endpoint.
 *
 * HTTP CONTRACT (this browser half owns this file; the server-side reference
 * store is a separate, parallel change — coordinate through this shape, not
 * shared files):
 *
 *   POST /admin/api/studio/reference-upload
 *     multipart/form-data: `dir` (optional, same convention every studio
 *     route uses — see `SaveBodySchema`), `file` (the original, UN-re-encoded
 *     image bytes), `label` (optional — this client sends the picked file's
 *     own name, matching `RegisterDesignReferenceMeta.label`'s "human-
 *     readable name" role in `designReferenceStore.ts`).
 *     → 200 { ok: true, reference: DesignReferenceMeta }
 *     → 4xx { error: string }
 *
 *   GET /admin/api/studio/reference-upload?dir=<dir>
 *     → 200 { ok: true, reference: DesignReferenceMeta | null } — the most
 *     recently registered reference for the project, or null if none. Lets
 *     the panel restore state across a reload. A 404 (endpoint not wired up
 *     yet) is treated the same as "no reference attached" by the caller.
 *
 *   DELETE /admin/api/studio/reference-upload?dir=<dir>&id=<id>
 *     → 200 { ok: true } — removes the stored artifact.
 *
 * KNOWN GAP as of this writing (see this task's handoff in `STATE.md`): the
 * server-side `registerDesignReference`/`listDesignReferences`/
 * `getDesignReference` functions exist in `designReferenceStore.ts`, but (a)
 * no HTTP route wraps them yet — that store's only referenced caller so far
 * is the (also unbuilt) `studio_register_design_reference` MCP tool, an
 * AGENT-driven path, not a human-driven upload button — and (b) the store has
 * no delete-by-id function at all yet. This file's shape is this task's
 * proposal for the missing HUMAN-driven half; reconcile with whoever wires
 * the route rather than assuming either side is final.
 *
 * Upload uses `XMLHttpRequest` for the same reason `uploadStudioAsset.ts`
 * does: `fetch` exposes no upload progress events, and a lossless reference
 * (up to `DESIGN_REFERENCE_MAX_BYTES`) is exactly the kind of large binary
 * where progress matters. GET/DELETE have no body to report progress on, so
 * they go through the ordinary `apiRequest` stack.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { apiRequest } from '@core/http'
import { DesignReferenceMetaSchema, type DesignReferenceMeta } from '@core/ai'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

const DESIGN_REFERENCE_UPLOAD_PATH = '/admin/api/studio/reference-upload'

const DesignReferenceUploadResponseSchema = Type.Object({
  ok: Type.Boolean(),
  reference: DesignReferenceMetaSchema,
})

const DesignReferenceGetResponseSchema = Type.Object({
  ok: Type.Boolean(),
  reference: Type.Union([DesignReferenceMetaSchema, Type.Null()]),
})

export interface UploadDesignReferenceOptions {
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

/** Uploads a design reference's ORIGINAL bytes — never re-encoded, never resized. */
export function uploadDesignReference(
  file: File,
  options: UploadDesignReferenceOptions = {},
): Promise<DesignReferenceMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', DESIGN_REFERENCE_UPLOAD_PATH, true)
    xhr.withCredentials = true
    xhr.responseType = 'json'

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = xhr.response as unknown
        if (!compiledCheck(DesignReferenceUploadResponseSchema, data)) {
          reject(new Error('Server response did not match the expected shape'))
          return
        }
        resolve((data as Static<typeof DesignReferenceUploadResponseSchema>).reference)
      } else {
        reject(new Error(extractXhrErrorMessage(xhr) ?? `Upload failed with ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))

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
    if (file.name) body.set('label', file.name)
    body.set('file', file)
    xhr.send(body)
  })
}

/** The active project's most recently registered design reference, or `null` if none (including when the endpoint doesn't exist yet). */
export async function fetchDesignReference(signal?: AbortSignal): Promise<DesignReferenceMeta | null> {
  const result = await apiRequest(DESIGN_REFERENCE_UPLOAD_PATH, {
    method: 'GET',
    schema: DesignReferenceGetResponseSchema,
    query: { dir: getStudioWorkspaceDir() },
    signal,
  })
  return result.reference
}

/** Deletes a design reference's stored artifact by id. */
export async function deleteDesignReference(id: string, signal?: AbortSignal): Promise<void> {
  await apiRequest(DESIGN_REFERENCE_UPLOAD_PATH, {
    method: 'DELETE',
    query: { dir: getStudioWorkspaceDir(), id },
    signal,
  })
}
