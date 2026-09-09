/**
 * The live origin — a second, independent `Bun.serve()` listener that proxies
 * `/p/<projectKey>/*` (HTTP + WebSocket) to a Tier 2 project's own dev server.
 *
 * This is a PEER of `server/index.ts` / `server/router.ts` /
 * `server/securityHeaders.ts`, not a sub-router of the admin API. It is a
 * distinct TCP socket, a distinct `Bun.serve` fetch handler, with its own
 * header policy — NOT a special-cased path inside `handleServerRequest`.
 *
 * Why a second listener and not a route on the admin one: a same-origin proxy
 * would run the user's own dependencies with the admin session cookie
 * attached to every fetch they make. Tier 2 is consent to *run* the project,
 * not consent to hand it the account. The browser never attaches
 * admin-origin cookies to a cross-origin request in the first place, so this
 * listener physically cannot read the admin cookie jar — that is the whole
 * point of it being a different `Bun.serve()` call on a different port,
 * rather than defense-in-depth layered on the router.
 *
 * `server/liveOrigin.ts` MUST NOT import `./router` (`handleServerRequest`)
 * or any admin cookie/session helper from `./auth/security` — enforced by
 * `src/__tests__/architecture/live-origin-isolation.test.ts`. It also must
 * never write a `Set-Cookie` header, and every response leaving here goes
 * through `stripSetCookie` first — this file keeps the promise "no cookies
 * cross this boundary" unconditionally, not as a hope about upstream
 * behaviour.
 *
 * Path/project-key resolution: `projectKey` is NOT re-derived here — it is
 * whatever segment the URL carries after `/p/`, looked up directly against
 * `getDevServerStatus` (`server/handlers/studio/devServer.ts`, L1 — stubbed
 * for now, see that file's doc comment). Trust-tier gating happens in L1's
 * `ensureDevServer`, not here: a project only ever reaches `phase: 'ready'`
 * in that registry if it was allowed to boot. This file trusts a `ready`
 * phase as sufficient authorization to proxy and does not re-read
 * `.studio/meta.json` — a second copy of that gate would drift.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { ServerConfig } from './config'
import { getDevServerStatus } from './handlers/studio/devServer'

const LIVE_PATH_PREFIX = '/p/'

export const LiveOriginErrorSchema = Type.Object({
  error: Type.String(),
  code: Type.Union([Type.Literal('unknown-project'), Type.Literal('not-ready')]),
  phase: Type.Optional(
    Type.Union([
      Type.Literal('stopped'),
      Type.Literal('booting'),
      Type.Literal('ready'),
      Type.Literal('failed'),
    ]),
  ),
})
export type LiveOriginError = Static<typeof LiveOriginErrorSchema>

function liveOriginErrorResponse(status: number, body: LiveOriginError, publicOrigins: readonly string[]): Response {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  return liveOriginSecurityHeaders(res, publicOrigins)
}

/**
 * Split `/p/<projectKey>/<rest>` into its two parts. Returns `null` for
 * anything that isn't shaped that way (the caller falls through to a normal
 * 404). `rest` keeps its own leading slash so it composes directly onto the
 * upstream origin.
 */
function parseLivePath(pathname: string): { projectKey: string; rest: string } | null {
  if (!pathname.startsWith(LIVE_PATH_PREFIX)) return null
  const withoutPrefix = pathname.slice(LIVE_PATH_PREFIX.length)
  const slashIndex = withoutPrefix.indexOf('/')
  const projectKey = slashIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, slashIndex)
  const rest = slashIndex === -1 ? '/' : withoutPrefix.slice(slashIndex)
  if (!projectKey) return null
  return { projectKey, rest }
}

/**
 * Build the upstream URL for a proxied request, with `baseUrl`'s authority
 * pinned no matter what `pathAndSearch` contains.
 *
 * `new URL(pathAndSearch, baseUrl)` looks like the obvious way to do this,
 * and it is a host-override vulnerability: the WHATWG URL parser treats a
 * relative reference beginning with `//` (or a backslash, which it normalizes
 * to `/`) as "network-path" — it REPLACES the base's authority instead of
 * resolving against it. A request to `/p/<projectKey>//evil.example/steal`
 * parses to `rest = '//evil.example/steal'`, and `new URL(rest, status.url)`
 * silently resolves to `http://evil.example/steal` — this listener would then
 * make a server-side fetch (SSRF) to an attacker-chosen host, or open an
 * attacker-chosen WebSocket, entirely outside the intended project's own dev
 * server. Verified empirically: `new URL('//evil.com/x', 'http://127.0.0.1:5173').host === 'evil.com'`.
 *
 * The fix is to never let path input reach the URL constructor's first
 * argument at all. Parse `baseUrl` alone (authority fixed, from the trusted
 * `DevServerStatus.url`), then set `.pathname`/`.search` via their setters —
 * those setters treat the value as pure path/query text and cannot introduce
 * a new authority, confirmed the same leading-`//`/backslash input above
 * still resolves to `baseUrl`'s own host when assigned this way.
 */
