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
 *     un-re-encoded image bytes), plus the optional fidelity fields
 *     `pageId`, `mode` ('creative'|'balanced'|'strict'), `passScore`,
 *     `maxRegionCoverage`. Always lands as `role: 'spec'` — see the register
 *     call below.
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
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { getMostRecentDesignReference, registerDesignReference, removeDesignReference } from './designReferenceStore'

const ROUTE_PATH = '/admin/api/studio/reference-upload'

/**
 * Same convention as `assetUpload.ts`'s `AssetUploadFieldsSchema` — the
 * non-file multipart fields, validated before anything touches disk.
 *
 * `pageId`/`mode`/`passScore`/`maxRegionCoverage` are the fidelity knobs a
 * caller MAY set at upload time. There is deliberately no `role` field: the
 * DESIGN REFERENCE control is itself the explicit gesture, so anything landing
 * here is a `spec` by construction — a browser that could ask for `context`
 * would be asking for an image the user just nominated to be ignored.
 *
 * Multipart values arrive as strings, so the two numeric fields are converted
 * before validation and a non-numeric value is rejected rather than coerced to
 * `NaN` — a silently-dropped threshold is exactly the kind of quiet wrong
 * answer this whole change exists to remove.
 */
const ReferenceUploadFieldsSchema = Type.Object({
  dir: Type.Optional(Type.String()),
  pageId: Type.Optional(Type.String({ minLength: 1 })),
  mode: Type.Optional(Type.Union([
    Type.Literal('creative'),
    Type.Literal('balanced'),
    Type.Literal('strict'),
  ])),
  passScore: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  maxRegionCoverage: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
})

/** A multipart field as a string, or `undefined` when absent/not a string. */
function textField(form: FormData, name: string): string | undefined {
  const raw = form.get(name)
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** `undefined` when absent; `NaN` when present but not a number, which the schema then rejects. */
function numberField(form: FormData, name: string): number | undefined {
  const raw = textField(form, name)
  return raw === undefined ? undefined : Number(raw)
}

export async function tryServeStudioReferenceUpload(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'POST') {
    try {
      const form = await readFormDataWithLimit(req, DESIGN_REFERENCE_MAX_BYTES)

      const parsedFields = safeParseValue(ReferenceUploadFieldsSchema, {
        dir: textField(form, 'dir'),
        pageId: textField(form, 'pageId'),
        mode: textField(form, 'mode'),
        passScore: numberField(form, 'passScore'),
        maxRegionCoverage: numberField(form, 'maxRegionCoverage'),
      })
      if (!parsedFields.ok) return badRequest('invalid reference-upload body')

      const dir = resolveProjectDir(parsedFields.value.dir)

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
      // `role: 'spec'` — reaching this route means a human used the composer's
      // DESIGN REFERENCE control, which is the deliberate act that separates a
      // design from an image that merely got pasted into the conversation
      // (those arrive via `registerTurnDesignReferences` as `context`).
      //
      // `pageId` stays OPTIONAL rather than required: this control has always
      // registered a general project reference, and the panel does not send
      // one today. An unscoped spec still outranks every chat attachment; it
      // is only outranked by a spec registered FOR the page being measured.
      // `label` records the picked file's own name so a later reader (the
      // panel restoring state, or an MCP list call) has something
      // human-readable beyond the bare id.
      const { pageId, mode, passScore, maxRegionCoverage } = parsedFields.value
      const result = await registerDesignReference(dir, bytes, {
        label: file.name,
        role: 'spec',
        pageId,
        mode,
        passScore,
        maxRegionCoverage,
      })
      if (!result.ok) return badRequest(result.error)

      return jsonResponse({ ok: true, reference: result.reference })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:referenceUpload]', err)
      if (err instanceof ArchiveIngestError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      return jsonResponse({ ok: true, reference: getMostRecentDesignReference(dir) })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:referenceUpload]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const id = url.searchParams.get('id')
      if (!id) return badRequest('missing id')
      removeDesignReference(dir, id)
      // Always `{ ok: true }` — see `removeDesignReference`'s idempotency doc.
      return jsonResponse({ ok: true })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[studio:referenceUpload]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
