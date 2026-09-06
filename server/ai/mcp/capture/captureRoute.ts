/**
 * The three HTTP surfaces of headless agent capture. All of them authenticate
 * with a capture grant (`captureToken.ts`) and NEVER with the admin session
 * cookie — see that module for why.
 *
 *   GET /admin/agent-capture?token=…
 *     The page itself. Serves the built `agent-capture.html` — a second Vite
 *     entry that mounts ONLY the snapshot frames: no admin shell, no router,
 *     no board, no panels, no persistence, no autosave. When there is no build
 *     on disk (a `bun run dev` session) it redirects to Vite's own copy of
 *     that entry, so the same URL works in both modes.
 *
 *   GET /admin/api/agent-capture/payload?token=…
 *     Studio's parse output for exactly the pages in the grant.
 *
 *   GET /admin/api/agent-capture/asset?token=…&path=…
 *     One local image the parsed pages reference. `dir` comes from the grant,
 *     never the query, so this cannot be pointed at another project.
 *
 * The token is deliberately checked BEFORE the HTML is served, not only before
 * the data: an unauthenticated visitor to this route should get a 404, not an
 * empty capture shell that leaks the route's existence and shape.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  AGENT_CAPTURE_ASSET_PATH,
  AGENT_CAPTURE_PAYLOAD_PATH,
  AGENT_CAPTURE_ROUTE,
} from '@core/studio-capture'
import { jsonResponse } from '../../../http'
import { resolveStudioAssetResponse } from '../../../handlers/studioAsset'
import { buildCapturePayload } from './capturePayload'
import { resolveCaptureToken } from './captureToken'

const VITE_DEV_URL = 'http://localhost:5173'
const VITE_CAPTURE_ENTRY = '/agent-capture.html'

/**
 * A wrong/expired token gets a bare 404 with no detail. There is no
 * human-facing flow here to help — the only legitimate caller is a browser
 * this server launched seconds ago with a token it just minted, so any other
 * request is either a probe or a bug, and neither benefits from a description
 * of what was wrong with the credential.
 */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Capture responses are never cached: a grant is single-use and its payload reflects disk at this instant. */
const NO_STORE = { 'cache-control': 'no-store' } as const

export async function tryServeAgentCapture(
  req: Request,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== AGENT_CAPTURE_ROUTE && pathname !== AGENT_CAPTURE_PAYLOAD_PATH && pathname !== AGENT_CAPTURE_ASSET_PATH) {
    return null
  }
  // The whole namespace is GET-only — absorbed here rather than falling
  // through, so an unknown method under a known capture path cannot reach a
  // later route.
  if (req.method !== 'GET') return notFound()

  const grant = resolveCaptureToken(url.searchParams.get('token'))
  if (!grant) return notFound()

  if (pathname === AGENT_CAPTURE_ROUTE) return serveCaptureEntry(url)

  if (pathname === AGENT_CAPTURE_PAYLOAD_PATH) {
    try {
      const result = await buildCapturePayload(grant, url.searchParams.get('token') ?? '')
      if (!result.ok) {
        return jsonResponse({ error: result.error }, { status: 404, headers: NO_STORE })
      }
      return jsonResponse(result.payload, { headers: NO_STORE })
    } catch (err) {
      console.error('[agent-capture]', err)
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: NO_STORE },
      )
    }
  }

  // Asset. `grant.dir` is the authority — the query only names a path WITHIN
  // it, and `resolveStudioAssetResponse` applies the same containment check
  // the session-gated studio asset route applies.
  const rawPath = url.searchParams.get('path')
  if (!rawPath) return notFound()
  try {
    const response = await resolveStudioAssetResponse(grant.dir, rawPath, req)
    return response ?? notFound()
  } catch (err) {
    console.error('[agent-capture]', err)
    return notFound()
  }
}

/**
 * The capture page's HTML. Built: the second Vite entry, served verbatim (its
 * asset URLs are absolute `/assets/…`, which this server already serves). Dev:
 * a redirect to Vite's copy of the same entry — the page's subsequent
 * `/admin/api/agent-capture/*` calls are proxied straight back here, so the
 * grant still resolves against this process.
 */
async function serveCaptureEntry(url: URL): Promise<Response> {
  const staticDir = resolve(process.env.STATIC_DIR ?? './dist')
  const built = join(staticDir, 'agent-capture.html')
  if (existsSync(built)) {
    const html = await Bun.file(built).text()
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
    })
  }
  return Response.redirect(`${VITE_DEV_URL}${VITE_CAPTURE_ENTRY}${url.search}`, 302)
}
