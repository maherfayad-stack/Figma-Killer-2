/**
 * OAuth 2.1 client for remote MCP servers — the protocol half.
 *
 * ## Why Studio performs this flow at all
 *
 * `../../mcp/authProbe.ts` used to state that Studio is never the MCP client
 * (the `claude` CLI subprocess is) and therefore "cannot complete an OAuth
 * flow on the user's behalf and must not try". The premise is true; the
 * conclusion was too strong. Studio does not need to BE the MCP client to hold
 * the credential: the `--mcp-config` file it already writes carries a
 * `headers` object per http server (`registeredMcpServers.ts`'s
 * `resolveOneDefinition`), and `bearer_methods_supported: ["header"]` is
 * exactly how a remote resource expects to be called. So Studio can own the
 * browser flow — it IS a web app, which is the one thing the subprocess is not
 * — store the token set encrypted at rest, and hand the CLI a ready-authorised
 * server definition.
 *
 * ## Where that stops working, and it is not a gap this module can close
 *
 * This flow needs the authorization server to accept a NEW client. Many do.
 * **Figma does not**, and it is the connector Studio ships: its docs say only
 * clients in the Figma MCP Catalog (Claude Code, VS Code, Cursor) may connect,
 * and its `registration_endpoint` — advertised in its own metadata, which per
 * RFC 7591 means "you may register here" — answers a bare `403 Forbidden` to
 * every request shape. See {@link closedRegistrationMessage}: that case is
 * named for what it is and pointed at the CLI sign-in, rather than surfaced as
 * a status code the user will read as their own mistake.
 *
 * Nothing about the consent boundary moves either way: a server is approved by
 * a human first, and signing in is a second, separate human action.
 *
 * ## What this module is, and is not
 *
 * This is the stateless protocol half: discovery, Dynamic Client Registration,
 * PKCE, the authorization URL, and the two token grants. It performs network
 * I/O and nothing else — it reads no state, writes no state, and knows nothing
 * about users or projects. Persistence, refresh-on-expiry, and the
 * "is this server signed in?" question all live in `mcpOAuthStore.ts`.
 *
 * ## Bounded on purpose
 *
 * Every request here is a fetch against a URL that ultimately comes from a
 * user-registered server definition, so each one carries an explicit timeout
 * and a response-size cap, and every response body is validated against a
 * TypeBox schema rather than trusted (CLAUDE.md: "validate at the boundary").
 * A malformed or hostile metadata document degrades to a typed error with a
 * message the Settings UI can show, never to a partially-configured client.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseValue } from '@core/utils/typeboxHelpers'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024

/** The scope every MCP authorization server is expected to expose for tool access, used when a server's metadata advertises none of its own. */
const DEFAULT_MCP_SCOPE = 'mcp:connect'

/** Anything that goes wrong in this module, with a message written for a human reading Settings — never a raw stack or a bare status code. */
export class McpOAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'McpOAuthError'
  }
}

/**
 * The authorization server RUNS a closed client allow-list: it advertises
 * dynamic client registration and then refuses to register anyone.
 *
 * Its own class because callers must distinguish it, and two do. It is not a
 * transient failure and not a malformed request — it is a policy answer that
 * every retry will repeat — so the handler PERSISTS it (a panel that has to
 * rediscover it by making the user click a doomed button once per session is
 * the same bug shown more slowly), and the UI swaps the sign-in control for
 * the route that does work. Matching on the message text would have done
 * neither honestly. See {@link closedRegistrationMessage}.
 */
export class McpClientRegistrationClosedError extends McpOAuthError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'McpClientRegistrationClosedError'
  }
}

// ---------------------------------------------------------------------------
// Wire schemas — every external response is validated, never cast
// ---------------------------------------------------------------------------

const ProtectedResourceMetadataSchema = Type.Object({
  authorization_servers: Type.Optional(Type.Array(Type.String())),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
  resource: Type.Optional(Type.String()),
})

const AuthServerMetadataSchema = Type.Object({
  issuer: Type.String(),
  authorization_endpoint: Type.String(),
  token_endpoint: Type.String(),
  registration_endpoint: Type.Optional(Type.String()),
  code_challenge_methods_supported: Type.Optional(Type.Array(Type.String())),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
})

const ClientRegistrationResponseSchema = Type.Object({
  client_id: Type.String(),
  client_secret: Type.Optional(Type.String()),
})

