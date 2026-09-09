/**
 * Route-level tests for the live origin proxy (`server/liveOrigin.ts`).
 *
 * ## Why this file is shaped the way it is
 *
 * `STATE.md`'s `live-02` work order asked for these gates to run "against a
 * real bound listener," citing `sharePublic.test.ts`'s comment. Having
 * actually written this file, that citation has it backwards:
 * `sharePublic.test.ts`'s comment says the OPPOSITE — it invokes its handler
 * as a plain function BECAUSE "the happy-dom test preload makes a real
 * server unstartable in this suite." `headlessCapture.test.ts` and
 * `dynamicIslandsPlugin.test.ts` document the same conflict from two other
 * angles. This file hit a THIRD angle of it, confirmed empirically:
 *
 *   - `fetch()` (the global — happy-dom's, via `src/__tests__/setup.ts`'s
 *     preload) against a real `Bun.serve` listener throws
 *     `NetworkError: Parse Error`; routing through `node:http` instead
 *     throws `HPE_UNEXPECTED_CONTENT_LENGTH`. Neither reproduces with the
 *     preload removed — this is the preload's globals (timers / `Response`
 *     family), not a `liveOrigin.ts` bug.
 *   - Separately, and more importantly for what these tests can actually
 *     prove: happy-dom's `Request`/`Response` constructors enforce the
 *     browser's forbidden-header-name list — `new Request(url, { headers:
 *     { host, cookie } })` silently drops both, and `new Response(body,
 *     { headers: { 'set-cookie': v } })` silently drops `Set-Cookie` —
 *     confirmed real Bun does NEITHER of these (a proxy needs to be able to
 *     set `Host` and read a real `Set-Cookie`, and Bun's `Request`/
 *     `Response` are not browser-locked-down the way happy-dom's are). Since
 *     `handleLiveOriginFetch` builds its outbound request via the ambient
 *     `new Request(...)`, ANY assertion that inspects what a mocked
 *     `fetchImpl` "received" for Cookie/Host, in THIS process, would be
 *     testing happy-dom's forbidding-header behaviour, not this file's
 *     `stripHopByHopAndCookies` — a false-positive that would pass even if
 *     that function's body were deleted.
 *
 * So the split here is deliberate:
 *
 *   1. `stripHopByHopAndCookies` / `stripSetCookie` — the actual
 *      security-critical logic — are exported and unit-tested directly
 *      against plain, UNGUARDED `Headers` instances (a bare `new
 *      Headers({...})` is not subject to the forbidden-name guard in either
 *      happy-dom or real Bun — confirmed). This is the layer that really
 *      proves cookies are stripped and Set-Cookie never survives.
 *   2. `handleLiveOriginFetch` is tested for everything the header-guard
 *      quirk does NOT interfere with: unknown-project/not-ready status
 *      codes, CSP headers (not forbidden), upstream URL/query-string
 *      composition, and the WebSocket pre-upgrade decision (refuse without
 *      calling `server.upgrade` when not ready; derive the right `ws://`
 *      URL when ready) — none of which touch header construction. Requests
 *      are constructed as minimal duck-typed stubs (the same technique
 *      `dynamicIslandsPlugin.test.ts`'s `makeReq` uses, for the identical
 *      reason), not `new Request(...)`.
 *   3. The WebSocket BRIDGE itself (an actual browser-visible upgrade) has
 *      no in-process equivalent and genuinely needs a real socket —
 *      `WebSocket`/`server.upgrade` are untouched by the preload (only
 *      `fetch`/`Response`/`Headers`/timers are copied onto `globalThis`),
 *      confirmed working the same way with and without it. That test runs
 *      against a real, bound `Bun.serve` pair.
 *
 * `./handlers/studio/devServer` is L1 — not yet built (its committed stub
 * always returns `undefined`) — so it is replaced here with `mock.module`
 * using the EXACT relative specifier `liveOrigin.ts` itself imports (same
 * technique `compare.test.ts` documents), backed by a plain in-memory
 * registry this file controls per test. `mock.module` replaces the whole
 * module for the run, but nothing else in the tree imports `devServer.ts`
 * yet, so this has no cross-file blast radius today.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { DevServerStatus } from './handlers/studio/devServer'

let registry: Record<string, DevServerStatus | undefined> = {}

mock.module('./handlers/studio/devServer', () => ({
  getDevServerStatus: (projectKey: string): DevServerStatus | undefined => registry[projectKey],
}))

const { handleLiveOriginFetch, stripHopByHopAndCookies, stripSetCookie, startLiveOriginServer, getLiveOriginRuntimeOrigin } =
  await import('./liveOrigin')
const { readServerConfig } = await import('./config')

const PUBLIC_ORIGIN = 'http://localhost:5173'
const UPSTREAM_ORIGIN = 'http://127.0.0.1:5173'

afterEach(() => {
  registry = {}
})

function registerProject(projectKey: string, phase: DevServerStatus['phase'], url = UPSTREAM_ORIGIN): void {
  registry[projectKey] = { dir: `/studio-workspace/${projectKey}`, phase, url }
}

/**
 * A minimal `Request`-shaped stub — NOT `new Request(...)`, because happy-dom
 * enforces the browser forbidden-header-name list at construction time (see
 * module doc comment). `handleLiveOriginFetch` only reads `.url`, `.method`,
 * `.body`, and `.headers.get(...)` from the incoming request, so a plain
 * object faithfully models production (Bun's native incoming `Request`
 * carries every header untouched) while staying deterministic here.
 */
