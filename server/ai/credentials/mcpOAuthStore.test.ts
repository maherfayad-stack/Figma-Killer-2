/**
 * `mcpOAuthStore` — persistence, refresh-on-read, and the failure modes that
 * decide whether a turn silently loses its Figma tools.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OAUTH_SECRET_FIELD,
  buildMcpOAuthSession,
  deleteMcpOAuthSession,
  hasMcpOAuthSession,
  readMcpOAuthSession,
  resolveMcpOAuthHeader,
  writeMcpOAuthSession,
  type McpOAuthSession,
} from './mcpOAuthStore'
import { setMcpServerSecret, getMcpServerSecret } from './mcpServerSecretStore'
import type { McpAuthServerMetadata } from './mcpOAuth'

const realFetch = globalThis.fetch

const METADATA: McpAuthServerMetadata = {
  resource: 'https://mcp.example.com/mcp',
  issuer: 'https://api.example.com',
  authorizationEndpoint: 'https://www.example.com/oauth/mcp',
  tokenEndpoint: 'https://api.example.com/v1/oauth/token',
  registrationEndpoint: 'https://api.example.com/v1/oauth/mcp/register',
  scope: 'mcp:connect',
}

describe('mcpOAuthStore', () => {
  let dataRoot: string
  const address = { userId: 'user-1', projectKey: 'proj', serverName: 'figma', dataRoot: '' }

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
    address.dataRoot = dataRoot
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dataRoot, { recursive: true, force: true })
  })

  function session(overrides: Partial<McpOAuthSession> = {}): McpOAuthSession {
    return {
      ...buildMcpOAuthSession({
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: METADATA,
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        redirectUri: 'http://localhost:5173/admin/api/ai/mcp/oauth/callback',
        tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, scope: 'mcp:connect' },
      }),
      ...overrides,
    }
  }

  it('round-trips a session', async () => {
    await writeMcpOAuthSession(address, session())
    const read = await readMcpOAuthSession(address)
    expect(read?.accessToken).toBe('at-1')
    expect(read?.clientId).toBe('cid-1')
  })

  it('never writes the access or refresh token in plaintext', async () => {
    await writeMcpOAuthSession(address, session({ accessToken: 'at-plaintext-marker', refreshToken: 'rt-plaintext-marker' }))
    const raw = readFileSync(join(dataRoot, 'user-1', 'proj', 'figma.json'), 'utf8')
    expect(raw).not.toContain('at-plaintext-marker')
    expect(raw).not.toContain('rt-plaintext-marker')
  })

  it('resolves a live token as a Bearer header without any network call', async () => {
    globalThis.fetch = (() => {
      throw new Error('a live session must not hit the network')
    }) as unknown as typeof fetch
    await writeMcpOAuthSession(address, session())
    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBe('Bearer at-1')
  })

  it('reports no session before one is written, and again after signing out', async () => {
    expect(hasMcpOAuthSession(address)).toBe(false)
    await writeMcpOAuthSession(address, session())
    expect(hasMcpOAuthSession(address)).toBe(true)
    deleteMcpOAuthSession(address)
    expect(hasMcpOAuthSession(address)).toBe(false)
    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBeNull()
  })

  it('signing out leaves the server\'s other secrets intact', async () => {
    await setMcpServerSecret('user-1', 'proj', 'figma', 'X-Other-Header', 'keep-me', dataRoot)
    await writeMcpOAuthSession(address, session())
    deleteMcpOAuthSession(address)
    expect(await getMcpServerSecret('user-1', 'proj', 'figma', 'X-Other-Header', dataRoot)).toBe('keep-me')
  })

  it('removes the file entirely when the OAuth session was its only field', async () => {
    await writeMcpOAuthSession(address, session())
    deleteMcpOAuthSession(address)
    expect(existsSync(join(dataRoot, 'user-1', 'proj', 'figma.json'))).toBe(false)
  })

  it('refuses a session minted for a different server URL', async () => {
    await writeMcpOAuthSession(address, session())
    expect(await resolveMcpOAuthHeader(address, 'https://elsewhere.example.com/mcp')).toBeNull()
  })

  it('refreshes an expired token, persists the new one, and returns it', async () => {
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() - 1000 }))
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBe('Bearer at-2')
    expect(calls).toBe(1)
    expect((await readMcpOAuthSession(address))?.accessToken).toBe('at-2')
  })

  it('refreshes AHEAD of the deadline so a token cannot expire in flight', async () => {
    // Inside the skew window but not yet expired — still refreshed.
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() + 30_000 }))
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'at-early', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBe('Bearer at-early')
  })

  it('keeps the existing refresh token when the server rotates none', async () => {
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() - 1000 }))
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')
    expect((await readMcpOAuthSession(address))?.refreshToken).toBe('rt-1')
  })

  it('stores a rotated refresh token when the server issues one', async () => {
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() - 1000 }))
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')
    expect((await readMcpOAuthSession(address))?.refreshToken).toBe('rt-2')
  })

  it('KEEPS the session when a refresh fails — a network blip is not a sign-out', async () => {
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() - 1000 }))
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch

    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBeNull()
    expect(hasMcpOAuthSession(address)).toBe(true)
    expect((await readMcpOAuthSession(address))?.refreshToken).toBe('rt-1')
  })

  it('returns null for an expired session that has no refresh token', async () => {
    await writeMcpOAuthSession(address, session({ expiresAt: Date.now() - 1000, refreshToken: null }))
    globalThis.fetch = (() => {
      throw new Error('must not attempt a refresh with no refresh token')
    }) as unknown as typeof fetch
    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBeNull()
  })

  it('treats an unreadable stored shape as signed out rather than throwing', async () => {
    await setMcpServerSecret('user-1', 'proj', 'figma', OAUTH_SECRET_FIELD, '{"version":99}', dataRoot)
    expect(await readMcpOAuthSession(address)).toBeNull()
    expect(await resolveMcpOAuthHeader(address, 'https://mcp.example.com/mcp')).toBeNull()
  })
})
