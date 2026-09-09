export interface ServerConfig {
  port: number
  databaseUrl: string
  uploadsDir: string
  staticDir: string
  trustedProxyCidrs: string[]
  publicOrigins: string[]
  /** Port the second, cookie-free `Bun.serve` listener (`server/liveOrigin.ts`) binds. */
  livePort: number
  /** Public origin of the live listener — what the admin client points an iframe `src` / postMessage target-origin check at. */
  liveOrigin: string
}

function readCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Normalize a raw origin string to a canonical `scheme://host[:port]` form.
 *
 * Parsing goes through the `URL` constructor (no regex, no `as`): the scheme
 * and host are lowercased, an explicit non-default port is preserved, and any
 * path / query / fragment / trailing slash is stripped. Returns `null` for
 * anything the `URL` constructor rejects or that has no usable host.
 *
 * Exported so `server/auth/security.ts` normalizes inbound Origin headers the
 * exact same way it normalized the configured origins — the CSRF comparison is
 * a string equality of two normalized values, so the two paths must agree.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (!url.hostname) return null
    const scheme = url.protocol.replace(':', '').toLowerCase()
    const host = url.hostname.toLowerCase()
    const port = url.port ? `:${url.port}` : ''
    return `${scheme}://${host}${port}`
  } catch {
    return null
  }
}

function normalizeOrigins(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const normalized = normalizeOrigin(entry)
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

/**
 * The set of public origins the CSRF check derives `expectedOrigin` from.
 *
 * Precedence:
 *   1. `PUBLIC_ORIGIN` — comma-separated list (platform domain + custom domain
 *      can coexist). Invalid entries are dropped.
 *   2. Platform auto-detection — `RENDER_EXTERNAL_URL` (full URL) and/or
 *      `https://${RAILWAY_PUBLIC_DOMAIN}` (host only). Both are included when
 *      both env vars are present, keeping one-click deploys config-free.
 *   3. `[]` — no public origin configured; the CSRF check falls back to the
 *      inbound `Host` header.
 */
export function resolvePublicOrigins(env: Record<string, string | undefined>): string[] {
  const explicit = readCsvList(env.PUBLIC_ORIGIN)
  if (explicit.length > 0) {
    return normalizeOrigins(explicit)
  }

  const derived: string[] = []
  if (env.RENDER_EXTERNAL_URL) derived.push(env.RENDER_EXTERNAL_URL)
  if (env.RAILWAY_PUBLIC_DOMAIN) derived.push(`https://${env.RAILWAY_PUBLIC_DOMAIN}`)
  return normalizeOrigins(derived)
}

/**
 * Port for the second, cookie-free `Bun.serve` listener that proxies live
 * Tier 2 dev servers (`server/liveOrigin.ts`). `LIVE_PORT` env var if set and
 * distinct from `port`; otherwise `port + 1`. Guaranteed never equal to
 * `port` — an explicit `LIVE_PORT` that collides with `PORT` falls back to
 * `port + 1` rather than fail the bind or silently proxy through the admin
 * listener.
 */
export function resolveLivePort(env: Record<string, string | undefined>, port: number): number {
  const raw = env.LIVE_PORT
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0 && parsed !== port) {
      return parsed
    }
  }
  return port + 1
}

/**
 * Public origin of the live listener. `LIVE_ORIGIN` env var if set
 * (normalized via `normalizeOrigin`, same as `PUBLIC_ORIGIN`); otherwise
 * `http://localhost:${livePort}` for local dev.
 *
 * Self-hosted/tunneled deployments MUST set `LIVE_ORIGIN` explicitly, exactly
 * as they must set `PUBLIC_ORIGIN` today — see `docs/deployment/README.md`.
 * Unlike `PUBLIC_ORIGIN`, getting this wrong does not open a security hole
 * (no cookies flow on this origin either way): it fails CLOSED, as a
 * postMessage target-origin mismatch that silently drops messages, or an
 * iframe that shows a CSP framing error.
 */
export function resolveLiveOrigin(env: Record<string, string | undefined>, livePort: number): string {
  const raw = env.LIVE_ORIGIN
  if (raw) {
    const normalized = normalizeOrigin(raw)
    if (normalized) return normalized
  }
  return `http://localhost:${livePort}`
}

export function readServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const port = Number(env.PORT ?? 3001)
  const livePort = resolveLivePort(env, port)
  return {
    port,
    databaseUrl: env.DATABASE_URL ?? 'sqlite:./.tmp/dev.db',
    uploadsDir: env.UPLOADS_DIR ?? './uploads',
    staticDir: env.STATIC_DIR ?? './dist',
    trustedProxyCidrs: readCsvList(env.TRUSTED_PROXY_CIDRS),
    publicOrigins: resolvePublicOrigins(env),
    livePort,
    liveOrigin: resolveLiveOrigin(env, livePort),
  }
}