const TokenResponseSchema = Type.Object({
  access_token: Type.String(),
  token_type: Type.Optional(Type.String()),
  expires_in: Type.Optional(Type.Number()),
  refresh_token: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Everything the rest of the flow needs, resolved from the server's own published metadata — never from a hardcoded per-vendor table. */
export interface McpAuthServerMetadata {
  /** Canonical resource identifier, sent as RFC 8707 `resource` on every grant. */
  readonly resource: string
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  /** `null` when the server does not support Dynamic Client Registration — a case this flow cannot recover from on its own, and says so. */
  readonly registrationEndpoint: string | null
  readonly scope: string
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new McpOAuthError(`Could not reach ${new URL(url).host}.`, { cause: err })
  }
  const text = await res.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new McpOAuthError(`${new URL(url).host} returned an implausibly large response.`)
  }
  if (!res.ok) {
    throw new McpOAuthError(`${new URL(url).host} answered ${res.status}${text ? `: ${text.slice(0, 300)}` : '.'}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new McpOAuthError(`${new URL(url).host} returned a response that is not JSON.`, { cause: err })
  }
}

/**
 * The two well-known paths RFC 9728 defines for a resource whose URL has a
 * path component (`/mcp`), most specific first. Figma publishes at the root
 * form; other servers publish at the path-suffixed one, so both are tried
 * before giving up.
 */
function protectedResourceMetadataUrls(serverUrl: URL): string[] {
  const path = serverUrl.pathname.replace(/\/$/, '')
  const root = `${serverUrl.origin}/.well-known/oauth-protected-resource`
  return path && path !== '/' ? [`${root}${path}`, root] : [root]
}

/**
 * Resolve a remote MCP server URL to its authorization server's endpoints.
 *
 * Throws `McpOAuthError` when the server publishes nothing usable — which is
 * the honest answer for "this http server does not do OAuth", and is what the
 * Settings UI turns into "this server does not appear to require sign-in".
 */
export async function discoverMcpAuthServer(serverUrl: string): Promise<McpAuthServerMetadata> {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch (err) {
    throw new McpOAuthError(`"${serverUrl}" is not a valid URL.`, { cause: err })
  }

  let resourceMetadata: Static<typeof ProtectedResourceMetadataSchema> | null = null
  let lastError: unknown = null
  for (const candidate of protectedResourceMetadataUrls(parsed)) {
    try {
      const parsedBody = safeParseValue(ProtectedResourceMetadataSchema, await fetchJson(candidate))
      if (parsedBody.ok) {
        resourceMetadata = parsedBody.value
        break
      }
    } catch (err) {
      lastError = err
    }
  }
  if (!resourceMetadata) {
    throw new McpOAuthError(
      `${parsed.host} published no OAuth metadata at its well-known endpoint, so Studio cannot sign in to it automatically.`,
      { cause: lastError },
    )
  }

  const issuer = resourceMetadata.authorization_servers?.[0]
  if (!issuer) {
    throw new McpOAuthError(`${parsed.host} names no authorization server in its metadata.`)
  }

  const metadataBody = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)
  const metadata = safeParseValue(AuthServerMetadataSchema, metadataBody)
  if (!metadata.ok) {
    throw new McpOAuthError(`${new URL(issuer).host} published an authorization-server document Studio could not read.`)
  }

  const methods = metadata.value.code_challenge_methods_supported
  if (methods && !methods.includes('S256')) {
    throw new McpOAuthError(
      `${new URL(issuer).host} does not support PKCE S256, which Studio requires — sign-in refused rather than downgraded.`,
    )
  }

  const scopes = resourceMetadata.scopes_supported ?? metadata.value.scopes_supported ?? []
  return {
    resource: resourceMetadata.resource ?? serverUrl,
    issuer: metadata.value.issuer,
    authorizationEndpoint: metadata.value.authorization_endpoint,
    tokenEndpoint: metadata.value.token_endpoint,
    registrationEndpoint: metadata.value.registration_endpoint ?? null,
    scope: scopes.length > 0 ? scopes.join(' ') : DEFAULT_MCP_SCOPE,
  }
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

/** RFC 7636 S256. 32 random bytes is the recommended entropy; base64url keeps it inside the 43–128 character verifier range. */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32))
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) }
}

/** The `state` parameter — Figma's metadata sets `require_state_parameter`, and it is what binds a callback to the request that started it. */
export function createOAuthState(): string {
  return base64Url(randomBytes(32))
}

/**
 * Constant-time comparison for the returned `state`. A plain `===` on a
 * secret-equality check is a timing oracle; this is the same discipline the
 * rest of the auth layer uses, applied to the one value an attacker controls
 * in a callback URL.
 */
export function statesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

export interface RegisteredOAuthClient {
  readonly clientId: string
  readonly clientSecret: string | null
}

/** The one wire signal that separates "refusing the caller" from "rejecting the request": a 401 or 403 from the registration endpoint. Shared so the message and the typed error can never disagree. */
function isClosedRegistration(err: unknown): boolean {
  const message = err instanceof McpOAuthError ? err.message : String(err)
  return /\b(401|403)\b/.test(message)
}

/**
 * A registration endpoint that exists but refuses everyone.
 *
 * Some providers advertise `registration_endpoint` in their metadata — which
 * per RFC 7591 means "you may register here" — while actually operating a
 * CLOSED ALLOW-LIST of approved client applications. Figma is one: its docs
 * say in as many words that "only clients listed in the Figma MCP Catalog
 * like VS Code, Cursor, or Claude Code can connect", and
 * `POST https://api.figma.com/v1/oauth/mcp/register` answers a bare `403
 * Forbidden` to every body and header combination — no OAuth error code, no
 * hint, identical for a minimal body, an https redirect URI, a public-client
 * registration and a browser user-agent. It is not validating the request; it
 * is refusing the caller.
 *
 * That is a policy answer, not a bug in the request, and no amount of
 * retrying will change it. Saying "api.figma.com answered 403: Forbidden"
 * sends the user hunting for a mistake they did not make, so 401/403 from a
 * registration endpoint gets named for what it is.
 */
function closedRegistrationMessage(registrationEndpoint: string, err: unknown): string {
  const host = new URL(registrationEndpoint).host
  if (!isClosedRegistration(err)) return err instanceof McpOAuthError ? err.message : String(err)
  return (
    `${host} does not accept new OAuth clients — it advertises dynamic client registration but only approved ` +
    `applications may actually register, so Studio cannot sign in to it directly. Figma is the notable case: ` +
    `only clients in its MCP Catalog (Claude Code, VS Code, Cursor) are allowed, so sign in through the Claude ` +
    `CLI instead — Settings → AI → the Figma row's "Sign in via terminal".`
  )
}

/**
 * Register Studio as an OAuth client with the authorization server.
 *
 * Every remote MCP server worth connecting to supports DCR — it is how a
 * client that was never pre-provisioned (which Studio, running on someone
 * else's machine, always is) gets a `client_id` at all. The user's own
 * failed attempt at this flow produced exactly the error a missing
 * registration gives: Figma's authorize endpoint answering "Parameter
 * client_id is required".
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  scope: string,
): Promise<RegisteredOAuthClient> {
  let body: unknown
  try {
    body = await fetchJson(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Studio',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope,
      }),
    })
  } catch (err) {
    const message = closedRegistrationMessage(registrationEndpoint, err)
    if (isClosedRegistration(err)) throw new McpClientRegistrationClosedError(message, { cause: err })
    throw new McpOAuthError(message, { cause: err })
  }
  const parsed = safeParseValue(ClientRegistrationResponseSchema, body)
  if (!parsed.ok) {
    throw new McpOAuthError('The authorization server accepted the registration but returned no client_id.')
  }
  return { clientId: parsed.value.client_id, clientSecret: parsed.value.client_secret ?? null }
}

// ---------------------------------------------------------------------------
// Authorization + token grants
// ---------------------------------------------------------------------------

export interface AuthorizeUrlInput {
  readonly metadata: McpAuthServerMetadata
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.metadata.scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707 — the MCP spec requires the resource indicator so the issued
  // token is audience-bound to this one server and cannot be replayed at
  // another resource behind the same authorization server.
  url.searchParams.set('resource', input.metadata.resource)
  return url.toString()
}

/** A token grant's result, normalised. `expiresAt` is an absolute epoch-ms deadline rather than the wire's relative `expires_in`, because it is about to be persisted and a relative value goes stale the moment it is written. */
export interface OAuthTokenSet {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresAt: number | null
  readonly scope: string | null
}

async function tokenGrant(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<OAuthTokenSet> {
  const body = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  })
  const parsed = safeParseValue(TokenResponseSchema, body)
  if (!parsed.ok) {
    throw new McpOAuthError('The authorization server returned a token response Studio could not read.')
  }
  return {
    accessToken: parsed.value.access_token,
    refreshToken: parsed.value.refresh_token ?? null,
    expiresAt: parsed.value.expires_in ? Date.now() + parsed.value.expires_in * 1000 : null,
    scope: parsed.value.scope ?? null,
  }
}

export interface CodeExchangeInput {
  readonly metadata: McpAuthServerMetadata
  readonly clientId: string
  readonly clientSecret: string | null
  readonly redirectUri: string
  readonly code: string
  readonly codeVerifier: string
}

export async function exchangeAuthorizationCode(input: CodeExchangeInput): Promise<OAuthTokenSet> {
  return tokenGrant(input.metadata.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.metadata.resource,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  })
}

export interface RefreshInput {
  readonly tokenEndpoint: string
  readonly resource: string
  readonly clientId: string
  readonly clientSecret: string | null
  readonly refreshToken: string
}

export async function refreshAccessToken(input: RefreshInput): Promise<OAuthTokenSet> {
  return tokenGrant(input.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  })
}
