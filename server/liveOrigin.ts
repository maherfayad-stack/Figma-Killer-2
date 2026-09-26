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
 * Path/project-key resolution: the URL segment after `/p/` is a
 * `projectKey` (`registeredMcpServerProjectKey(dir)` —
 * `server/ai/drivers/registeredMcpServers.ts` — normally just a project's
 * immediate-subfolder name under `projectsRootDir()`), not a filesystem
 * path. `resolveProjectDirForKey` below turns it back into a real,
 * containment-checked, ON-DISK-EXISTING project directory via
 * `resolveExistingProjectDir` (`server/handlers/studioProjects.ts`) before
 * it ever reaches L1's registry — a raw, unchecked
 * `join(projectsRootDir(), projectKey)` would reopen exactly the
 * path-escape class `resolveProjectDir`'s own doc comment exists to close.
 * The existence check specifically (on top of plain containment) is what
 * lets this file still distinguish "no such project" (404) from "a real
 * project whose dev server just isn't ready yet" (503): `getDevServerStatus`
 * (`server/handlers/studio/devServer.ts`, L1) is a plain, ALWAYS-defined
 * in-memory read that reports `phase: 'stopped'` for any dir it has never
 * spawned a process for, so `status.phase` alone cannot tell "unregistered"
 * apart from "known but not started." Trust-tier gating happens in L1's
 * `ensureDevServer`, not here: a project only ever reaches `phase: 'ready'`
 * in that registry if it was allowed to boot. This file trusts a `ready`
 * phase as sufficient authorization to proxy and does not re-read
 * `.studio/meta.json` — a second copy of that gate would drift.
 *
 * Forwarded path: the incoming pathname (including the `/p/<projectKey>`
 * prefix) is forwarded to the upstream dev server UNCHANGED — this listener
 * does not strip it. That only works because the spawned dev server's own
 * `vite.config.js` is given a matching `base: '/p/<projectKey>/'`
 * (`server/handlers/studio/devServer.ts`'s `STUDIO_LIVE_BASE_PATH` env var,
 * read by `prototypeShell/shellFiles.ts`'s `VITE_CONFIG` template) — Vite
 * itself then expects and rewrites every asset URL (including
 * `index.html`'s own root-absolute script src, automatically — no
 * `%BASE_URL%` needed there, see that template's own doc for why adding one
 * on top double-prefixes it) and the HMR websocket path to carry that same
 * prefix. An earlier version of this file stripped the prefix before
 * forwarding, which broke every page proxied through this listener past
 * the first HTML response (see `live-06`, STATE.md, for the full failure
 * mode and fix).
 */
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { ServerConfig } from './config'
import { getDevServerStatus, getDevServerUpstreamUrl } from './handlers/studio/devServer'
import { projectsRootDir, resolveExistingProjectDir } from './handlers/studioProjects'

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

function liveOriginErrorResponse(status: number, body: LiveOriginError, frameAncestors: readonly string[]): Response {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  return liveOriginSecurityHeaders(res, frameAncestors)
}

/**
 * Extract the `projectKey` from `/p/<projectKey>/<rest>`. Returns `null` for
 * anything that isn't shaped that way (the caller falls through to a normal
 * 404).
 *
 * Used ONLY to look up the project's dev-server registry entry — the
 * upstream request itself now forwards the FULL, un-stripped incoming
 * pathname (see the `resolveUpstreamUrl` call sites below), because the
 * spawned dev server's own `vite.config.js` is configured with
 * `base: '/p/<projectKey>/'` (`server/handlers/studio/devServer.ts`'s
 * `STUDIO_LIVE_BASE_PATH` env var, read by `prototypeShell/shellFiles.ts`'s
 * `VITE_CONFIG` template) and therefore expects every asset request —
 * `/prototype/main.jsx`, `/@vite/client`, the HMR websocket — to arrive
 * PREFIXED with `/p/<projectKey>`, not stripped of it. Stripping the prefix
 * before forwarding (the previous behavior) broke every page proxied through
 * this listener past the first HTML response: the browser resolves the
 * HTML's own absolute-root asset URLs against `<LIVE_ORIGIN>`'s root, which
 * no longer matches `/p/<projectKey>/*` at all once the prefix is gone.
 */
function parseLivePath(pathname: string): { projectKey: string } | null {
  if (!pathname.startsWith(LIVE_PATH_PREFIX)) return null
  const withoutPrefix = pathname.slice(LIVE_PATH_PREFIX.length)
  const slashIndex = withoutPrefix.indexOf('/')
  const projectKey = slashIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, slashIndex)
  if (!projectKey) return null
  return { projectKey }
}

