/**
 * projectThumbnailRoute — `GET /admin/api/studio/thumbnail?dir=<abs>`, the
 * launcher tile's image source.
 *
 * ## Why an `<img src>` and not `apiBlobRequest`
 *
 * This is a same-origin GET behind the admin session cookie, exactly like
 * `GET /admin/api/studio/asset` — the endpoint every parsed page's local
 * `<img>` already resolves to. The browser sends the cookie, and more
 * importantly it applies its OWN HTTP cache: a launcher with twenty tiles
 * revalidates twenty images in twenty 304s and re-decodes none of them.
 * `apiBlobRequest` would hand back a `Blob` this code would then have to turn
 * into an object URL, revoke on unmount, and re-download on every render —
 * paying to reimplement, badly, the cache the browser already has. The blob
 * entry exists for binary reads whose bytes are DATA (`/download`'s zip, a
 * font file being parsed); an image that is only ever painted is not one.
 *
 * ## Caching
 *
 * `ETag` and `Last-Modified` are both derived from the file's mtime and size,
 * and the response asks the browser to revalidate every time
 * (`max-age=0, must-revalidate`) rather than trusting a TTL. A thumbnail's
 * whole job is to be current — a stale one is a picture of a screen the user
 * has already changed — and revalidation costs a 304 with no body. The card
 * additionally varies the URL by `thumbnailUpdatedAt`, so a listing that
 * already knows the image moved does not even spend the round trip.
 *
 * `private` because the image is a picture of the user's own unpublished work
 * and must not land in a shared proxy cache.
 */
import { readFileSync } from 'node:fs'
import { badRequest, jsonResponse } from '../../http'
import { projectsRootDir } from '../studioProjects'
import { resolveWorkspaceProjectDir } from './projectDirGuard'
import { projectThumbnailFile, readProjectThumbnailStat } from './projectThumbnailFile'

const CACHE_CONTROL = 'private, max-age=0, must-revalidate'

/** Weak-free ETag over the two facts that change when the image does. */
function thumbnailEtag(mtimeMs: number, size: number): string {
  return `"${Math.floor(mtimeMs).toString(36)}-${size.toString(36)}"`
}

/**
 * Whether the client already holds this exact image. `If-None-Match` is
 * checked first and wins outright: it is exact, where `If-Modified-Since` is
 * truncated to whole seconds by the HTTP date format and would call a
 * same-second rewrite unchanged.
 */
function isFresh(req: Request, etag: string, lastModified: Date): boolean {
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch) {
    return ifNoneMatch
      .split(',')
      .some((candidate) => candidate.trim().replace(/^W\//, '') === etag)
  }
  const ifModifiedSince = req.headers.get('if-modified-since')
  if (!ifModifiedSince) return false
  const since = Date.parse(ifModifiedSince)
  // `lastModified` is floored to the second for the header, so compare against
  // the same floored value — otherwise a file written at .400ms always looks
  // newer than the second-granularity date the client just echoed back.
  return Number.isFinite(since) && Math.floor(lastModified.getTime() / 1000) * 1000 <= since
}

/**
 * Serves one project's `.studio/thumbnail.png`.
 *
 * `requestedDir` is caller-supplied and goes through the same containment rule
 * `/delete` and `/duplicate` use (`./projectDirGuard.ts`) BEFORE any path is
 * joined: without it, `?dir=/etc` would be an arbitrary-path read of a fixed
 * filename. `not-a-project` is a 400 and `not-found` a 404, matching those two
 * routes — a caller naming a path that was never a project has a different bug
 * from one naming a project that has since been deleted.
 *
 * A project with no thumbnail YET is a 404 with `no-store`, not a cached
 * empty: the queue is very likely producing one right now, and a browser that
 * cached the miss would keep showing the folder glyph after it lands.
 */
export function serveProjectThumbnail(req: Request, requestedDir: string | null): Response {
  const requested = requestedDir?.trim()
  if (!requested) return badRequest('thumbnail requires an explicit project dir')

  const resolved = resolveWorkspaceProjectDir(projectsRootDir(), requested, 'previewed')
  if (!resolved.ok) {
    return jsonResponse(
      { error: resolved.message },
      { status: resolved.reason === 'not-found' ? 404 : 400, headers: { 'cache-control': 'no-store' } },
    )
  }

  const stat = readProjectThumbnailStat(resolved.dir)
  if (!stat) {
    return jsonResponse(
      { error: 'This project has no preview yet.' },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    )
  }

  const etag = thumbnailEtag(stat.mtimeMs, stat.size)
  const lastModified = new Date(stat.mtimeMs)
  const validators = {
    etag,
    'last-modified': lastModified.toUTCString(),
    'cache-control': CACHE_CONTROL,
  }
  if (isFresh(req, etag, lastModified)) {
    return new Response(null, { status: 304, headers: validators })
  }

  try {
    const bytes = readFileSync(projectThumbnailFile(resolved.dir))
    return new Response(bytes, {
      headers: { ...validators, 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    })
  } catch (err) {
    // Raced with a rewrite or a project delete between the stat and the read.
    console.error('[studio:thumbnail]', err)
    return jsonResponse(
      { error: 'This project has no preview yet.' },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    )
  }
}
