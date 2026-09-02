/**
 * The `/admin/api/studio/comments` route pair.
 *
 *   GET  /admin/api/studio/comments?dir=<abs>
 *       The whole `CommentsFile` for a project. Cheap — one file read, no
 *       parse of the user's source.
 *
 *   POST /admin/api/studio/comments   body: { dir?, op: CommentOp }
 *       Apply ONE operation. See `commentsStore.ts`'s module doc for why this
 *       is op-shaped where the sibling `/boards` route is whole-file.
 *
 * WHY THIS IS NOT IN `STUDIO_SUB_ROUTERS`
 * ───────────────────────────────────────
 * Every other studio sub-router takes `(req, url, pathname)`. These two routes
 * need a fourth thing none of the others do — the `DbClient`, to resolve the
 * session cookie into the user whose name goes on the comment. `tryServeStudio`
 * already receives the runtime and simply never used it, so it calls this
 * module directly rather than through the uniform loop. Widening all eighteen
 * sub-router signatures to carry a dependency one of them needs would be churn
 * in eighteen files that parallel work is editing.
 *
 * AUTH: unlike the rest of `/admin/api/studio/*`, both routes REQUIRE a
 * session. Not caution for its own sake — a comment carries a byline, and an
 * unauthenticated write has no honest one to carry. Any authenticated role
 * may read and write, the **Client** role (`site.content.edit` only) very
 * much included: that role is the reviewer this feature exists for, and
 * gating comments above it would defeat the point.
 */
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireAuthenticatedUser } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { Type } from '@core/utils/typeboxHelpers'
import { resolveProjectDir } from '../studioProjects'
import {
  CommentOpSchema,
  applyCommentOp,
  authorFromSession,
  readCommentsFile,
  writeCommentsFile,
} from './commentsStore'

const CommentsPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  op: CommentOpSchema,
})

export async function tryServeStudioComments(
  req: Request,
  runtime: { db: DbClient },
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/comments') return null

  if (req.method === 'GET') {
    const user = await requireAuthenticatedUser(req, runtime.db)
    if (user instanceof Response) return user
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      return jsonResponse({ dir, comments: readCommentsFile(dir) })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'POST') {
    const user = await requireAuthenticatedUser(req, runtime.db)
    if (user instanceof Response) return user
    try {
      const body = await readValidatedBody(req, CommentsPostBodySchema)
      if (!body) return badRequest('invalid comments body')
      const dir = resolveProjectDir(body.dir)

      // Read-apply-write, so two writers merge instead of the second one
      // silently discarding the first's comment.
      const file = readCommentsFile(dir)
      const result = applyCommentOp(
        file,
        body.op,
        // `kind: 'user'` is not a parameter here and must not become one: an
        // agent byline is only ever stamped by the MCP tool path, which never
        // reaches this HTTP route.
        authorFromSession(user),
        new Date().toISOString(),
      )
      if (!result.ok) return jsonResponse({ error: result.error }, { status: result.status })

      // A no-op op is a success that writes nothing — see `applyCommentOp`.
      if (result.changed) writeCommentsFile(dir, result.file)
      return jsonResponse({ ok: true, changed: result.changed, comments: result.file })
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
