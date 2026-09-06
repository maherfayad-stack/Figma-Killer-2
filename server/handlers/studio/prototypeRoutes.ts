/**
 * The `/admin/api/studio/prototype` routes.
 *
 *   GET  /admin/api/studio/prototype?dir=<abs>
 *       The whole `PrototypeFile` for a project. One file read, no parse of
 *       the user's source.
 *
 *   POST /admin/api/studio/prototype   body: { dir?, op: PrototypeOp }
 *       Apply ONE operation. See `prototypeStore.ts` for why this is op-shaped
 *       where the sibling `/boards` route is whole-file.
 *
 *   GET  /admin/api/studio/prototype/flow?dir=<abs>
 *       The DERIVED flow map — navigation Studio read out of the user's own
 *       source (`prototypeCodeFlow.ts`). Read-only by construction: there is no
 *       POST counterpart, because the only way to change one of these edges is
 *       to change the code it was read from.
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
import { readCodeFlow } from './prototypeCodeFlow'

const ROUTE_PATH = '/admin/api/studio/prototype'
const FLOW_ROUTE_PATH = '/admin/api/studio/prototype/flow'

const PrototypePostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  op: PrototypeOpSchema,
})

export async function tryServeStudioPrototype(
  req: Request,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname === FLOW_ROUTE_PATH) {
    if (req.method !== 'GET') return null
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      return jsonResponse({ dir, flow: readCodeFlow(dir) })
    } catch (err) {
      console.error('[studio:prototype]', err)
      return new Response('Not found', { status: 404 })
    }
  }

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