function stubRequest(url: string, headers: Record<string, string> = {}): Request {
  const h = new Headers(headers)
  return { url, method: 'GET', body: null, headers: h } as unknown as Request
}

interface RecordedUpstreamRequest {
  url: string
}

/** A fake `fetchImpl` standing in for the upstream dev server. Returns a duck-typed Response-shaped object (see module doc comment on why not `new Response(...)`). */
function fakeUpstreamFetch(recorded: RecordedUpstreamRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const req = input as Request
    recorded.push({ url: req.url })
    return {
      status: 200,
      body: 'hello from upstream',
      headers: new Headers({ 'content-type': 'text/plain' }),
    } as unknown as Response
  }) as typeof fetch
}

describe('stripHopByHopAndCookies', () => {
  it('deletes cookie and hop-by-hop headers, and rewrites host to the given upstream authority', () => {
    const input = new Headers({
      cookie: 'admin_session=super-secret',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      upgrade: 'websocket',
      'transfer-encoding': 'chunked',
      host: 'not-the-real-host.example',
      accept: 'text/html',
    })
    const out = stripHopByHopAndCookies(input, '127.0.0.1:5173')
    expect(out.get('cookie')).toBeNull()
    expect(out.get('connection')).toBeNull()
    expect(out.get('keep-alive')).toBeNull()
    expect(out.get('upgrade')).toBeNull()
    expect(out.get('transfer-encoding')).toBeNull()
    expect(out.get('host')).toBe('127.0.0.1:5173')
    // A non-stripped header survives untouched.
    expect(out.get('accept')).toBe('text/html')
  })
})

describe('stripSetCookie', () => {
  it('deletes set-cookie and leaves every other header untouched', () => {
    const input = new Headers({ 'set-cookie': 'upstream-session=leak', 'content-type': 'text/plain' })
    const out = stripSetCookie(input)
    expect(out.get('set-cookie')).toBeNull()
    expect(out.get('content-type')).toBe('text/plain')
  })
})

