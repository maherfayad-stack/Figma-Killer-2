/**
 * Where the headless browser loads the capture page from.
 *
 * The admin app is served by two completely different things depending on how
 * Studio is running, and the capture driver has no inbound `Request` to infer
 * it from — it STARTS a navigation rather than answering one.
 *
 *   - **Built** (`dist/index.html` exists): the Bun server serves the admin
 *     app itself, so the canonical route `/admin/agent-capture` is same-origin
 *     on this process's own port and `captureRoute.ts` answers it with the
 *     built `agent-capture.html`.
 *   - **Dev** (`bun run dev`): Vite serves the admin app on 5173 and proxies
 *     `/admin/api` back to Bun. Vite's SPA fallback would answer
 *     `/admin/agent-capture` with the MAIN entry (`index.html`), so in dev the
 *     driver addresses Vite's own second entry point directly. The API calls
 *     the page then makes are proxied back here, so the token still resolves
 *     against this process's grant registry.
 *
 * `STUDIO_CAPTURE_ORIGIN` overrides the origin for a deployment that fronts
 * the admin app somewhere this process cannot guess (a container whose
 * published port differs from `PORT`, say). Read per call so an operator can
 * change it without a restart.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AGENT_CAPTURE_ROUTE } from '@core/studio-capture'

/** Where Vite serves the admin app in `bun run dev` — mirrors `router.ts`'s own `VITE_DEV_URL`. */
const VITE_DEV_URL = 'http://localhost:5173'

/** Vite's second HTML entry (`agent-capture.html` at the repo root). Only used in dev — see module doc. */
const VITE_CAPTURE_ENTRY = '/agent-capture.html'

function adminAppIsBuilt(env: Record<string, string | undefined>): boolean {
  return existsSync(join(resolve(env.STATIC_DIR ?? './dist'), 'index.html'))
}

/**
 * Loopback rather than `localhost` for the built case: the capture page is
 * fetched by a browser this process just launched on this machine, and pinning
 * the literal address skips a DNS lookup that can resolve to an IPv6 address
 * nothing is listening on.
 */
export function captureBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const override = env.STUDIO_CAPTURE_ORIGIN?.trim()
  if (override) return override.replace(/\/$/, '')
  return adminAppIsBuilt(env) ? `http://127.0.0.1:${env.PORT ?? 3001}` : VITE_DEV_URL
}

/** The full URL the driver navigates to, token included. */
export function captureEntryUrl(
  token: string,
  env: Record<string, string | undefined> = process.env,
): string {
  // An explicit origin always means "a real deployment serving the canonical
  // route"; only the un-overridden, un-built case is Vite's own entry.
  const servesCanonicalRoute = Boolean(env.STUDIO_CAPTURE_ORIGIN?.trim()) || adminAppIsBuilt(env)
  const path = servesCanonicalRoute ? AGENT_CAPTURE_ROUTE : VITE_CAPTURE_ENTRY
  return `${captureBaseUrl(env)}${path}?token=${encodeURIComponent(token)}`
}
