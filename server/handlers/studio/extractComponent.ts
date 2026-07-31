/**
 * extractComponent — `POST /admin/api/studio/extract-component`, WS-4.4's
 * detach-refusal escape hatch (`extractComponentCopy`) as a plain HTTP route
 * the ADMIN BROWSER can call.
 *
 * `studio_codemod`'s `extract-component` verb
 * (`server/ai/mcp/tools/studio/editTools.ts`) already reaches the same
 * codemod for AI agents, but there was no `/admin/api/studio/*` path for it
 * at all — the Properties panel's own "Card uses useState — duplicate it as
 * Card2.tsx and edit that instead?" offer (instance-ui-01) had nothing to
 * call. Exactly the "engine shipped, nothing invokes it" gap this work order
 * exists to close (see STATE.md's `parser-05` entry, "Honest gaps" #3).
 *
 * Not folded into `POST /admin/api/studio/save`'s `StudioEdit` union: every
 * kind in that union applies to exactly the calling node's own location and
 * returns a plain applied/refused outcome. Extract additionally MINTS a
 * brand-new file and a brand-new component name — the caller needs both
 * back to know what just happened (and, in the panel, to say so) — which
 * doesn't fit that union's shared response shape without special-casing it
 * there too. One field, one job, same reasoning `trustTier.ts` documents for
 * its own narrow sub-router.
 *
 *   POST /admin/api/studio/extract-component  body: { dir?, nodeId }
 *     -> `{ ok: true, newFile, newComponentName }` on success — the SAME
 *        call site now points at the copy (an ordinary `swap`-shaped
 *        structural rewrite under the hood), so the client reloads exactly
 *        the way it does for a successful swap.
 *     -> `{ ok: false, reason, message }` on refusal (`not-a-component`,
 *        `unresolvable`, `copy-exists`) — never a silent no-op.
 */
import { join } from 'node:path'
import { extractComponentCopy } from '@core/ast-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir } from '../studioProjects'
import { studioEditLocation } from '../studioWriteback'

const ROUTE_PATH = '/admin/api/studio/extract-component'

const ExtractComponentBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** A `studio.instance` node's own id — the call site's plain (non-composite) location. */
  nodeId: Type.String(),
})
export type ExtractComponentBody = Static<typeof ExtractComponentBodySchema>

/** `POST /admin/api/studio/extract-component` — see module doc for the full contract. */
export async function tryServeStudioExtractComponent(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, ExtractComponentBodySchema)
    if (!body) return badRequest('invalid extract-component body')
    const dir = resolveProjectDir(body.dir)

    const target = studioEditLocation(body.nodeId)
    if (!target) {
      // Mirrors `applyStudioEdit`'s own "no writable source location" outcome
      // for every other edit kind — a synthetic/unresolvable node id is not
      // an unexpected error, just nothing this route can act on.
      return jsonResponse({
        ok: false,
        reason: 'unresolvable',
        message: 'This node has no writable source location.',
      })
    }

    const result = extractComponentCopy({
      file: join(dir, target.rel),
      line: target.line,
      col: target.col,
      workspaceRoot: dir,
    })

    if (!result.ok) {
      return jsonResponse({ ok: false, reason: result.refusal.reason, message: result.refusal.message })
    }
    return jsonResponse({ ok: true, newFile: result.newFile, newComponentName: result.newComponentName })
  } catch (err) {
    console.error('[studio:extractComponent]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
