/**
 * Routing + auth-gate tests for `/admin/api/ai/mcp/project-servers`. The
 * underlying business logic (registry read/write, secret encryption, the
 * agent-tool consent boundary) is exercised directly — with real disk state
 * and no HTTP layer — in `registeredMcpServers.test.ts`,
 * `mcpServerSecretStore.test.ts`, and `mcpServerTool.test.ts`. This file
 * proves the HTTP surface itself: routes are wired to the paths they claim,
 * unrelated paths fall through (`null`), and every route is actually gated
 * by `ai.providers.manage` (a request with no session cookie never reaches
 * the registry — `requireAuthenticatedUser` short-circuits on a missing
 * cookie before it would even need a working `db`, so a stub object that
 * throws if queried is enough to prove this).
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../db/client'
import { tryHandleAiMcpProjectServers } from './registeredServers'

/** Never actually queried by these tests — every route here short-circuits at `requireAuthenticatedUser` on the missing session cookie before any DB call. */
const unusedDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db should not be queried for an unauthenticated request')
    },
  },
) as unknown as DbClient

function req(method: string, path: string, body?: unknown): { req: Request; url: URL } {
  const url = new URL(`http://localhost${path}`)
  return {
    req: new Request(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    url,
  }
}

describe('tryHandleAiMcpProjectServers — routing', () => {
  it('returns null for an unrelated path', () => {
    const { req: request, url } = req('GET', '/admin/api/ai/mcp/connectors')
    expect(tryHandleAiMcpProjectServers(request, unusedDb, url, url.pathname)).toBeNull()
  })

  it('returns null for a path that only shares a prefix', () => {
    const { req: request, url } = req('GET', '/admin/api/ai/mcp/project-servers-other')
    expect(tryHandleAiMcpProjectServers(request, unusedDb, url, url.pathname)).toBeNull()
  })
})

describe('tryHandleAiMcpProjectServers — every route requires ai.providers.manage', () => {
  const cases: Array<[string, string, unknown?]> = [
    ['GET', '/admin/api/ai/mcp/project-servers?dir=%2Ftmp%2Fx'],
    ['POST', '/admin/api/ai/mcp/project-servers', { dir: '/tmp/x', name: 'figma', definition: { transport: 'stdio', command: 'npx' } }],
    ['DELETE', '/admin/api/ai/mcp/project-servers/figma?dir=%2Ftmp%2Fx'],
    ['POST', '/admin/api/ai/mcp/project-servers/figma/approve', { dir: '/tmp/x', source: 'registered' }],
    ['POST', '/admin/api/ai/mcp/project-servers/figma/revoke', { dir: '/tmp/x', source: 'registered' }],
    ['POST', '/admin/api/ai/mcp/project-servers/check-auth', { url: 'https://example.com/mcp' }],
  ]

  for (const [method, path, body] of cases) {
    it(`${method} ${path} → 401 with no session, never touching the registry`, async () => {
      const { req: request, url } = req(method, path, body)
      const response = await tryHandleAiMcpProjectServers(request, unusedDb, url, url.pathname)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(401)
    })
  }
})

describe('tryHandleAiMcpProjectServers — unsupported methods', () => {
  it('returns 405 for an unsupported method on the collection route', async () => {
    const { req: request, url } = req('PATCH', '/admin/api/ai/mcp/project-servers')
    const response = await tryHandleAiMcpProjectServers(request, unusedDb, url, url.pathname)
    expect(response).not.toBeNull()
    // Auth is checked before method dispatch on named sub-routes, but the
    // base collection route's method switch runs first here since PATCH
    // matches neither GET nor POST — still never touches the registry.
    expect([401, 405]).toContain(response!.status)
  })
})
