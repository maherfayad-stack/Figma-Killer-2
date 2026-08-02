/**
 * Best-effort OAuth-discovery probe for an http/sse MCP server URL.
 *
 * Studio itself is never the MCP client for a project's servers — the
 * `claude` CLI subprocess is (see `../drivers/claudeCli.ts`'s file doc
 * comment on the loop-ownership fork). So when a registered/declared http
 * server requires authorization, Studio cannot complete an OAuth flow on the
 * user's behalf and must not try — no callback endpoint, no token exchange,
 * nothing that pretends to BE the authorization step. What Studio CAN
 * honestly do, before the user ever spends a chat turn on it, is make ONE
 * unauthenticated discovery request the exact same way the CLI's own MCP
 * client would, read whatever authorization link the server hands back
 * (RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."` → RFC 8414
 * `authorization_endpoint`), and surface that link as-is in the approval UI
 * so the user can open it in their own browser.
 *
 * If the server answers anything else (200, a different challenge, no
 * `WWW-Authenticate`, a metadata document with no discoverable endpoint, a
 * network failure) this reports `requiresAuth: false` / `authorizationUrl:
 * null` rather than guessing — "If the server returns no such URL, say so
 * plainly rather than fabricating one."
 *
 * Deliberately bounded: exactly two network hops maximum (the initial probe,
 * then one metadata fetch), each with a short timeout, each response capped
 * so a malicious/huge body can't be used to tie up the request.
 */
const PROBE_TIMEOUT_MS = 3_000
const MAX_METADATA_BYTES = 64 * 1024

export interface McpServerAuthProbeResult {
  readonly requiresAuth: boolean
  readonly authorizationUrl: string | null
}

const NOT_REQUIRED: McpServerAuthProbeResult = { requiresAuth: false, authorizationUrl: null }

async function fetchBoundedJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > MAX_METADATA_BYTES) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function stringField(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null
  const value = (obj as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringArrayField(obj: unknown, key: string): string[] {
  if (!obj || typeof obj !== 'object') return []
  const value = (obj as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Parses `resource_metadata="<url>"` out of a `WWW-Authenticate` header value, per RFC 9728. `null` when the header is absent or carries no such parameter. */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null
  const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/)
  return match ? match[1] : null
}

/**
 * Probe one http/sse MCP server URL for an OAuth authorization requirement.
 * Never throws — every failure mode degrades to `NOT_REQUIRED`.
 */
export async function probeMcpServerAuthorization(url: string): Promise<McpServerAuthProbeResult> {
  let initial: Response
  try {
    initial = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The smallest well-formed thing a Streamable HTTP MCP server accepts
      // as a request body — this call exists purely to elicit an auth
      // challenge, never to actually invoke a tool.
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    return NOT_REQUIRED
  }

  if (initial.status !== 401) return NOT_REQUIRED

  const resourceMetadataUrl = parseResourceMetadataUrl(initial.headers.get('www-authenticate'))
  if (!resourceMetadataUrl) return NOT_REQUIRED

  const resourceMetadata = await fetchBoundedJson(resourceMetadataUrl)
  if (!resourceMetadata) return { requiresAuth: true, authorizationUrl: null }

  // Some servers publish the authorization endpoint directly on the
  // protected-resource metadata document; most name an authorization SERVER
  // instead, whose OWN metadata (RFC 8414) carries the real endpoint.
  const direct = stringField(resourceMetadata, 'authorization_endpoint')
  if (direct) return { requiresAuth: true, authorizationUrl: direct }

  const authServers = stringArrayField(resourceMetadata, 'authorization_servers')
  const issuer = authServers[0]
  if (!issuer) return { requiresAuth: true, authorizationUrl: null }

  const authServerMetadataUrl = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const authServerMetadata = await fetchBoundedJson(authServerMetadataUrl)
  const endpoint = stringField(authServerMetadata, 'authorization_endpoint')
  return { requiresAuth: true, authorizationUrl: endpoint }
}
