import { tryHandleAi } from './ai/handlers'
import { handleMcpHttp, MCP_ENDPOINT_PATH } from './ai/mcp'
import { tryServeAgentCapture } from './ai/mcp/capture/captureRoute'
import { handleCmsRequest } from './handlers/cms'
import { tryServeStudio } from './handlers/studio'
import { ProjectDirOutsideWorkspaceError } from './handlers/studioProjects'
import { tryServeSharePublic } from './handlers/studio/sharePublic'
import { tryServeDesignImport } from './handlers/designImport'
import type { DbClient } from './db/client'
import { renderNotFoundResponse, renderPublicResolution } from './publish/publicRouter'
import { getSetupStatusCached } from './repositories/setup'
import { getPublishedRuntimeAsset } from './repositories/runtimeAsset'
import { handleLoopRequest, isLoopRuntimeAssetPath, serveLoopRuntimeAsset } from './handlers/cms/loop'
import { handleHoleRequest, isHoleRuntimeAssetPath, serveHoleRuntimeAsset } from './handlers/cms/hole'
import { handleModuleJsAssetRequest, isModuleJsAssetPath } from './handlers/cms/moduleJs'
import { handlePublicFormRequest } from './forms/handler'
import { isRuntimePackagePath, tryServeRuntimePackage } from './publish/runtime/packageServer'
import { jsonResponse } from './http'
import { binaryResponse } from './binary'
import { hardenUploadResponse, serveAdminApp, serveStaticFile } from './static'
import { readStaticAsset } from './publish/staticArtefact'
import { serveSiteCss } from './siteCss'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'

const VITE_DEV_URL = 'http://localhost:5173'

interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
  /**
   * The raw `DATABASE_URL` the server booted with — forwarded down to
   * CMS handlers that need to resolve the on-disk SQLite file (e.g. the
   * storage dashboard widget).
   */
  databaseUrl?: string
}

/**
 * A route handler returns a `Response` if it owns the request, or `null` if
 * the URL/method doesn't match — the dispatcher walks the `routes` table and
 * returns the first non-null response. Prefix-namespaced handlers (e.g.
 * `/_studio/css/`, `/_studio/runtime/cache/`) absorb their entire namespace and emit
 * a 404 themselves rather than falling through, so unknown paths under a
 * known prefix can't accidentally match a later route.
 */
type RouteHandler = (
  req: Request,
  runtime: ServerRuntime,
  url: URL,
  pathname: string,
) => Promise<Response | null> | Response | null

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * The ordered routing table. Routes are tried top-to-bottom; the first match
 * wins. Adding a new endpoint is a one-line edit here plus a focused
 * `tryServeX` function below — no per-call type juggling and no editing the
 * dispatcher loop.
 */
const routes: readonly RouteHandler[] = [
  tryServeHealth,
  // Studio source-writeback (filesystem ⇄ .tsx). Owns /studio/*.
  tryServeStudio,
  // Design-token import (colors/typography/spacing + CSS from a GitHub repo
  // or npm package) — owns /admin/api/design-import/*.
  tryServeDesignImport,
  // MCP server endpoint — external AI clients (Claude Code, Codex, remote
  // agents) speak the Model Context Protocol here over its own bearer-token
  // auth. Matched before the admin-cookie-gated AI routes since it lives under
  // `/_studio/` and authenticates per-connector, not via the admin session.
  tryServeMcp,
  // Headless agent capture — `/admin/agent-capture` + its two
  // `/admin/api/agent-capture/*` data endpoints. Matched BEFORE the
  // admin-cookie-gated AI/CMS routes and before `tryServeAdminApp` (which
  // would otherwise answer `/admin/agent-capture` with the ordinary admin
  // SPA), since this namespace authenticates with a single-purpose capture
  // grant rather than the admin session.
  tryServeAgentCaptureRoute,
  // AI runtime — `/admin/api/ai/*`. The legacy `/admin/api/agent` and
  // `/admin/api/agent/tool-result` were deleted in Phase 3 of the AI
  // runtime rewrite. The site editor now POSTs `/admin/api/ai/chat` — one
  // route, since Studio has exactly one agent (WS-12 §8.1 D3).
  tryServeAi,
  tryServeCmsApi,
  tryServeLoopRuntimeAsset,
  tryServeLoop,
  tryServeHoleRuntimeAsset,
  tryServeHole,
  tryServeModuleJsAsset,
  tryServePublicForm,
  // Share links (W5-2) — `/share/<token>` and its two data sub-paths. The
  // only genuinely PUBLIC Studio surface: no session, no cookie, no database,
  // authenticated by an unguessable token that is checked against
  // `.studio/shares.json` on every single request so a revocation is
  // immediate. Sits here, among the other unauthenticated `/_studio/*`
  // namespaces, rather than under `/admin` — a viewer must never be sent to
  // an admin URL — and BEFORE the static-asset and public-page routes, whose
  // fallbacks would otherwise answer a share URL with something else.
  tryServeSharePublicRoute,
  tryServeRuntimeAsset,
  tryServeRuntimePackageNamespace,
  tryServeSiteCssNamespace,
  tryServeMediaRedirect,
  tryServeStaticAsset,
  tryServeUpload,
  tryServeAdminApp,
  tryServePublicRoute,
  trySetupRedirect,
  tryServeNotFoundPage,
]

