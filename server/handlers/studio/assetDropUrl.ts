/**
 * assetDropUrl — `POST /admin/api/studio/asset-drop-url` (P5-B3, IMG-5, owner
 * decision OD-13): an image dragged out of another browser tab and dropped on
 * a frame. The SERVER fetches the URL and lands the bytes exactly where a
 * dropped file lands (`resolveDroppedAssetHome` + `landDroppedBytes`,
 * `assetDrop.ts`), so the two gestures answer with one body.
 *
 * ## Why the server fetches
 *
 * The browser cannot: a cross-origin image is opaque to script, and the admin
 * app has no business making requests on page content's behalf. The server's
 * fetch is the existing `studio_fetch_remote_asset` transport
 * (`fetchRemoteBytes`, `remoteAssetFetch.ts`) — this route is a second CALLER
 * of it, never a second fetcher.
 *
 * ## The attack surface, and what closes each part (security review)
 *
 * This turns an MCP-only outbound fetch into a one-gesture browser action, so
 * every protection is spelled out:
 *
 *   1. **Who.** Declared in `routeCapabilities.ts` as a WRITE
 *      (`studio.write`): `gateStudioRequest` has refused a caller without the
 *      capability and a cross-origin POST (the CSRF `Origin` check) before
 *      this sub-router runs. A page on the internet cannot make the server
 *      fetch anything through this route.
 *   2. **Where it may connect (SSRF).** `fetchRemoteBytes`: `http:`/`https:`
 *      only; EVERY resolved address checked against the shared
 *      loopback/private/link-local/CGNAT/unique-local/metadata blocklist
 *      (`server/util/ssrfGuard.ts`), the connection PINNED to the validated
 *      address (no rebinding window), `redirect: 'error'`. **Loopback is
 *      refused unconditionally here** — `allowLoopback: false`, never the
 *      operator's `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH`, which exists for an
 *      agent reaching a local Figma Dev Mode server and has no meaning for a
 *      tab the user dragged from. So this route can never reach Studio's own
 *      API, the project's dev server, or cloud metadata.
 *   3. **How much.** The body is capped by STREAMED byte count at the drop's
 *      own 25 MB (`MAX_ASSET_DROP_BYTES`); the whole exchange has a deadline.
 *   4. **What.** A `content-type` outside the image set is refused before the
 *      body is read, and the bytes must sniff as the image they claimed to
 *      be (`fetchRemoteBytes`, protection 7); `landDroppedBytes` then
 *      re-sniffs and sanitises an SVG before it touches disk.
 *   5. **Where it lands.** Server-derived only (`public/`, or the page's own
 *      image folder — `resolveDroppedAssetHome`); the request carries no
 *      directory. `pageRel` is READ for its convention, contained first.
 *   6. **What it says.** Errors name the failure KIND; a resolved address is
 *      never echoed (`fetchRemoteBytes`'s own rule).
 *   7. **Request size.** The JSON body itself is capped
 *      ({@link MAX_ASSET_DROP_URL_BODY_BYTES}) and the URL length bounded, so
 *      the route cannot be made to buffer a large request either.
 *
 * `data:` never reaches here: the browser decodes a `data:image/…` drop into
 * a `File` and posts it to plain `asset-drop` (`canvasDropIntake.ts`).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { RequestBodyTooLargeError, badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { MAX_ASSET_DROP_BYTES, landDroppedBytes, resolveDroppedAssetHome } from './assetDrop'
import { fetchRemoteBytes, type FetchRemoteAssetDeps } from './remoteAssetFetch'

const ROUTE_PATH = '/admin/api/studio/asset-drop-url'

/** A JSON body holding one URL and two paths has no reason to be larger. */
export const MAX_ASSET_DROP_URL_BODY_BYTES = 16 * 1024

const AssetDropUrlBodySchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 4096 }),
  dir: Type.Optional(Type.String()),
  pageRel: Type.Optional(Type.String({ maxLength: 1024 })),
})

export interface AssetDropUrlDeps {
  /** Test-only, mirroring `AssetDropDeps.resolveDir`. */
  resolveDir?: (requested: string | null | undefined) => string
  /**
   * Test seams for the fetch: DNS and the transport. `allowLoopback` and
   * `maxBytes` are deliberately NOT injectable — this route's answer to both
   * is fixed (see the module doc, points 2 and 3).
   */
  fetch?: Pick<FetchRemoteAssetDeps, 'fetchImpl' | 'resolveHostAddresses' | 'timeoutMs'>
}

// A `STUDIO_SUB_ROUTERS` member. The capability and CSRF checks ran in
// `gateStudioRequest` before this was called.
export async function tryServeStudioAssetDropUrl(
  req: Request,
  _url: URL,
  pathname: string,
  deps: AssetDropUrlDeps = {},
): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, AssetDropUrlBodySchema, { maxBytes: MAX_ASSET_DROP_URL_BODY_BYTES })
    if (!body) return badRequest('invalid asset-drop-url body')

    const dir = (deps.resolveDir ?? resolveProjectDir)(body.dir)
    // Where it WOULD land is decided before a byte is fetched: a project with
    // no home for the image costs nothing but a sentence.
    const home = resolveDroppedAssetHome(dir, body.pageRel)
    if (!home.ok) return jsonResponse({ error: home.error }, { status: 409 })

    const fetched = await fetchRemoteBytes(body.url, {
      ...deps.fetch,
      allowLoopback: false,
      maxBytes: MAX_ASSET_DROP_BYTES,
    })
    if (!fetched.ok) return jsonResponse({ error: fetched.error }, { status: 422 })

    return landDroppedBytes(dir, home, fetched.bytes, fetched.filenameHint)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    if (err instanceof RequestBodyTooLargeError) return jsonResponse({ error: 'The request is too large.' }, { status: 413 })
    console.error('[studio:asset-drop-url]', err)
    return jsonResponse({ error: 'The image could not be saved to the project.' }, { status: 500 })
  }
}