export function resolveUpstreamUrl(baseUrl: string, pathname: string, search: string): URL {
  const upstream = new URL(baseUrl)
  upstream.pathname = pathname
  upstream.search = search
  return upstream
}

/**
 * Strip every header that must never cross the proxy boundary, and rewrite
 * `Host` to the upstream's own authority.
 *
 * - `Cookie` is deleted unconditionally — never forwarded upstream. This is
 *   the entire point of this listener existing.
 * - `Host` is rewritten to `upstreamHost` (the dev server's own authority),
 *   NOT passed through from the client. Vite 7 rejects an unrecognized Host
 *   outright (no `server.allowedHosts` is configured in this repo's own
 *   `vite.config.ts`) — sending the dev server the Host it expects is what
 *   makes this work at all, not optional hardening.
 * - `Connection`, `Keep-Alive`, `Upgrade`, `Transfer-Encoding` are hop-by-hop
 *   headers that must not be forwarded verbatim through a second hop.
 */
export function stripHopByHopAndCookies(headers: Headers, upstreamHost: string): Headers {
  const out = new Headers(headers)
  out.delete('cookie')
  out.delete('connection')
  out.delete('keep-alive')
  out.delete('upgrade')
  out.delete('transfer-encoding')
  out.set('host', upstreamHost)
  return out
}

/**
 * Strip any `Set-Cookie` the upstream dev server tried to send. A user's dev
 * server has no reason to set cookies, but nothing stops their own code from
 * trying — "no cookies on this origin" is a promise this proxy keeps
 * unconditionally, not a hope about upstream behaviour.
 */
export function stripSetCookie(headers: Headers): Headers {
  const out = new Headers(headers)
  out.delete('set-cookie')
  return out
}

let warnedMissingPublicOrigin = false

/**
 * Apply this listener's response headers: CSP `frame-ancestors` restricted to
 * the configured public origin(s), and `X-Content-Type-Options: nosniff`.
 *
 * `X-Frame-Options` is deliberately NOT set here — it has no multi-origin
 * allowlist form, so setting `DENY`/`SAMEORIGIN` would either block the one
 * framing origin this listener needs to allow, or (on browsers that honour
 * CSP `frame-ancestors`, which supersedes XFO) do nothing but look like a
 * stricter policy than the one actually in force.
 */
