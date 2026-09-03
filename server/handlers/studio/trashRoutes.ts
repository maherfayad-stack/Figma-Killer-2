/**
 * trashRoutes — the HTTP surface over `pageTrash.ts`.
 *
 *   GET    /admin/api/studio/trash?dir=<abs>
 *       Every page currently in `.studio/trash/`, newest first. Read-only —
 *       cheap enough for the explorer's Trash section to re-fetch after any
 *       change rather than mirroring server state client-side.
 *
 *   POST   /admin/api/studio/trash          body: { dir?, pageId, title }
 *       Move a live page into the trash. `title` is carried so the Trash list
 *       can name the page without re-parsing a file that is no longer where
 *       any parser would look for it.
 *
 *   POST   /admin/api/studio/trash/restore  body: { dir?, entryId }
 *       Put one back, and re-place its board frame. 409 when a path it owns is
 *       occupied again — see `restoreTrashedPage` for why that refuses rather
 *       than overwrites.
 *
 *   DELETE /admin/api/studio/trash          body: { dir?, entryId? }
 *       Permanently remove one entry, or empty the trash when `entryId` is
 *       omitted.
 *
 * Its own sub-router rather than more branches in `projectRoutes.ts`: that
 * module owns project lifecycle (list/create/rename/scaffold/delete), and the
 * trash is a different question with four routes of its own.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { listTrashedPages, purgeTrash, restoreTrashedPage, trashStudioPage } from './pageTrash'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/trash'
const RESTORE_PATH = '/admin/api/studio/trash/restore'

const TrashPageBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  pageId: Type.String(),
  title: Type.String(),
})

const RestoreBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  entryId: Type.String(),
})

const PurgeBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** Omitted means "empty the whole trash" — the explicit, deliberate gesture behind the section's "Empty trash" action. */
  entryId: Type.Optional(Type.String()),
})

/**
 * Resolve the project directory and confirm it is really inside the projects
 * root, the same guard `reloadScope.ts` applies. Every route here writes or
 * deletes files, so none of them may act on a `dir` that resolved outside.
 */
function resolveContainedDir(requested: string | undefined): string | null {
  const dir = resolveProjectDir(requested)
  return isRealpathContained(dir, projectsRootDir()) ? dir : null
}

export async function tryServeStudioTrash(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH && pathname !== RESTORE_PATH) return null

  try {
    if (pathname === ROUTE_PATH && req.method === 'GET') {
      const dir = resolveContainedDir(url.searchParams.get('dir') ?? undefined)
      if (!dir) return new Response('Not found', { status: 404 })
      return jsonResponse({ ok: true, entries: listTrashedPages(dir) })
    }

    if (pathname === ROUTE_PATH && req.method === 'POST') {
      const body = await readValidatedBody(req, TrashPageBodySchema)
      if (!body) return badRequest('invalid trash body')
      const dir = resolveContainedDir(body.dir)
      if (!dir) return new Response('Not found', { status: 404 })
      const result = trashStudioPage(dir, body.pageId, body.title)
      if (!result.ok) return jsonResponse({ error: result.notFound }, { status: 404 })
      return jsonResponse(result)
    }

    if (pathname === RESTORE_PATH && req.method === 'POST') {
      const body = await readValidatedBody(req, RestoreBodySchema)
      if (!body) return badRequest('invalid restore body')
      const dir = resolveContainedDir(body.dir)
      if (!dir) return new Response('Not found', { status: 404 })
      const result = restoreTrashedPage(dir, body.entryId)
      if (result.ok) return jsonResponse(result)
      // A conflict is a different answer from "no such entry": one is the
      // user's to resolve by renaming, the other is a stale id.
      return 'conflict' in result
        ? jsonResponse({ error: result.conflict }, { status: 409 })
        : jsonResponse({ error: result.notFound }, { status: 404 })
    }

    if (pathname === ROUTE_PATH && req.method === 'DELETE') {
      const body = await readValidatedBody(req, PurgeBodySchema)
      if (!body) return badRequest('invalid purge body')
      const dir = resolveContainedDir(body.dir)
      if (!dir) return new Response('Not found', { status: 404 })
      return jsonResponse({ ok: true, purged: purgeTrash(dir, body.entryId) })
    }

    return null
  } catch (err) {
    console.error('[studio:trash]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
