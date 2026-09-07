/**
 * An in-process host for Studio's three agent-capture routes.
 *
 * A capture grant lives in the memory of the process that minted it
 * (`server/ai/mcp/capture/captureToken.ts`), so a bench cannot mint a token
 * here and have a SEPARATELY spawned server recognise it — the browser would
 * navigate to `/admin/agent-capture?token=…` and get a bare 404. Measuring the
 * real capture path therefore requires the capture routes to be served by the
 * same process that runs the driver.
 *
 * That is all this is: one `Bun.serve` that hands the capture namespace to the
 * real `tryServeAgentCapture` and serves everything else out of the built
 * `dist/` (the capture entry's `/assets/*` bundle). No auth, no admin app, no
 * database — the capture routes authenticate with the grant, never a session
 * cookie, so nothing else is needed to make them answer honestly.
 *
 * Bound to loopback on an ephemeral port and torn down by the caller.
 */
import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { tryServeAgentCapture } from '../../../server/ai/mcp/capture/captureRoute'

export interface CaptureHostHandle {
  /** Origin to point `STUDIO_CAPTURE_ORIGIN` at, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string
  stop(): void
}

/** Resolve one request path inside `staticDir`, refusing anything that escapes it. */
function staticFileFor(staticDir: string, pathname: string): string | null {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const candidate = resolve(join(staticDir, relative))
  if (!candidate.startsWith(resolve(staticDir))) return null
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null
  return candidate
}

/**
 * Start the host. `staticDir` must be a built `dist/` — without it the capture
 * route redirects to Vite's dev server, which a bench has no business starting.
 */
export function startCaptureHost(staticDir: string): CaptureHostHandle {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const captured = await tryServeAgentCapture(req, url, url.pathname)
      if (captured) return captured
      const file = staticFileFor(staticDir, url.pathname)
      if (!file) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(file))
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}