export function liveOriginSecurityHeaders(res: Response, publicOrigins: readonly string[]): Response {
  const headers = new Headers(res.headers)
  headers.set('x-content-type-options', 'nosniff')

  if (publicOrigins.length === 0) {
    if (!warnedMissingPublicOrigin) {
      warnedMissingPublicOrigin = true
      console.warn('[liveOrigin] PUBLIC_ORIGIN not configured — live frames cannot be embedded')
    }
    headers.set('content-security-policy', "frame-ancestors 'none'")
  } else {
    headers.set('content-security-policy', `frame-ancestors ${publicOrigins.join(' ')}; frame-src 'none'`)
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

interface LiveOriginSocketData {
  upstreamWsUrl: string
  upstream?: WebSocket
  /**
   * Messages the browser sent before the outbound `WebSocket` to the
   * upstream dev server finished its own handshake. `WebSocket.send()`
   * throws `InvalidStateError` on a socket that isn't `OPEN` yet — a real
   * race (the browser can send the instant ITS socket opens, which can beat
   * this listener's outbound connect to a slower dev server) rather than a
   * hypothetical, so every message before `open` is queued here and flushed
   * once the upstream socket is actually ready.
   *
   * Bounded by `MAX_PENDING_MESSAGES`/`MAX_PENDING_BYTES` — an upstream that
   * never opens (hangs, or the dev server is wedged) must not let a client
   * grow this array without limit; the socket is closed instead once either
   * cap is hit. See `PENDING_QUEUE_LIMIT_CLOSE_CODE`.
   */
  pending?: (string | Buffer<ArrayBuffer>)[]
  pendingBytes?: number
  /** Cancels `UPSTREAM_CONNECT_TIMEOUT_MS`'s watchdog once the upstream socket actually opens (or the browser socket closes first). */
  connectTimeout?: ReturnType<typeof setTimeout>
}

/** Caps on the pre-open message queue described on `LiveOriginSocketData.pending` above. */
const MAX_PENDING_MESSAGES = 1_000
const MAX_PENDING_BYTES = 5_000_000

/** How long to wait for the outbound upstream `WebSocket` to open before giving up and closing the browser's socket. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000

/** Non-standard close code range (private use, RFC 6455 §7.4.2) — closing because this listener, not the upstream, gave up. */
const PENDING_QUEUE_LIMIT_CLOSE_CODE = 1013 // "Try Again Later"
const UPSTREAM_CONNECT_TIMEOUT_CLOSE_CODE = 1013

function byteLength(message: string | Buffer<ArrayBuffer>): number {
  return typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
}

/** Mutable queue state `enqueuePendingMessage` operates on — the same shape as the relevant slice of `LiveOriginSocketData`, factored out so the cap logic is testable without a live socket. */
export interface PendingQueueState {
  pending: (string | Buffer<ArrayBuffer>)[]
  pendingBytes: number
}

/**
 * Append `message` to `state.pending` unless either cap
 * (`MAX_PENDING_MESSAGES`/`MAX_PENDING_BYTES`) would be exceeded, in which
 * case `state` is left untouched and the caller closes the socket instead of
 * growing it further. An upstream dev server that never opens (hung process,
 * firewalled port) must not let a client hold unbounded memory on this
 * listener by flooding messages before the upstream handshake completes.
 */
export function enqueuePendingMessage(
  state: PendingQueueState,
  message: string | Buffer<ArrayBuffer>,
): 'queued' | 'limit-exceeded' {
  const bytes = byteLength(message)
  if (state.pending.length >= MAX_PENDING_MESSAGES || state.pendingBytes + bytes > MAX_PENDING_BYTES) {
    return 'limit-exceeded'
  }
  state.pending.push(message)
  state.pendingBytes += bytes
  return 'queued'
}

/** Minimal shape `handleLiveOriginFetch` needs from `Bun.Server` — just enough to upgrade a socket, and a test seam. */
export interface LiveOriginUpgradeServer {
  upgrade(req: Request, options: { data: LiveOriginSocketData }): boolean
}

/**
 * The HTTP fetch handler's actual logic, factored out of `Bun.serve`'s config
 * object so it is directly callable with a constructed `Request` — no live
 * socket required. `fetchImpl` defaults to the ambient `fetch` (the real
 * outbound call to a project's dev server in production); tests inject a
 * fake that returns an in-memory `Response` so `server/liveOrigin.test.ts`
 * can assert on exactly what this proxy sends upstream and returns to the
 * client without a round trip through a real socket (this repo's test
 * preload installs happy-dom's `fetch`, which cannot reliably reach a real
 * `Bun.serve` listener — see that test file's own doc comment).
 */
export async function handleLiveOriginFetch(
  req: Request,
  server: LiveOriginUpgradeServer,
  publicOrigins: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const parsed = parseLivePath(url.pathname)
  if (!parsed) {
    return liveOriginErrorResponse(404, { error: 'Unknown project', code: 'unknown-project' }, publicOrigins)
  }
  const { projectKey, rest } = parsed
  const status = getDevServerStatus(projectKey)

  if (!status) {
    return liveOriginErrorResponse(404, { error: 'Unknown project', code: 'unknown-project' }, publicOrigins)
  }

  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    // Re-check readiness right before upgrading — never hand a socket to a
    // project whose dev server is not (or is no longer) ready.
    if (status.phase !== 'ready') {
      return liveOriginErrorResponse(
        503,
        { error: 'Dev server is not ready', code: 'not-ready', phase: status.phase },
        publicOrigins,
      )
    }
    const upstream = resolveUpstreamUrl(status.url, rest, url.search)
    upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:'
    const ok = server.upgrade(req, { data: { upstreamWsUrl: upstream.toString() } })
    return ok ? undefined : new Response('Upgrade failed', { status: 400 })
  }

  if (status.phase !== 'ready') {
    return liveOriginErrorResponse(
      503,
      { error: 'Dev server is not ready', code: 'not-ready', phase: status.phase },
      publicOrigins,
    )
  }

  const upstream = resolveUpstreamUrl(status.url, rest, url.search)
  const upstreamReq = new Request(upstream, {
    method: req.method,
    headers: stripHopByHopAndCookies(req.headers, upstream.host),
    body: req.body,
    // @ts-expect-error Bun supports duplex streaming bodies; not in the lib.dom RequestInit type.
    duplex: req.body ? 'half' : undefined,
  })
  const upstreamRes = await fetchImpl(upstreamReq)
  const res = new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: stripSetCookie(upstreamRes.headers),
  })
  return liveOriginSecurityHeaders(res, publicOrigins)
}

