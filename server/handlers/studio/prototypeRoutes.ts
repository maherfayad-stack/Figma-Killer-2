/**
 * The `/admin/api/studio/prototype` route pair.
 *
 *   GET  /admin/api/studio/prototype?dir=<abs>
 *       The whole `PrototypeFile` for a project. One file read, no parse of
 *       the user's source.
 *
 *   POST /admin/api/studio/prototype   body: { dir?, op: PrototypeOp }
 *       Apply ONE operation. See `prototypeStore.ts` for why this is op-shaped
 *       where the sibling `/boards` route is whole-file.
 *
 * Unlike `/comments`, these routes need no `DbClient` and carry no byline — a
 * link has no author — so this is an ordinary `STUDIO_SUB_ROUTERS` entry with
 * the uniform `(req, url, pathname)` signature.
 */
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { PrototypeOpSchema, applyPrototypeOp, readPrototypeFile, writePrototypeFile } from './prototypeStore'

const ROUTE_PATH = '/admin/api/studio/prototype'

const PrototypePostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  op: PrototypeOpSchema,
})

export async function tryServeStudioPrototype(
  req: Request,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      return jsonResponse({ dir, prototype: readPrototypeFile(dir) })
    } catch (err) {
      console.error('[studio:prototype]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, PrototypePostBodySchema)
      if (!body) return badRequest('invalid prototype body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      // Read-apply-write, so a concurrent writer merges instead of being
      // silently discarded.
      const result = applyPrototypeOp(readPrototypeFile(dir), body.op)
      if (!result.ok) return jsonResponse({ error: result.error }, { status: result.status })

      if (result.changed) writePrototypeFile(dir, result.file)
      return jsonResponse({ ok: true, changed: result.changed, prototype: result.file })
    } catch (err) {
      console.error('[studio:prototype]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
