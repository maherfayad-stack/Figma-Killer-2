/**
 * `globalThis.fetch` is stubbed per-test rather than hitting a real local
 * server — the repo-wide test preload (`src/__tests__/setup.ts`) installs a
 * happy-dom global `Window` (needed for `@testing-library/react` elsewhere
 * in the suite) whose own `fetch` cannot reliably parse a real Bun.serve
 * response, so a genuine network round trip is not a safe test seam here.
 * Same convention `openaiCompatible.test.ts` uses for its HTTP driver.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { probeMcpServerAuthorization, parseResourceMetadataUrl } from './authProbe'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return handler(url, init)
  }) as unknown as typeof fetch
}

describe('parseResourceMetadataUrl', () => {
  it('extracts the resource_metadata URL from a WWW-Authenticate header', () => {
    expect(
      parseResourceMetadataUrl('Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"'),
    ).toBe('https://example.com/.well-known/oauth-protected-resource')
  })

  it('returns null when there is no such parameter or no header at all', () => {
    expect(parseResourceMetadataUrl('Bearer realm="test"')).toBeNull()
    expect(parseResourceMetadataUrl(null)).toBeNull()
  })
})

describe('probeMcpServerAuthorization', () => {
  it('reports no auth requirement when the server answers 200', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: false, authorizationUrl: null })
  })

  it('reports no auth requirement on a 401 with no WWW-Authenticate header', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: false, authorizationUrl: null })
  })

  it('discovers the authorization endpoint via the full RFC 9728 -> RFC 8414 chain', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/mcp') {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"' },
        })
      }
      if (url === 'https://example.com/.well-known/oauth-protected-resource') {
        return Response.json({ authorization_servers: ['https://auth.example.com'] })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Response.json({ authorization_endpoint: 'https://auth.example.com/authorize' })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: true, authorizationUrl: 'https://auth.example.com/authorize' })
  })

  it('resolves the authorization endpoint directly when the resource metadata publishes one itself', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/mcp') {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/meta"' },
        })
      }
      if (url === 'https://example.com/meta') {
        return Response.json({ authorization_endpoint: 'https://example.com/authorize-directly' })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: true, authorizationUrl: 'https://example.com/authorize-directly' })
  })

  it('reports requiresAuth true with a null link when the resource metadata publishes no usable endpoint — never fabricates one', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/mcp') {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/meta"' },
        })
      }
      if (url === 'https://example.com/meta') {
        return Response.json({ some_other_field: 'nothing usable here' })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: true, authorizationUrl: null })
  })

  it('reports requiresAuth true with a null link when the metadata fetch itself fails', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/mcp') {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/meta"' },
        })
      }
      return new Response('server error', { status: 500 })
    })

    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: true, authorizationUrl: null })
  })

  it('never throws and reports no auth requirement when the fetch itself rejects (network failure)', async () => {
    globalThis.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const result = await probeMcpServerAuthorization('https://example.com/mcp')
    expect(result).toEqual({ requiresAuth: false, authorizationUrl: null })
  })
})