/**
 * Set by `startLiveOriginServer` once the listener has actually bound.
 * `getLiveOriginRuntimeOrigin` reads this — the admin-facing
 * `GET /admin/api/studio/live-origin` route (`liveOriginInfo.ts`) reports
 * `null` when this listener never started (bind failure at boot; a caller
 * still holds the config-resolved origin string, but it would point at
 * nothing).
 */
let runtimeLiveOrigin: string | null = null

/** The live listener's public origin if it actually bound, else `null`. */
export function getLiveOriginRuntimeOrigin(): string | null {
  return runtimeLiveOrigin
}

/**
 * Start the live origin listener. Always started unconditionally at boot
 * (this listener gates per-request by reading a project's own dev-server
 * phase, not globally) — see `server/index.ts`, the ONLY call site (enforced
 * by `live-origin-isolation.test.ts`).
 */
export function startLiveOriginServer(config: ServerConfig): Bun.Server<LiveOriginSocketData> {
  const publicOrigins = config.publicOrigins

  const server = Bun.serve<LiveOriginSocketData>({
    port: config.livePort,

    fetch(req, server) {
      return handleLiveOriginFetch(req, server, publicOrigins)
    },

    websocket: {
      open(ws) {
        const upstream = new WebSocket(ws.data.upstreamWsUrl)
        ws.data.upstream = upstream
        ws.data.pending = []
        ws.data.pendingBytes = 0
        // An upstream dev server that never accepts the connection (wedged
        // process, firewalled port, a bug in L1's registry) must not hold
        // this browser socket — and its queued messages — open forever.
        ws.data.connectTimeout = setTimeout(() => {
          ws.close(UPSTREAM_CONNECT_TIMEOUT_CLOSE_CODE, 'Upstream dev server did not respond')
          upstream.close()
        }, UPSTREAM_CONNECT_TIMEOUT_MS)
        upstream.addEventListener('open', () => {
          clearTimeout(ws.data.connectTimeout)
          for (const message of ws.data.pending ?? []) {
            upstream.send(message)
          }
          ws.data.pending = []
          ws.data.pendingBytes = 0
        })
        upstream.addEventListener('message', (event) => {
          ws.send(event.data)
        })
        upstream.addEventListener('close', () => {
          clearTimeout(ws.data.connectTimeout)
          ws.close()
        })
        upstream.addEventListener('error', () => {
          clearTimeout(ws.data.connectTimeout)
          ws.close(1011)
        })
      },
      message(ws, message) {
        const upstream = ws.data.upstream
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(message)
        } else {
          // The browser's socket can open (and start sending) before this
          // listener's own outbound connect to the upstream dev server
          // finishes — queue rather than drop or throw, but only up to a
          // bounded size: an upstream that never opens must not let a client
          // grow this listener's memory without limit.
          const state: PendingQueueState = { pending: ws.data.pending ?? [], pendingBytes: ws.data.pendingBytes ?? 0 }
          const result = enqueuePendingMessage(state, message)
          ws.data.pending = state.pending
          ws.data.pendingBytes = state.pendingBytes
          if (result === 'limit-exceeded') {
            clearTimeout(ws.data.connectTimeout)
            ws.close(PENDING_QUEUE_LIMIT_CLOSE_CODE, 'Too many messages queued before upstream connected')
            upstream?.close()
          }
        }
      },
      close(ws) {
        clearTimeout(ws.data.connectTimeout)
        ws.data.upstream?.close()
      },
    },

    error(err) {
      // Never echo `err.message` — see the identical rationale in
      // `server/index.ts`'s own top-level catch.
      console.error('[liveOrigin] Unhandled request error:', err)
      return liveOriginSecurityHeaders(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
        publicOrigins,
      )
    },
  })

  runtimeLiveOrigin = config.liveOrigin
  return server
}
