/**
 * `mcpOAuth` — the protocol half of Studio's remote-MCP sign-in.
 *
 * Every network call is stubbed: these tests pin the SHAPE of what Studio
 * sends and the strictness of what it accepts, which is the part that has to
 * stay right. The live endpoints are Figma's and are not this suite's to
 * depend on.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpAuthServer,
  exchangeAuthorizationCode,
  McpClientRegistrationClosedError,
  McpOAuthError,
  refreshAccessToken,
  registerOAuthClient,
  statesMatch,
  type McpAuthServerMetadata,
} from './mcpOAuth'
import { createHash } from 'node:crypto'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Route stubbed responses by URL prefix so a test states only what it cares about. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) return new Response('not found', { status: 404 })
    const route = routes[key]!
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

const FIGMA_SHAPED_METADATA = {
  issuer: 'https://api.example.com',
  authorization_endpoint: 'https://www.example.com/oauth/mcp',
  token_endpoint: 'https://api.example.com/v1/oauth/token',
  registration_endpoint: 'https://api.example.com/v1/oauth/mcp/register',
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:connect'],
}

describe('createPkcePair', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('produces a verifier inside RFC 7636\'s 43–128 character range', () => {
    const { verifier } = createPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 25 }, () => createPkcePair().verifier))
    expect(seen.size).toBe(25)
  })
})

describe('statesMatch', () => {
  it('accepts an exact match and rejects anything else', () => {
    const state = createOAuthState()
    expect(statesMatch(state, state)).toBe(true)
    expect(statesMatch(state, `${state}x`)).toBe(false)
    expect(statesMatch(state, '')).toBe(false)
  })
})

describe('discoverMcpAuthServer', () => {
  it('resolves the resource metadata then the authorization server metadata', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        body: {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://api.example.com'],
          scopes_supported: ['mcp:connect'],
        },
      },
      'https://api.example.com/.well-known/oauth-authorization-server': { body: FIGMA_SHAPED_METADATA },
    })

    const metadata = await discoverMcpAuthServer('https://mcp.example.com/mcp')
    expect(metadata.authorizationEndpoint).toBe('https://www.example.com/oauth/mcp')
    expect(metadata.tokenEndpoint).toBe('https://api.example.com/v1/oauth/token')
    expect(metadata.registrationEndpoint).toBe('https://api.example.com/v1/oauth/mcp/register')
    expect(metadata.resource).toBe('https://mcp.example.com/mcp')
    expect(metadata.scope).toBe('mcp:connect')
  })

  it('tries the path-suffixed well-known URL before the root one', async () => {
    const calls = stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        body: { authorization_servers: ['https://api.example.com'] },
      },
      'https://api.example.com/.well-known/oauth-authorization-server': { body: FIGMA_SHAPED_METADATA },
    })

    await discoverMcpAuthServer('https://mcp.example.com/mcp')
    expect(calls[0]!.url).toBe('https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
  })

  it('refuses a server that does not support PKCE S256 rather than downgrading', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        body: { authorization_servers: ['https://api.example.com'] },
      },
      'https://api.example.com/.well-known/oauth-authorization-server': {
        body: { ...FIGMA_SHAPED_METADATA, code_challenge_methods_supported: ['plain'] },
      },
    })

    await expect(discoverMcpAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(McpOAuthError)
  })

  it('throws when the server publishes no protected-resource metadata at all', async () => {
    stubFetch({})
    await expect(discoverMcpAuthServer('https://plain.example.com/mcp')).rejects.toThrow(McpOAuthError)
  })
})

describe('registerOAuthClient', () => {
  it('registers with the redirect URI, both grant types, and the resource scope', async () => {
    const calls = stubFetch({
      'https://api.example.com/v1/oauth/mcp/register': { body: { client_id: 'cid-1', client_secret: 'csec-1' } },
    })

    const client = await registerOAuthClient(
      'https://api.example.com/v1/oauth/mcp/register',
      'http://localhost:5173/admin/api/ai/mcp/oauth/callback',
      'mcp:connect',
    )

    expect(client).toEqual({ clientId: 'cid-1', clientSecret: 'csec-1' })
    const sent = JSON.parse(String(calls[0]!.init!.body))
    expect(sent.redirect_uris).toEqual(['http://localhost:5173/admin/api/ai/mcp/oauth/callback'])
    expect(sent.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(sent.scope).toBe('mcp:connect')
  })

  it('accepts a public client that is issued no secret', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/mcp/register': { body: { client_id: 'cid-2' } } })
    const client = await registerOAuthClient('https://api.example.com/v1/oauth/mcp/register', 'http://localhost/cb', 's')
    expect(client.clientSecret).toBeNull()
  })

  // Figma advertises `registration_endpoint` and then refuses every caller:
  // its docs allow only clients in its own MCP Catalog. Reported as a status
  // code, that reads to a user as a mistake they made; it is a policy answer
  // no request shape can change, so it gets named and redirected.
  it('names a closed client allow-list rather than reporting a bare 403', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/mcp/register': { status: 403, body: 'Forbidden' } })
    const promise = registerOAuthClient('https://api.example.com/v1/oauth/mcp/register', 'http://localhost/cb', 's')
    await expect(promise).rejects.toThrow(McpOAuthError)
    await expect(promise).rejects.toThrow(/does not accept new OAuth clients/)
    await expect(promise).rejects.toThrow(/Claude CLI/)
    // Typed, not text-matched: the handler answers 403 and PERSISTS the
    // verdict off this class, and the panel keys its whole layout on it.
    await expect(promise).rejects.toThrow(McpClientRegistrationClosedError)
  })

  it('treats 401 the same way — also a refusal of the caller, not of the request', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/mcp/register': { status: 401, body: 'Unauthorized' } })
    await expect(
      registerOAuthClient('https://api.example.com/v1/oauth/mcp/register', 'http://localhost/cb', 's'),
    ).rejects.toThrow(/does not accept new OAuth clients/)
  })

  it('leaves an ordinary failure message alone — only 401/403 mean a closed list', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/mcp/register': { status: 500, body: 'boom' } })
    const promise = registerOAuthClient('https://api.example.com/v1/oauth/mcp/register', 'http://localhost/cb', 's')
    await expect(promise).rejects.toThrow(/answered 500/)
    // An ordinary failure must stay retryable — typing it as a closed
    // allow-list would hide the sign-in button over a transient 500.
    await expect(promise).rejects.not.toThrow(McpClientRegistrationClosedError)
  })

  it('throws when the response carries no client_id', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/mcp/register': { body: { error: 'nope' } } })
    await expect(
      registerOAuthClient('https://api.example.com/v1/oauth/mcp/register', 'http://localhost/cb', 's'),
    ).rejects.toThrow(McpOAuthError)
  })
})

const METADATA: McpAuthServerMetadata = {
  resource: 'https://mcp.example.com/mcp',
  issuer: 'https://api.example.com',
  authorizationEndpoint: 'https://www.example.com/oauth/mcp',
  tokenEndpoint: 'https://api.example.com/v1/oauth/token',
  registrationEndpoint: 'https://api.example.com/v1/oauth/mcp/register',
  scope: 'mcp:connect',
}

describe('buildAuthorizeUrl', () => {
  it('carries client_id, PKCE S256, state, and the RFC 8707 resource indicator', () => {
    const url = new URL(
      buildAuthorizeUrl({
        metadata: METADATA,
        clientId: 'cid-1',
        redirectUri: 'http://localhost:5173/admin/api/ai/mcp/oauth/callback',
        state: 'st-1',
        codeChallenge: 'ch-1',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://www.example.com/oauth/mcp')
    expect(url.searchParams.get('response_type')).toBe('code')
    // The user's own failed sign-in produced "Parameter client_id is required"
    // precisely because a bare authorize URL was opened with none.
    expect(url.searchParams.get('client_id')).toBe('cid-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe('ch-1')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/admin/api/ai/mcp/oauth/callback')
  })
})

describe('exchangeAuthorizationCode', () => {
  it('posts a form-encoded authorization_code grant with the verifier and resource', async () => {
    const calls = stubFetch({
      'https://api.example.com/v1/oauth/token': {
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' },
      },
    })

    const before = Date.now()
    const tokens = await exchangeAuthorizationCode({
      metadata: METADATA,
      clientId: 'cid-1',
      clientSecret: 'csec-1',
      redirectUri: 'http://localhost/cb',
      code: 'code-1',
      codeVerifier: 'ver-1',
    })

    expect(tokens.accessToken).toBe('at-1')
    expect(tokens.refreshToken).toBe('rt-1')
    // `expires_in` is converted to an absolute deadline at exchange time.
    expect(tokens.expiresAt!).toBeGreaterThanOrEqual(before + 3600 * 1000)

    const sent = new URLSearchParams(String(calls[0]!.init!.body))
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code_verifier')).toBe('ver-1')
    expect(sent.get('client_secret')).toBe('csec-1')
    expect(sent.get('resource')).toBe('https://mcp.example.com/mcp')
  })

  it('omits client_secret entirely for a public client', async () => {
    const calls = stubFetch({ 'https://api.example.com/v1/oauth/token': { body: { access_token: 'at-1' } } })
    await exchangeAuthorizationCode({
      metadata: METADATA,
      clientId: 'cid-1',
      clientSecret: null,
      redirectUri: 'http://localhost/cb',
      code: 'code-1',
      codeVerifier: 'ver-1',
    })
    expect(new URLSearchParams(String(calls[0]!.init!.body)).has('client_secret')).toBe(false)
  })

  it('leaves expiresAt null when the server states no lifetime', async () => {
    stubFetch({ 'https://api.example.com/v1/oauth/token': { body: { access_token: 'at-1' } } })
    const tokens = await exchangeAuthorizationCode({
      metadata: METADATA,
      clientId: 'c',
      clientSecret: null,
      redirectUri: 'http://localhost/cb',
      code: 'x',
      codeVerifier: 'y',
    })
    expect(tokens.expiresAt).toBeNull()
  })

  it('surfaces a token-endpoint rejection as a typed error, never a token', async () => {
    stubFetch({
      'https://api.example.com/v1/oauth/token': { status: 400, body: { error: 'invalid_grant' } },
    })
    await expect(
      exchangeAuthorizationCode({
        metadata: METADATA,
        clientId: 'c',
        clientSecret: null,
        redirectUri: 'http://localhost/cb',
        code: 'x',
        codeVerifier: 'y',
      }),
    ).rejects.toThrow(McpOAuthError)
  })
})

describe('refreshAccessToken', () => {
  it('posts a refresh_token grant carrying the resource indicator', async () => {
    const calls = stubFetch({
      'https://api.example.com/v1/oauth/token': { body: { access_token: 'at-2', expires_in: 60 } },
    })

    const tokens = await refreshAccessToken({
      tokenEndpoint: METADATA.tokenEndpoint,
      resource: METADATA.resource,
      clientId: 'cid-1',
      clientSecret: null,
      refreshToken: 'rt-1',
    })

    expect(tokens.accessToken).toBe('at-2')
    const sent = new URLSearchParams(String(calls[0]!.init!.body))
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('rt-1')
    expect(sent.get('resource')).toBe('https://mcp.example.com/mcp')
  })
})