export async function handleServerRequest(
  req: Request,
  runtime: ServerRuntime,
): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  try {
    for (const route of routes) {
      const response = await route(req, runtime, url, pathname)
      if (response) return response
    }
  } catch (err) {
    // The one place a `dir` outside `studio-workspace/` is answered — see
    // `resolveProjectDir` and `rethrowProjectDirRefusal`. 404, because that is
    // what every dir-taking route already says for a project it will not
    // serve, and it tells a prober nothing. The path is logged, never echoed.
    if (err instanceof ProjectDirOutsideWorkspaceError) {
      console.error('[router] refused an out-of-workspace project dir:', err.path)
      return jsonResponse({ error: 'Not found' }, { status: 404 })
    }
    throw err
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

// ---------------------------------------------------------------------------
// Route handlers
//
// Each function checks its own method/path and returns `Response | null`.
// Order matters — see `routes` above.
// ---------------------------------------------------------------------------

function tryServeHealth(_req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Response | null {
  if (pathname !== '/health') return null
  return jsonResponse({ status: 'ok', ts: Date.now() })
}

/**
 * AI runtime — provider-agnostic stack at `/admin/api/ai/*`. Handles chat
 * streams, browser bridge, credentials CRUD, conversation history,
 * defaults, and model discovery. See `server/ai/handlers/index.ts` for the
 * full route table; the dispatcher there is the source of truth for
 * which paths are owned by this namespace.
 *
 * Endpoints live under `/admin/api/` so the admin session cookie — scoped
 * to `Path=/admin` to keep it off the public site — is carried to them.
 * Without that, the `requireCapability('ai.chat' / 'ai.tools.write' /
 * 'ai.providers.manage')` gate would 401 every request. Matched before
 * the broader `/admin/api/cms/` route so the AI paths don't get swallowed
 * by the CMS dispatcher.
 */
function tryServeAi(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response> | null {
  return tryHandleAi(req, runtime.db, url)
}

/**
 * Headless agent capture. Owns `/admin/agent-capture` and the
 * `/admin/api/agent-capture/*` namespace, and absorbs both entirely (an
 * unknown method or a bad token gets a 404 from the handler rather than
 * falling through to a later route). See `capture/captureRoute.ts`.
 */
function tryServeAgentCaptureRoute(
  req: Request,
  _runtime: ServerRuntime,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  return tryServeAgentCapture(req, url, pathname)
}

/**
 * MCP server endpoint (`/_studio/mcp`). Authenticates per-connector via a
 * bearer token (NOT the admin session cookie) and exposes the capability-gated
 * CMS tool surface over the Model Context Protocol. Returns `null` for any
 * other path so the dispatcher keeps walking.
 */
function tryServeMcp(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> | null {
  if (pathname !== MCP_ENDPOINT_PATH) return null
  return handleMcpHttp(req, runtime.db, { uploadsDir: runtime.uploadsDir })
}

function tryServeCmsApi(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response> | null {
  if (!pathname.startsWith('/admin/api/cms/')) return null
  return handleCmsRequest(req, runtime.db, {
    uploadsDir: runtime.uploadsDir,
    databaseUrl: runtime.databaseUrl,
  })
}

/**
 * The loop runtime is a fixed CMS asset, served before the per-site
 * runtime asset lookup so the request never falls through.
 */
function tryServeLoopRuntimeAsset(req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Response | null {
  if (req.method !== 'GET' || !isLoopRuntimeAssetPath(pathname)) return null
  return serveLoopRuntimeAsset()
}

function tryServeLoop(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response> | null {
  if (!pathname.startsWith('/_studio/loop/')) return null
  return handleLoopRequest(req, url, { db: runtime.db })
}

/**
 * The hole runtime is a fixed CMS asset served at `/_studio/hole-runtime.js`.
 * Registered before `tryServeHole` so the exact path is consumed here and
 * never falls through to the hole fragment handler.
 */
function tryServeHoleRuntimeAsset(req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Response | null {
  if (req.method !== 'GET' || !isHoleRuntimeAssetPath(pathname)) return null
  return serveHoleRuntimeAsset()
}

/**
 * Layer C hole fragment endpoint — `/_studio/hole/<nodeId>`.
 * Renders a dynamic node subtree on-demand and caches the result via Layer B.
 */
function tryServeHole(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response> | null {
  if (!pathname.startsWith('/_studio/hole/')) return null
  return handleHoleRequest(req, url, { db: runtime.db })
}

/**
 * Per-module published JS — `/_studio/module-js/<moduleId>.js`. Prefix-
 * namespaced: unknown paths under the prefix 404 inside the handler rather
 * than falling through to the public-slug resolver.
 */
function tryServeModuleJsAsset(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response> | null {
  if (!isModuleJsAssetPath(pathname)) return null
  return handleModuleJsAssetRequest(req, url, { db: runtime.db })
}

/**
 * Share links. Owns the whole `/share/` namespace and absorbs it — an unknown
 * sub-path, a revoked token, or an unsupported method gets the handler's own
 * 404 page rather than falling through to the published-site resolver. See
 * `handlers/studio/sharePublic.ts`.
 */
function tryServeSharePublicRoute(
  req: Request,
  _runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  return tryServeSharePublic(req, pathname)
}

function tryServePublicForm(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response | null> | null {
  if (!pathname.startsWith('/_studio/form/')) return null
  return handlePublicFormRequest(req, runtime.db, url)
}

async function tryServeRuntimeAsset(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' || !pathname.startsWith('/_studio/assets/')) return null

  // Disk-first: a full publish bakes the runtime JS into the active slot, so
  // published pages serve their scripts straight off disk (no DB round-trip,
  // no rebuild). Content-hashed filenames keep `immutable` caching correct.
  if (runtime.uploadsDir) {
    const bytes = await readStaticAsset(runtime.uploadsDir, pathname)
    if (bytes) {
      return binaryResponse(bytes, {
        headers: {
          'content-type': contentTypeForAssetPath(pathname),
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    }
  }

  // Fallback: assets stored in the DB (preview, or a publish whose disk write
  // failed). The live renderer keeps working off these.
  const runtimeAsset = await getPublishedRuntimeAsset(runtime.db, pathname)
  if (!runtimeAsset) return null
  return binaryResponse(runtimeAsset.bytes, {
    headers: {
      'content-type': runtimeAsset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

/** Derive a response content-type for a baked static asset from its extension. */
function contentTypeForAssetPath(pathname: string): string {
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8'
  if (pathname.endsWith('.map') || pathname.endsWith('.json')) return 'application/json; charset=utf-8'
  if (pathname.endsWith('.svg')) return 'image/svg+xml'
  if (pathname.endsWith('.png')) return 'image/png'
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.gif')) return 'image/gif'
  if (pathname.endsWith('.webp')) return 'image/webp'
  if (pathname.endsWith('.woff2')) return 'font/woff2'
  if (pathname.endsWith('.woff')) return 'font/woff'
  if (pathname.endsWith('.ttf')) return 'font/ttf'
  if (pathname.endsWith('.otf')) return 'font/otf'
  return 'application/octet-stream'
}

/**
 * Per-site runtime dependency cache — served from the hashed
 * `bun install` workspace under `/_studio/runtime/cache/<hash>/<...path>`.
 * The publisher emits a `<script type="importmap">` mapping bare
 * specifiers like `three` to URLs in this namespace, so plugin module
 * scripts and frontend bundles share a single locally-installed copy
 * of every site dependency.
 *
 * The /_studio/runtime/cache/ namespace is exclusive: unknown paths under it
 * 404 here rather than falling through to a later matcher.
 */
async function tryServeRuntimePackageNamespace(req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (!isRuntimePackagePath(pathname)) return null
  return (await tryServeRuntimePackage(req, pathname)) ?? new Response('not found', { status: 404 })
}

/**
 * Per-site CSS bundle — `reset-<hash>.css`, `framework-<hash>.css`,
 * `style-<hash>.css`. Filenames embed a content hash, so responses can
 * use `Cache-Control: immutable` for a year. Stale-hash requests 404 so
 * the browser falls back to refetching the HTML (which carries the new
 * hash).
 *
 * The /_studio/css/ namespace is exclusive: any unknown path under it is a
 * 404, never falls through to the public-slug handler. That prevents an
 * unrelated path like `/_studio/css/anything.css` from accidentally
 * rendering the homepage.
 */
async function tryServeSiteCssNamespace(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' || !pathname.startsWith('/_studio/css/')) return null
  return (await serveSiteCss(runtime.db, pathname, runtime.uploadsDir)) ?? new Response('Not found', { status: 404 })
}

/**
 * Resolve a media asset request that lives on a plugin-registered storage
 * adapter with `servingMode !== 'public-url'`.
 *
 * `dispatchUpload` synthesises a host-owned URL of the shape
 *   /_studio/media/<adapterId>/<storagePath>
 * for non-public-url writes, then stores that on `media_assets.public_path`
 * (or inside each variant's `path`). Browsers hit this route; we ask the
 * adapter for a freshly-signed read URL and 302-redirect.
 *
 * The route is exclusive: an unknown adapter id or missing `getReadUrl`
 * returns 404 here rather than falling through to the public-slug handler.
 * That keeps a misconfigured storage backend from being silently swallowed
 * by the published-page renderer.
 *
 * Variants get the same treatment automatically — the variant URLs in
 * `variants_json` carry this same shape, so the renderer's `<img srcset>`
 * emission Just Works without per-variant DB indexing.
 */
async function tryServeMediaRedirect(
  req: Request,
  _runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!pathname.startsWith('/_studio/media/')) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }
  const match = pathname.match(/^\/_studio\/media\/([^/]+)\/(.+)$/)
  if (!match) return new Response('Not found', { status: 404 })
  const adapterId = decodeURIComponent(match[1])
  const storagePath = decodeURIComponent(match[2])
  // Local-disk asset URLs never use this route (the dispatcher's
  // `buildSignedRedirectUrl` only fires for non-built-in adapters with
  // `servingMode !== 'public-url'`). A request that pretends to be one is
  // an attacker probe — 404 it.
  if (!adapterId) return new Response('Not found', { status: 404 })
  const adapter = mediaStorageRegistry.resolveForRead(adapterId)
  if (!adapter || !adapter.getReadUrl) {
    return new Response('Not found', { status: 404 })
  }
  let signed: { url: string; expiresAt: number }
  try {
    // 1 hour TTL — long enough that browser-side fetches and CDN warm-ups
    // succeed, short enough that a leaked signed URL becomes useless fast.
    signed = await adapter.getReadUrl(storagePath, 3600)
  } catch (err) {
    console.error(`[router] adapter "${adapterId}" getReadUrl failed:`, err)
    return new Response('Not found', { status: 404 })
  }
  // No cache header on the 302 itself — the redirect target is signed and
  // expires; we want every browser navigation to hit us for a fresh signature
  // rather than reuse a stale one.
  return new Response(null, {
    status: 302,
    headers: {
      'location': signed.url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

/**
 * Serve any file that the Vite build emits under `staticDir` (`dist/`):
 *
 *   - `/assets/<hashed>.{js,css,…}` — the bundler-emitted chunks.
 *   - `/favicon.svg`               — the site favicon copied from `public/`.
 *   - `/runtime/<shim>.js`         — plugin-runtime ESM shims that the
 *                                    admin's import map re-exports
 *                                    `react`, `react-dom`, `@studio/*`
 *                                    from. Without these, plugin bundles
 *                                    fail to fetch on a production install
 *                                    (the dev server hides this because
 *                                    Vite serves `public/` at the root).
 *
 * The handler is generic — `serveStaticFile` returns `null` when the
 * resolved file doesn't exist, so non-static paths fall through to the
 * downstream route handlers naturally. `/` and `/index.html` are
 * deliberately skipped so `serveAdminApp` keeps ownership of the admin
 * HTML pipeline (login skeleton + boot-API kickoff + authenticated preload).
 */
async function tryServeStaticAsset(
  _req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.staticDir) return null
  if (pathname === '/' || pathname === '/index.html') return null
  return await serveStaticFile(runtime.staticDir, pathname, _req)
}

async function tryServeUpload(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.uploadsDir || !pathname.startsWith('/uploads/')) return null
  const upload = await serveStaticFile(runtime.uploadsDir, pathname.slice('/uploads'.length), req)
  if (!upload) return null
  // Defense-in-depth: even though the upload handler now writes only
  // server-chosen extensions, the static handler still derives Content-Type
  // from the on-disk extension. `hardenUploadResponse` adds the `nosniff`
  // and (for non-inert MIMEs) `attachment` headers so a stray non-allowlisted
  // file in the uploads dir can never be top-level navigated and rendered as
  // HTML on the admin origin. See `INERT_UPLOAD_MIMES` in `static.ts`.
  const hardened = hardenUploadResponse(upload)
  // Plugin bundles live under `/uploads/plugins/<id>/<version>/...`. The
  // editor's preview iframe loads them with `sandbox="allow-scripts"` (no
  // `allow-same-origin`), which puts the iframe in an opaque origin —
  // module fetches across that boundary need CORS. Plugin assets are
  // distribution code (frontend bundles, plugin-shipped images), so
  // allow-all is correct here. Non-plugin uploads stay default-deny.
  if (pathname.startsWith('/uploads/plugins/')) {
    const headers = new Headers(hardened.headers)
    headers.set('access-control-allow-origin', '*')
    headers.set('cross-origin-resource-policy', 'cross-origin')
    return new Response(hardened.body, {
      status: hardened.status,
      statusText: hardened.statusText,
      headers,
    })
  }
  return hardened
}

async function tryServeAdminApp(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/')
  if (!isAdminPath) return null

  if (runtime.staticDir) {
    const adminApp = await serveAdminApp(runtime.staticDir, req)
    if (adminApp) return adminApp
  }
  // Admin SPA isn't served from this port (dev mode, or production missing a
  // build). Tell the developer where to actually find it.
  return adminUiNotBuiltResponse(pathname)
}

/**
 * Single entry for every visitor-facing HTML URL — stand-alone published
 * pages (`/about`), content rows rendered through their postType's entry
 * template (`/posts/hello-world`), and row-slug redirects.
 *
 * Resolution + render live in `server/publish/publicRouter.ts`.
 * `renderPublicResolution` handles the full request: Layer A disk
 * fast-path (pre-rendered static artefacts via `readArtefact`), then
 * `resolvePublicRoute`, then the live renderer + `applyPublishedHtmlPipeline`.
 */
async function tryServePublicRoute(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  return await renderPublicResolution(runtime.db, url, runtime.uploadsDir)
}

/**
 * On a fresh install with no admin user yet, bounce the visitor to /admin so
 * they land in the setup wizard instead of seeing a confusing 404. Returns
 * null when the install is already past setup.
 */
async function trySetupRedirect(req: Request, runtime: ServerRuntime, _url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  // Sticky memo: once setup completes, this stops querying. Without it every
  // unmatched GET (bot probes, 404s) paid two COUNT queries forever.
  const setupStatus = await getSetupStatusCached(runtime.db)
  return setupStatus.needsSetup
    ? new Response(null, { status: 302, headers: { location: '/admin' } })
    : null
}

/**
 * Last route before the dispatcher's bare JSON 404: serve the site's designed
 * 404 page (the `notFound` template) for any GET no other route claimed.
 * Namespaced prefixes (`/admin/api/*`, `/_studio/*`, `/uploads/*`) never
 * reach here — they absorb their namespace and emit their own 404s. Returns
 * null (→ JSON 404) when the published site has no notFound template.
 */
async function tryServeNotFoundPage(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  return await renderNotFoundResponse(runtime.db, url, runtime.uploadsDir)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminUiNotBuiltResponse(pathname: string): Response {
  const targetUrl = `${VITE_DEV_URL}${pathname}`
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin UI not served on this port</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 32px; background: #000; color: #ededed; line-height: 1.5; }
  a { color: #fff; }
  code { background: #111; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Admin UI not served on this port</h1>
<p>This is the CMS API server (port 3001). In development, the admin UI is served by the Vite dev server.</p>
<p>Open <a href="${targetUrl}">${targetUrl}</a>.</p>
<p>If Vite isn't running yet, start it with <code>bun run dev</code> from the project root.</p>
</body>
</html>`
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