/**
 * `projectKey` (the raw `/p/<projectKey>` URL segment) -> a real, existing,
 * containment-checked project directory, or `null` for "no such project" —
 * a workspace-escape attempt OR a directory that doesn't exist on disk.
 * Never throws.
 */
function resolveProjectDirForKey(projectKey: string): string | null {
  return resolveExistingProjectDir(join(projectsRootDir(), projectKey))
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
 * has `url.pathname === '/p/<projectKey>//evil.example/steal'` — the whole
 * incoming pathname, forwarded unstripped (see `parseLivePath`'s doc for
 * why) — and `new URL(url.pathname, status.url)` would silently resolve to
 * `http://evil.example/steal` — this listener would then make a server-side
 * fetch (SSRF) to an attacker-chosen host, or open an attacker-chosen
 * WebSocket, entirely outside the intended project's own dev server.
 * Verified empirically: `new URL('//evil.com/x', 'http://127.0.0.1:5173').host === 'evil.com'`.
 *
 * The fix is to never let path input reach the URL constructor's first
 * argument at all. Parse `baseUrl` alone (authority fixed, from the trusted,
 * server-internal `getDevServerUpstreamUrl(dir)`), then set
 * `.pathname`/`.search` via their setters —
 * those setters treat the value as pure path/query text and cannot introduce
 * a new authority, confirmed the same leading-`//`/backslash input above
 * still resolves to `baseUrl`'s own host when assigned this way (the
 * `/p/<projectKey>` prefix ahead of it means the attacker-controlled `//`
 * segment isn't even leading here, but the setter is not relying on that —
 * it is safe against a bare leading `//` too, exercised directly by this
 * file's own tests).
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
/**
 * The subprotocols a `Sec-WebSocket-Protocol` header offers, in order, each
 * trimmed, empties dropped — `[]` for a missing header. Exported for the
 * relay's tests; the header grammar is a plain comma list (RFC 6455 §4.1).
 */
export function parseWebSocketProtocols(header: string | null): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

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

/**
 * Apply this listener's response headers: CSP `frame-ancestors` restricted to
 * `frameAncestors` — `ServerConfig.liveFrameAncestors`, the same origins the
 * admin's CSRF check accepts as the editor (public, dev, and the admin
 * server's own) — and `X-Content-Type-Options: nosniff`. An empty list means
 * nobody may frame this listener, which is what a caller that passes one gets.
 *
 * `X-Frame-Options` is deliberately NOT set here — it has no multi-origin
 * allowlist form, so setting `DENY`/`SAMEORIGIN` would either block the one
 * framing origin this listener needs to allow, or (on browsers that honour
 * CSP `frame-ancestors`, which supersedes XFO) do nothing but look like a
 * stricter policy than the one actually in force.
 */
export function liveOriginSecurityHeaders(res: Response, frameAncestors: readonly string[]): Response {
  const headers = new Headers(res.headers)
  headers.set('x-content-type-options', 'nosniff')
  headers.set(
    'content-security-policy',
    frameAncestors.length === 0 ? "frame-ancestors 'none'" : `frame-ancestors ${frameAncestors.join(' ')}; frame-src 'none'`,
  )
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

interface LiveOriginSocketData {
  upstreamWsUrl: string
  /**
   * The subprotocols the browser offered (`Sec-WebSocket-Protocol`), in order.
   * Vite's HMR listener upgrades ONLY a socket that offers `vite-hmr` (or
   * `vite-ping` for its reconnect probe) and silently leaves any other upgrade
   * hanging — so a relay that opens its upstream leg without them never gets
   * an answer, times out, and the browser's Vite client falls into "server
   * connection lost, polling for restart… reload" for every live frame on the
   * board (`live-11`). Forwarded verbatim to the outbound `WebSocket`.
   */
  protocols: string[]
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
  frameAncestors: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const parsed = parseLivePath(url.pathname)
  if (!parsed) {
    return liveOriginErrorResponse(404, { error: 'Unknown project', code: 'unknown-project' }, frameAncestors)
  }
  const { projectKey } = parsed
  const dir = resolveProjectDirForKey(projectKey)

  if (!dir) {
    return liveOriginErrorResponse(404, { error: 'Unknown project', code: 'unknown-project' }, frameAncestors)
  }

  const status = getDevServerStatus(dir)

  if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    // Re-check readiness right before upgrading — never hand a socket to a
    // project whose dev server is not (or is no longer) ready.
    const upstreamUrl = status.phase === 'ready' ? getDevServerUpstreamUrl(dir) : null
    if (!upstreamUrl) {
      return liveOriginErrorResponse(
        503,
        { error: 'Dev server is not ready', code: 'not-ready', phase: status.phase },
        frameAncestors,
      )
    }
    const upstream = resolveUpstreamUrl(upstreamUrl, url.pathname, url.search)
    upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:'
    const protocols = parseWebSocketProtocols(req.headers.get('sec-websocket-protocol'))
    // The browser's socket is accepted BEFORE the upstream leg has negotiated
    // anything, so the subprotocol it is told about is the first one it
    // offered. A client that offers one and hears none back fails the
    // handshake itself (Chrome: "Sent non-empty 'Sec-WebSocket-Protocol'
    // header but no response was received"), which is the same reload loop
    // from the other side. Vite offers exactly one, so first-offered is the
    // one the upstream will accept too.
    //
    // Bun's `upgrade` already answers with the first offered subprotocol on
    // its own (verified on 1.3.6 and 1.3.13), so no `headers` are passed.
    // Passing `sec-websocket-protocol` explicitly as well made Bun 1.3.6 send
    // the header TWICE, and a client that checks the handshake rejects that
    // (Bun's own client closes with 1002 "Mismatch client protocol"; RFC 6455
    // §4.1 allows one). 1.3.13 de-duplicates it, which is why only a local
    // run on the older Bun showed it.
    const ok = server.upgrade(req, {
      data: { upstreamWsUrl: upstream.toString(), protocols },
    })
    return ok ? undefined : new Response('Upgrade failed', { status: 400 })
  }

  const upstreamUrl = status.phase === 'ready' ? getDevServerUpstreamUrl(dir) : null
  if (!upstreamUrl) {
    return liveOriginErrorResponse(
      503,
      { error: 'Dev server is not ready', code: 'not-ready', phase: status.phase },
      frameAncestors,
    )
  }

  const upstream = resolveUpstreamUrl(upstreamUrl, url.pathname, url.search)
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
  return liveOriginSecurityHeaders(res, frameAncestors)
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
  const frameAncestors = config.liveFrameAncestors

  const server = Bun.serve<LiveOriginSocketData>({
    port: config.livePort,
    // Bun's default request idle timeout is 10 s. A proxied request that
    // streams longer than that — Vite holding a module request while it
    // re-optimizes dependencies — was cut off mid-body, and the frame got
    // half a module ("request timed out after 10 seconds" in the log). The
    // admin listener already runs with no idle timeout; the two must match,
    // or a frame breaks where the editor would not (`live-16`).
    idleTimeout: 0,

    fetch(req, server) {
      return handleLiveOriginFetch(req, server, frameAncestors)
    },

    websocket: {
      open(ws) {
        const upstream = new WebSocket(ws.data.upstreamWsUrl, ws.data.protocols)
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
        // Deliberately NOT `ws.data.upstream?.close()` here — confirmed
        // empirically (dogfooding a real Vite dev server + a real browser
        // through this exact proxy, live-06 STATE.md) that calling `.close()`
        // on an OPEN outbound Bun `WebSocket` client whose peer is Vite's own
        // `ws`-based HMR server does not perform a graceful closing
        // handshake — it RSTs the underlying TCP connection, which surfaces
        // on Vite's side as an uncaught `ECONNRESET` on a raw `net.Socket`
        // with no `'error'` listener, CRASHING THE ENTIRE DEV SERVER
        // PROCESS. Reproduced 100% of the time across three independent runs
        // (bare `.close()`, `.close(1000, reason)`, and a delayed
        // `setTimeout`-deferred close all crashed the peer identically);
        // simply not calling `.close()` at all reproduced zero crashes
        // across the same navigation sequence. A real browser tab closing
        // its OWN direct connection to Vite does not trigger this — only
        // Bun's outbound WebSocket CLIENT does, which is exactly what this
        // proxy is. This is intentionally NOT worked around by reaching for
        // a lower-level close primitive: the standard `WebSocket` interface
        // exposes none, and every closing path this object has goes through
        // the same buggy internal mechanism.
        //
        // The tradeoff: the outbound socket to the dev server is abandoned
        // rather than explicitly torn down on every ordinary page
        // navigation, which is common with a live canvas frame — a real,
        // accepted resource-lingering cost. That cost is only PARTIALLY
        // bounded today: (a) Vite's own HMR client heartbeat may eventually
        // reap a peer that stops responding (not verified against this
        // repo's pinned Vite version — an assumption, not a confirmed
        // mechanism), but (b) `scheduleDevServerIdleTeardown` — the thing
        // that would otherwise kill the whole dev server subprocess (and
        // therefore every socket it holds) after inactivity — is NOT wired
        // to this listener's own dev-server lifecycle at all: its only
        // production caller today is `referenceRender.ts`'s one-shot
        // `ensureDevServer` path, never `startDevServer`/`serveStart`
        // (`devServer.ts`) — the HTTP route this listener's own dev servers
        // are actually started through. A project's dev server started for
        // live-canvas use today runs, and therefore accumulates abandoned
        // upstream sockets, until an explicit `POST .../dev-server/stop` —
        // not "regardless of inactivity" as an earlier version of this
        // comment claimed. Verified by reading `devServer.ts`: `idleTimer`
        // starts `null` on every `spawnEntry` and is only ever set by
        // `scheduleDevServerIdleTeardown`, which nothing in the live-canvas
        // start path calls (`sec-09`, STATE.md). Still preferable to a
        // guaranteed crash of the shared dev server on every navigation
        // (which would take down every OTHER open frame/tab for the same
        // project too), but whoever wires a real caller for
        // `documentMode='bridge'` (see `live-07`'s own "no production call
        // site yet" note) should also either (i) schedule idle teardown for
        // board-started dev servers the same way `referenceRender.ts`
        // already does, or (ii) add an explicit cap on concurrent open
        // upstream sockets per project (the same bounded-cap shape
        // `MAX_PENDING_MESSAGES`/`MAX_PENDING_BYTES` already use above) —
        // before this listener carries real traffic, not after.
        //
        // NOT applied to the two OTHER `upstream.close()` call sites above
        // (the boot-timeout watchdog and the pending-queue overflow guard) —
        // both close a connection that has not yet reached `OPEN`, a
        // narrower, unverified case (a synthetic close-while-`CONNECTING`
        // test against this same dev server did NOT reproduce a crash). Left
        // unchanged rather than "fixed" without evidence; flagged as a
        // follow-up verification target in STATE.md.
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
        frameAncestors,
      )
    },
  })

  runtimeLiveOrigin = config.liveOrigin
  return server
}
