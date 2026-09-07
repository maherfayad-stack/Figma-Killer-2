/**
 * trashRoutes — the workspace trash's HTTP surface, the other half of
 * `POST /admin/api/studio/delete`.
 *
 *   GET  /admin/api/studio/trash                     → { projects }
 *   POST /admin/api/studio/trash/restore { entry }   → { project }
 *   POST /admin/api/studio/trash/purge   { entry }   → { projects }
 *
 * ## Why these are their own module
 *
 * `projectRoutes.ts` is the lifecycle of a LIVE project — list, create,
 * rename, duplicate, delete. Everything here addresses a directory that is no
 * longer a project, by a trash entry name rather than a project dir, and none
 * of it shares a schema or a helper with that file. Keeping them apart is the
 * same "one reason per module" split `projectRoutes.ts` itself came from.
 *
 * ## Why `entry`, never a path
 *
 * Every route addresses a trashed project by its bare folder name inside
 * `.trash/`. That name is what `GET /admin/api/studio/trash` hands out, and
 * `projectTrash.ts` re-derives the directory from it with the same
 * parent-comparison containment check `trashStudioProject` uses. A `dir`
 * field would put a caller-supplied path one validation bug away from an
 * `rmSync`, which is not a risk this feature needs to take.
 *
 * ## The capability split
 *
 * Restore and purge are gated on `studio.write`, alongside `/delete` and
 * `/duplicate`: one moves a whole repository back into the workspace, the
 * other erases one permanently. The listing is NOT gated, matching
 * `GET /admin/api/studio/projects` — it reads names and sizes out of a
 * directory the projects listing already exposes the siblings of, and gating
 * only the reads would leave the launcher unable to tell the user their
 * deleted work still exists.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, studioProjectSummary } from '../studioProjects'
import {
  ProjectTrashError,
  listTrashedProjects,
  purgeTrashedProject,
  restoreTrashedProject,
} from './projectTrash'

/** Body of both write routes: the trash entry's folder name, exactly as the listing reported it. */
const TrashEntryBodySchema = Type.Object({
  entry: Type.String(),
})

/** `not-found` → 404, `slug-taken` → 409, every other reason is a malformed request. */
function trashErrorResponse(err: ProjectTrashError): Response {
  const status = err.reason === 'not-found' ? 404 : err.reason === 'slug-taken' ? 409 : 400
  return jsonResponse({ error: err.message }, { status })
}

/**
 * `runtime` is here for the two write routes' capability checks, which is why
 * this rides `STUDIO_SESSION_SUB_ROUTERS` rather than the plain
 * `(req, url, pathname)` loop — the same list `tryServeStudioProjectRoutes`
 * is on, for the same reason.
 */
export async function tryServeStudioTrashRoutes(
  req: Request,
  runtime: { db: DbClient },
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname === '/admin/api/studio/trash' && req.method === 'GET') {
    try {
      return jsonResponse({ projects: listTrashedProjects(projectsRootDir()) })
    } catch (err) {
      console.error('[studio/trashRoutes]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/trash/restore' && req.method === 'POST') {
    const user = await requireCapability(req, runtime.db, 'studio.write')
    if (user instanceof Response) return user
    try {
      const body = await readValidatedBody(req, TrashEntryBodySchema)
      if (!body) return badRequest('invalid restore body')
      const entry = body.entry.trim()
      if (!entry) return badRequest('restore requires a trash entry')
      const dir = restoreTrashedProject(projectsRootDir(), entry)
      // The restored project's own summary, so the launcher can open it
      // straight from the toast without a second round trip — the same
      // `studioProjectSummary` shape `/create`, `/rename` and `/duplicate`
      // answer with.
      return jsonResponse({ project: studioProjectSummary(dir) })
    } catch (err) {
      if (err instanceof ProjectTrashError) return trashErrorResponse(err)
      console.error('[studio/trashRoutes]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (pathname === '/admin/api/studio/trash/purge' && req.method === 'POST') {
    const user = await requireCapability(req, runtime.db, 'studio.write')
    if (user instanceof Response) return user
    try {
      const body = await readValidatedBody(req, TrashEntryBodySchema)
      if (!body) return badRequest('invalid purge body')
      const entry = body.entry.trim()
      if (!entry) return badRequest('purge requires a trash entry')
      purgeTrashedProject(projectsRootDir(), entry)
      // The refreshed trash listing, so the panel redraws from the server's
      // answer rather than splicing out the row it just asked to erase.
      return jsonResponse({ projects: listTrashedProjects(projectsRootDir()) })
    } catch (err) {
      if (err instanceof ProjectTrashError) return trashErrorResponse(err)
      console.error('[studio/trashRoutes]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