describe('handleLiveOriginFetch', () => {
  it('returns 404 with code unknown-project for an unregistered projectKey', async () => {
    const req = stubRequest('http://live.local/p/never-heard-of-it/')
    const res = await handleLiveOriginFetch(req, { upgrade: () => false }, [PUBLIC_ORIGIN], fakeUpstreamFetch([]))
    expect(res?.status).toBe(404)
    const body = await res!.json()
    expect(body.code).toBe('unknown-project')
  })

  it('returns 503 with code not-ready when the project is booting', async () => {
    registerProject('booting-app', 'booting')
    const req = stubRequest('http://live.local/p/booting-app/')
    const res = await handleLiveOriginFetch(req, { upgrade: () => false }, [PUBLIC_ORIGIN], fakeUpstreamFetch([]))
    expect(res?.status).toBe(503)
    const body = await res!.json()
    expect(body.code).toBe('not-ready')
    expect(body.phase).toBe('booting')
  })

  it('forwards the remaining path and query string onto the upstream origin', async () => {
    registerProject('acme-app', 'ready')
    const recorded: RecordedUpstreamRequest[] = []
    const req = stubRequest('http://live.local/p/acme-app/assets/main.js?v=2')
    await handleLiveOriginFetch(req, { upgrade: () => false }, [PUBLIC_ORIGIN], fakeUpstreamFetch(recorded))
    expect(recorded[0].url).toBe(`${UPSTREAM_ORIGIN}/assets/main.js?v=2`)
  })

  it('sets a CSP frame-ancestors header scoped to the configured public origin, and no X-Frame-Options', async () => {
    registerProject('acme-app', 'ready')
    const req = stubRequest('http://live.local/p/acme-app/')
    const res = await handleLiveOriginFetch(req, { upgrade: () => false }, [PUBLIC_ORIGIN], fakeUpstreamFetch([]))
    expect(res?.headers.get('content-security-policy')).toBe(`frame-ancestors ${PUBLIC_ORIGIN}; frame-src 'none'`)
    expect(res?.headers.get('x-frame-options')).toBeNull()
  })

  it('falls back to frame-ancestors none when no public origin is configured', async () => {
    registerProject('acme-app', 'ready')
    const req = stubRequest('http://live.local/p/acme-app/')
    const res = await handleLiveOriginFetch(req, { upgrade: () => false }, [], fakeUpstreamFetch([]))
    expect(res?.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  })

  it('refuses a WebSocket upgrade to a not-ready project without calling server.upgrade', async () => {
    registerProject('booting-ws-app', 'booting')
    let upgradeCalled = false
    const req = stubRequest('http://live.local/p/booting-ws-app/', { upgrade: 'websocket', connection: 'Upgrade' })
    const res = await handleLiveOriginFetch(
      req,
      { upgrade: () => { upgradeCalled = true; return true } },
      [PUBLIC_ORIGIN],
      fakeUpstreamFetch([]),
    )
    expect(upgradeCalled).toBe(false)
    expect(res?.status).toBe(503)
    const body = await res!.json()
    expect(body.code).toBe('not-ready')
  })

  it('returns 404 for a WebSocket upgrade to an unknown project without calling server.upgrade', async () => {
    let upgradeCalled = false
    const req = stubRequest('http://live.local/p/never-heard-of-it/', { upgrade: 'websocket', connection: 'Upgrade' })
    const res = await handleLiveOriginFetch(
      req,
      { upgrade: () => { upgradeCalled = true; return true } },
      [PUBLIC_ORIGIN],
      fakeUpstreamFetch([]),
    )
    expect(upgradeCalled).toBe(false)
    expect(res?.status).toBe(404)
  })

  it('upgrades a WebSocket request to a ready project, deriving a ws:// upstream URL', async () => {
    registerProject('ws-app', 'ready')
    let capturedUpstreamWsUrl: string | undefined
    const req = stubRequest('http://live.local/p/ws-app/vite-hmr', { upgrade: 'websocket', connection: 'Upgrade' })
    const res = await handleLiveOriginFetch(
      req,
      {
        upgrade: (_req, options) => {
          capturedUpstreamWsUrl = options.data.upstreamWsUrl
          return true
        },
      },
      [PUBLIC_ORIGIN],
      fakeUpstreamFetch([]),
    )
    expect(res).toBeUndefined()
    expect(capturedUpstreamWsUrl).toBe('ws://127.0.0.1:5173/vite-hmr')
  })
})

describe('liveOrigin — real WebSocket bridge (genuine socket required)', () => {
  let fakeUpstream: ReturnType<typeof Bun.serve>
  let liveServer: ReturnType<typeof startLiveOriginServer>

  beforeAll(() => {
    fakeUpstream = Bun.serve<object>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          return server.upgrade(req) ? undefined : new Response('Upgrade failed', { status: 400 })
        }
        return new Response('not a websocket request', { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(message)
        },
      },
    })

    const config = readServerConfig({})
    liveServer = startLiveOriginServer({
      ...config,
      livePort: 0,
      publicOrigins: [PUBLIC_ORIGIN],
    })
  })

  afterAll(() => {
    liveServer.stop(true)
    fakeUpstream.stop(true)
  })

  it('relays a message round-trip through the fake upstream echo handler', async () => {
    registerProject('ws-app', 'ready', `http://127.0.0.1:${fakeUpstream.port}`)
    const ws = new WebSocket(`ws://127.0.0.1:${liveServer.port}/p/ws-app/`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws open failed')))
    })
    const roundTrip = new Promise<string>((resolve) => {
      ws.addEventListener('message', (event) => resolve(event.data as string))
    })
    ws.send('ping')
    expect(await roundTrip).toBe('ping')
    ws.close()
  })

  it('reports its runtime origin once started', () => {
    expect(getLiveOriginRuntimeOrigin()).not.toBeNull()
  })
})
