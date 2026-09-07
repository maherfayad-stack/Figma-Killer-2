/**
 * nodeExportRoutes — the inspector's Export section, server side (W8-4).
 *
 *   POST /admin/api/studio/node-png   { dir?, pageId, nodeId, scale }
 *       -> `image/png` — the selected node, cut out of a capture of its page
 *          at the requested density. Body validated against
 *          `NodePngBodySchema`; the capture + crop live in
 *          `nodeExportCapture.ts`.
 *
 *   POST /admin/api/studio/node-jsx   { dir?, nodeId }
 *       -> `{ jsx, rel }` — the node's own JSX, read verbatim out of the file
 *          it was parsed from (`nodeJsxSource.ts`).
 *
 * ## Why both need a session, unlike most studio routes
 *
 * Same exception `commentsRoutes.ts` and `shareRoutes.ts` take, for the same
 * reason: the PNG path drives a capture, and a capture runs ON BEHALF OF a
 * user — the grant it mints records one (`captureToken.ts`), and the live-tab
 * fallback relays to that user's own editor workspace. There is no honest
 * anonymous answer to "photograph this for whom". `node-jsx` reads project
 * source; it takes the same gate rather than being the one studio route that
 * hands a repository's contents to an unauthenticated caller.
 *
 * The SVG half of the Export section is deliberately not here. Whether a node
 * has an honest vector form is a fact about the parse the browser is already
 * holding, not a rendering question — see `nodeExportModel.ts`'s doc for why
 * that decision is made client-side, and why "wrap the PNG in an `<svg>`" is
 * refused rather than shipped.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireAuthenticatedUser } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { exportNodePng } from './nodeExportCapture'
import { readNodeJsx } from './nodeJsxSource'

const NODE_PNG_PATH = '/admin/api/studio/node-png'
const NODE_JSX_PATH = '/admin/api/studio/node-jsx'

/**
 * `scale` is an enum, not a bounded number: the section offers @1×/@2×/@3×
 * and nothing else, so an arbitrary density is a malformed request rather
 * than a value to clamp. (The capture pipeline applies its OWN resolution cap
 * on top — see `nodeExportCapture.ts`.)
 *
 * Exported alongside its sibling below because the body shape IS this route's
 * contract — the same reason `previewAxes.ts` publishes its own — and its
 * gate asserts against it directly rather than re-declaring the field list.
 */
export const NodePngBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  pageId: Type.String({ minLength: 1 }),
  nodeId: Type.String({ minLength: 1 }),
  scale: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
})

export const NodeJsxBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  nodeId: Type.String({ minLength: 1 }),
})

/** The project directory for this request, or `null` when it names one outside `studio-workspace/`. */
function resolveContainedDir(dir: string | undefined): string | null {
  const resolved = resolveProjectDir(dir)
  return isRealpathContained(resolved, projectsRootDir()) ? resolved : null
}

/** `POST /admin/api/studio/node-png` and `POST /admin/api/studio/node-jsx` — see module doc. */
export async function tryServeStudioNodeExport(
  req: Request,
  runtime: { db: DbClient },
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== NODE_PNG_PATH && pathname !== NODE_JSX_PATH) return null
  if (req.method !== 'POST') return null

  const user = await requireAuthenticatedUser(req, runtime.db)
  if (user instanceof Response) return user

  try {
    if (pathname === NODE_PNG_PATH) {
      const body = await readValidatedBody(req, NodePngBodySchema)
      if (!body) return badRequest('invalid node-png body')
      const dir = resolveContainedDir(body.dir)
      if (!dir) return new Response('Not found', { status: 404 })

      const result = await exportNodePng({
        userId: user.id,
        dir,
        pageId: body.pageId,
        nodeId: body.nodeId,
        scale: body.scale,
      })
      // 422, not 500: every failure here is a real, explainable state of the
      // board (the element is hidden, it scrolled out of the capture, no
      // browser could be launched), not a server fault.
      if (!result.ok) return jsonResponse({ error: result.error }, { status: 422 })

      return new Response(new Uint8Array(result.png), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': String(result.png.byteLength),
        },
      })
    }

    const body = await readValidatedBody(req, NodeJsxBodySchema)
    if (!body) return badRequest('invalid node-jsx body')
    const dir = resolveContainedDir(body.dir)
    if (!dir) return new Response('Not found', { status: 404 })

    const result = readNodeJsx(dir, body.nodeId)
    if (!result.ok) return jsonResponse({ error: result.error }, { status: 422 })
    return jsonResponse({ jsx: result.jsx, rel: result.rel })
  } catch (err) {
    console.error('[studio:nodeExport]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
