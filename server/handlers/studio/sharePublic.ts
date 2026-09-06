/**
 * The public face of a share link. Three GETs, no auth, no cookies, no
 * database — the token in the URL is the entire credential.
 *
 *   GET /share/<token>
 *     The viewer page. A third Vite HTML entry (`share.html`) that mounts
 *     nothing but the snapshot: no admin shell, no router, no editor store,
 *     no canvas, no module registry. As with the capture entry, "contains no
 *     editor code" is structural rather than a promise a lazy route would
 *     have to keep. Built: served verbatim. Dev: a redirect to Vite's copy.
 *
 *   GET /share/<token>/board.json
 *     The snapshot manifest — the file on disk, byte for byte. `no-store`,
 *     because it is the request that re-checks revocation on every visit.
 *
 *   GET /share/<token>/frames/<file>.png
 *     One frame image. Immutable for a year: filenames embed a per-snapshot
 *     id, so re-capturing a share produces names no cache has seen.
 *
 * ## One 404, every time
 *
 * Unknown token, malformed token, revoked share, deleted project, missing
 * file, wrong method — all of them produce the same bare 404 page. That is
 * deliberate: distinguishing "revoked" from "never existed" tells a stranger
 * whether a token was ever real, and there is no legitimate visitor who
 * benefits from knowing which of the two happened. The page a HUMAN gets is
 * friendly about it ("this link is no longer available") without being
 * specific, because the common case is a genuine reviewer holding a revoked
 * link, not an attacker.
 *
 * ## Containment
 *
 * The token and the filename are both matched against a fixed shape
 * (`isShareTokenShape` / `isShareImageFileName`) BEFORE either becomes a path
 * segment, and the resolved path is then real-path containment-checked
 * against the share's own directory (`resolveShareFile`). Nothing under
 * `.studio/` other than that one directory is reachable from this route, and
 * `dir` never appears in a URL at all — it is derived from the token.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isShareImageFileName, isShareTokenShape, SHARE_ROUTE_PREFIX } from '@core/studio-share'
import { resolveActiveShare, resolveShareFile } from './shareStore'

const VITE_DEV_URL = 'http://localhost:5173'
const VITE_SHARE_ENTRY = '/share.html'

/** Snapshot manifests must never be cached: they are the revocation check. */
const NO_STORE = { 'cache-control': 'no-store' } as const

/**
 * Frame bytes, on the other hand, are safely immutable — a re-capture writes
 * new filenames (see `shareSnapshot.ts`), so the same URL can never mean two
 * different images. `private` rather than `public`: a shared cache in front
 * of this server has no business holding somebody's unpublished designs.
 */
const IMMUTABLE_IMAGE = {
  'content-type': 'image/png',
  'cache-control': 'private, max-age=31536000, immutable',
} as const

/**
 * The one failure response. HTML rather than JSON because the overwhelmingly
 * likely reader is a person who clicked a link, and a raw `Not found` is a
 * worse answer to "why doesn't this work" than a sentence is.
 */
function shareNotFound(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link unavailable</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0; opacity: 0.7; }
</style>
</head>
<body>
<main>
<h1>This link is no longer available</h1>
<p>The share may have been revoked, or the address may be incomplete. Ask whoever sent it for a new link.</p>
</main>
</body>
</html>`
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
  })
}

interface SharePathParts {
  token: string
  /** `''` for the viewer page, `'board.json'`, or `'frames/<file>'`. */
  rest: string
}

/** Split `/share/<token>[/<rest>]`. `null` when the path is not shaped like a share URL at all. */
function parseSharePath(pathname: string): SharePathParts | null {
  if (!pathname.startsWith(SHARE_ROUTE_PREFIX)) return null
  const tail = pathname.slice(SHARE_ROUTE_PREFIX.length)
  const slash = tail.indexOf('/')
  const token = slash === -1 ? tail : tail.slice(0, slash)
  const rest = slash === -1 ? '' : tail.slice(slash + 1)
  if (!isShareTokenShape(token)) return null
  return { token, rest }
}

/**
 * Owns the whole `/share/` namespace: an unknown sub-path or an unsupported
 * method 404s here rather than falling through to a later route, so a crafted
 * share URL can never end up rendering a published CMS page.
 */
export async function tryServeSharePublic(
  req: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== '/share' && !pathname.startsWith(SHARE_ROUTE_PREFIX)) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return shareNotFound()

  const parts = parseSharePath(pathname)
  if (!parts) return shareNotFound()

  // The live check. Everything below this line has already been proved to
  // belong to an un-revoked share of a project that still exists.
  const share = resolveActiveShare(parts.token)
  if (!share) return shareNotFound()

  if (parts.rest === '') return serveShareEntry(parts.token)

  if (parts.rest === 'board.json') {
    const path = resolveShareFile(share.dir, parts.token, 'board.json')
    if (!path || !existsSync(path)) return shareNotFound()
    return new Response(await Bun.file(path).arrayBuffer(), {
      headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
    })
  }

  if (parts.rest.startsWith('frames/')) {
    const file = parts.rest.slice('frames/'.length)
    if (!isShareImageFileName(file)) return shareNotFound()
    const path = resolveShareFile(share.dir, parts.token, file)
    if (!path || !existsSync(path)) return shareNotFound()
    // Read into a buffer rather than handing the `BunFile` straight to
    // `Response`: a frame is a bounded PNG, and an explicit body keeps this
    // handler testable outside a live `Bun.serve` (the suite runs under the
    // happy-dom preload, where a `BunFile` body does not survive).
    return new Response(await Bun.file(path).arrayBuffer(), { headers: IMMUTABLE_IMAGE })
  }

  return shareNotFound()
}

/**
 * The viewer HTML. Mirrors `captureRoute.ts`'s two modes for the same reason:
 * built, this server owns the route and serves the second/third Vite entry
 * directly; in `bun run dev`, Vite's SPA fallback would answer `/share/<token>`
 * with the ADMIN entry, so the browser is redirected to Vite's own copy of
 * `share.html`. Either way the page's subsequent `/share/<token>/…` fetches
 * come back to this handler.
 *
 * The dev redirect carries the token as a QUERY parameter, because Vite's
 * entry is at `/share.html` and the token is no longer in the path there.
 * The viewer reads whichever of the two forms it was given.
 */
async function serveShareEntry(token: string): Promise<Response> {
  const staticDir = resolve(process.env.STATIC_DIR ?? './dist')
  const built = join(staticDir, 'share.html')
  if (existsSync(built)) {
    const html = await Bun.file(built).text()
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // A share link is unlisted, not public. Keeping it out of search
        // indexes is the difference between "anyone with the link" and
        // "anyone", and a designer sharing a work-in-progress means the
        // former.
        'x-robots-tag': 'noindex, nofollow',
        ...NO_STORE,
      },
    })
  }
  return Response.redirect(`${VITE_DEV_URL}${VITE_SHARE_ENTRY}?token=${encodeURIComponent(token)}`, 302)
}
