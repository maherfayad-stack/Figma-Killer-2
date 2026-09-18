/**
 * `/admin/api/studio/shares` — the session-gated management surface.
 *
 * Two properties are worth a gate here. First, the route owns its path and
 * nothing else, so it can sit in `tryServeStudio` without shadowing a sibling.
 * Second — and this is the one that matters — creating and revoking a share
 * REQUIRE a session, on every verb. A GET that leaked the token list would be
 * a full compromise of every live link in the project, so the auth check runs
 * before the method is even inspected.
 *
 * Since `routeGate.ts` landed, that check is not in `shareRoutes.ts` at all:
 * `tryServeStudio` runs `gateStudioRequest` before any sub-router, and this
 * module receives an already-authenticated `AuthUser`. So the refusal is
 * asserted against the gate, which is where it now lives, and the path
 * ownership against the module.
 *
 * The db is a throwing stub: with no session cookie the auth path
 * short-circuits before it queries, so any test that reaches the database has
 * already failed the thing it is testing.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../db/client'
import type { AuthUser } from '../../repositories/users'
import { gateStudioRequest } from './routeGate'
import { tryServeStudioShares } from './shareRoutes'

const ROUTE = '/admin/api/studio/shares'

const db = (() => {
  throw new Error('an unauthenticated share request must never reach the database')
}) as unknown as DbClient

/** A user object the path-ownership cases never read a field of. */
const user = { id: 'never-used' } as AuthUser

function call(pathname: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://localhost${pathname}`)
  return tryServeStudioShares(new Request(url, init), { db, user }, url, url.pathname)
}

function gate(pathname: string, init?: RequestInit) {
  const url = new URL(`http://localhost${pathname}`)
  return gateStudioRequest(new Request(url, init), db, url.pathname)
}

describe('tryServeStudioShares', () => {
  it('ignores a path it does not own', async () => {
    expect(await call('/admin/api/studio/comments')).toBeNull()
    expect(await call('/admin/api/studio/shares/extra')).toBeNull()
    expect(await call('/share/abc')).toBeNull()
  })

  it('requires a session on every verb', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await gate(ROUTE, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(401)
    }
  })
})
