/**
 * `/admin/api/studio/github/*` — signing in to GitHub, end to end against a
 * real (in-memory SQLite) database and a stubbed GitHub.
 *
 * **Nothing in this file touches github.com.** Every GitHub call goes through
 * an injected `fetchImpl`, which is also how the device flow's three terminal
 * outcomes (pending → authorized, denied, expired) are driven deterministically
 * instead of by waiting.
 *
 * The rejections are tested harder than the happy path, because they are the
 * security control:
 *
 *   - an unauthenticated request to every route is a 401;
 *   - one user cannot poll, read, or delete another user's sign-in;
 *   - a token that GitHub will not identify is never stored;
 *   - a token whose characters could break the askpass script's quoting is
 *     refused before it reaches GitHub at all;
 *   - `device/start` on a server with no OAuth App client id is a 501 that
 *     names the paste fallback, not a 500;
 *   - **no response body, anywhere, contains the token.**
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { createUser } from '../../repositories/users'
import { createSession } from '../../auth/sessions'
import { SESSION_COOKIE_NAME, createSessionToken, hashSessionToken, sessionExpiry } from '../../auth/tokens'
import { clearGithubDeviceFlowsForTest } from '../studio/githubDeviceFlow'
import { clearGithubIdentityCacheForTest, tryServeStudioGithubAuth } from '../studio/githubAuthRoutes'
import { readGithubToken } from '../studio/githubCredentialStore'

const TOKEN = 'ghp_0123456789abcdefABCDEF0123456789abcd'
const OTHER_TOKEN = 'ghp_ffffffffffffffffffffffffffffffffffff'
const CLIENT_ID_ENV = 'GITHUB_OAUTH_CLIENT_ID'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: DbClient
let cookieA = ''
let cookieB = ''
let savedClientId: string | undefined

/**
 * Two signed-in accounts, so every cross-user rejection can actually be
 * exercised. Only one row may hold the `owner` role (a unique index), so the
 * second is an `admin` — which has exactly the same access to these routes,
 * because a GitHub credential is scoped by ACCOUNT, not by capability.
 */
async function seedUser(id: string, email: string, roleId: 'owner' | 'admin'): Promise<string> {
  await createUser(db, {
    id,
    email,
    displayName: id,
    passwordHash: 'placeholder-hash',
    roleId,
    allowOwnerRole: roleId === 'owner',
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: id,
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

beforeEach(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  cookieA = await seedUser('user-a', 'a@studio.test', 'owner')
  cookieB = await seedUser('user-b', 'b@studio.test', 'admin')
  clearGithubDeviceFlowsForTest()
  clearGithubIdentityCacheForTest()
  savedClientId = process.env[CLIENT_ID_ENV]
  process.env[CLIENT_ID_ENV] = 'Iv1.testclientid'
})

afterEach(() => {
  if (savedClientId === undefined) delete process.env[CLIENT_ID_ENV]
  else process.env[CLIENT_ID_ENV] = savedClientId
})

interface CallOptions {
  method?: string
  cookie?: string
  body?: unknown
  fetchImpl?: typeof fetch
  /** Epoch ms the flow store should believe it is. Lets the poll pacing be asserted without sleeping. */
  now?: number
}

async function call(pathAndQuery: string, options: CallOptions = {}): Promise<Response> {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const init: RequestInit = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  const req = new Request(url, init)
  // `cookie` is a forbidden header in the Request constructor — set it after.
  if (options.cookie) req.headers.set('cookie', options.cookie)

  const res = await tryServeStudioGithubAuth(req, { db }, url, url.pathname, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: () => options.now! } : {}),
  })
  if (!res) throw new Error(`no route matched ${options.method ?? 'GET'} ${pathAndQuery}`)
  return res
}

function jsonReply(body: unknown, init: ResponseInit & { scopes?: string } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (init.scopes !== undefined) headers.set('x-oauth-scopes', init.scopes)
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

/** A GitHub that identifies `TOKEN` as `octocat` and rejects everything else. */
function githubStub(overrides: { deviceCode?: unknown; accessToken?: unknown[] } = {}): typeof fetch {
  const accessTokenQueue = [...(overrides.accessToken ?? [])]
  return (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (href.includes('/login/device/code')) {
      return jsonReply(
        overrides.deviceCode ?? {
          device_code: 'DEVICE-SECRET-CODE',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 0,
        },
      )
    }
    if (href.includes('/login/oauth/access_token')) {
      return jsonReply(accessTokenQueue.shift() ?? { error: 'authorization_pending' })
    }
    if (href.endsWith('/user')) {
      return jsonReply({ login: 'octocat', avatar_url: 'https://avatars.test/octocat' }, { scopes: 'repo' })
    }
    if (href.includes('/user/repos')) {
      return jsonReply([
        {
          full_name: 'octocat/hello-world',
          clone_url: 'https://github.com/octocat/hello-world.git',
          private: false,
          default_branch: 'main',
          pushed_at: '2026-09-01T00:00:00Z',
        },
      ])
    }
    return new Response('not stubbed', { status: 500 })
  }) as unknown as typeof fetch
}

/** A GitHub that refuses every token. */
const rejectingGithub = (async () =>
  jsonReply({ message: 'Bad credentials' }, { status: 401 })) as unknown as typeof fetch

// ---------------------------------------------------------------------------
// The definition of done
// ---------------------------------------------------------------------------

describe('github auth — the device flow', () => {
  it('starts a flow, polls pending, then stores the granted token and reports the account', async () => {
    const fetchImpl = githubStub({
      accessToken: [
        { error: 'authorization_pending' },
        { access_token: TOKEN, scope: 'repo', token_type: 'bearer' },
      ],
    })
    const t0 = 1_700_000_000_000

    const startRes = await call('/admin/api/studio/github/device/start', {
      method: 'POST',
      cookie: cookieA,
      fetchImpl,
      now: t0,
    })
    expect(startRes.status).toBe(200)
    const start = (await startRes.json()) as {
      flowId: string
      userCode: string
      verificationUri: string
      intervalSeconds: number
    }
    expect(start.userCode).toBe('WDJB-MJHT')
    expect(start.verificationUri).toBe('https://github.com/login/device')

    // The `device_code` is the bearer of the pending authorization and must
    // never reach the browser.
    expect(JSON.stringify(start)).not.toContain('DEVICE-SECRET-CODE')

    const pendingRes = await call(
      `/admin/api/studio/github/device/poll?flowId=${encodeURIComponent(start.flowId)}`,
      { cookie: cookieA, fetchImpl, now: t0 },
    )
    expect(((await pendingRes.json()) as { status: string }).status).toBe('pending')

    const authorizedRes = await call(
      `/admin/api/studio/github/device/poll?flowId=${encodeURIComponent(start.flowId)}`,
      { cookie: cookieA, fetchImpl, now: t0 + start.intervalSeconds * 1000 },
    )
    const authorized = (await authorizedRes.json()) as {
      status: string
      account: { login: string; scopes: string[] } | null
    }
    expect(authorized.status).toBe('authorized')
    expect(authorized.account?.login).toBe('octocat')
    expect(authorized.account?.scopes).toEqual(['repo'])

    // The token is on disk, encrypted, and reachable only by the store.
    expect(await readGithubToken(db, 'user-a')).toBe(TOKEN)
    // …and it is in NO response body.
    expect(JSON.stringify(authorized)).not.toContain(TOKEN)
  })

  it('reports a declined authorization as denied and forgets the flow', async () => {
    const fetchImpl = githubStub({ accessToken: [{ error: 'access_denied' }] })
    const start = (await (
      await call('/admin/api/studio/github/device/start', { method: 'POST', cookie: cookieA, fetchImpl })
    ).json()) as { flowId: string }

    const denied = (await (
      await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, { cookie: cookieA, fetchImpl })
    ).json()) as { status: string }
    expect(denied.status).toBe('denied')
    expect(await readGithubToken(db, 'user-a')).toBeNull()

    // Terminal means forgotten: a second poll is a 404, not a replay.
    const again = await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, {
      cookie: cookieA,
      fetchImpl,
    })
    expect(again.status).toBe(404)
  })

  it('paces itself to the interval GitHub asked for, without hitting GitHub early', async () => {
    let tokenPolls = 0
    const counting = (async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (href.includes('/login/device/code')) {
        return jsonReply({
          device_code: 'DEVICE-SECRET-CODE',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 7,
        })
      }
      tokenPolls += 1
      return jsonReply({ error: 'authorization_pending' })
    }) as unknown as typeof fetch

    const t0 = 1_700_000_000_000
    const start = (await (
      await call('/admin/api/studio/github/device/start', {
        method: 'POST',
        cookie: cookieA,
        fetchImpl: counting,
        now: t0,
      })
    ).json()) as { flowId: string; intervalSeconds: number }
    expect(start.intervalSeconds).toBe(7)

    // First poll reaches GitHub; three more inside the window do not.
    await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, {
      cookie: cookieA,
      fetchImpl: counting,
      now: t0,
    })
    for (const offset of [100, 2_000, 6_999]) {
      const res = await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, {
        cookie: cookieA,
        fetchImpl: counting,
        now: t0 + offset,
      })
      expect(((await res.json()) as { status: string }).status).toBe('pending')
    }
    expect(tokenPolls).toBe(1)

    // Past the interval, it reaches GitHub again.
    await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, {
      cookie: cookieA,
      fetchImpl: counting,
      now: t0 + 7_000,
    })
    expect(tokenPolls).toBe(2)
  })

  it('reports an expired code as expired', async () => {
    const fetchImpl = githubStub({ accessToken: [{ error: 'expired_token' }] })
    const start = (await (
      await call('/admin/api/studio/github/device/start', { method: 'POST', cookie: cookieA, fetchImpl })
    ).json()) as { flowId: string }
    const expired = (await (
      await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, { cookie: cookieA, fetchImpl })
    ).json()) as { status: string }
    expect(expired.status).toBe('expired')
  })
})

// ---------------------------------------------------------------------------
// The rejections
// ---------------------------------------------------------------------------

describe('github auth — rejections', () => {
  it('answers 401 on every route without a session', async () => {
    const routes: Array<[string, string]> = [
      ['POST', '/admin/api/studio/github/device/start'],
      ['GET', '/admin/api/studio/github/device/poll?flowId=x'],
      ['POST', '/admin/api/studio/github/token'],
      ['DELETE', '/admin/api/studio/github/token'],
      ['GET', '/admin/api/studio/github/account'],
      ['GET', '/admin/api/studio/github/repos'],
    ]
    for (const [method, path] of routes) {
      const res = await call(path, { method, body: method === 'POST' ? { token: TOKEN } : undefined })
      expect(res.status).toBe(401)
    }
  })

  it('refuses to let one user poll another user’s sign-in', async () => {
    const fetchImpl = githubStub({ accessToken: [{ access_token: TOKEN, scope: 'repo' }] })
    const start = (await (
      await call('/admin/api/studio/github/device/start', { method: 'POST', cookie: cookieA, fetchImpl })
    ).json()) as { flowId: string }

    // B holds A's flowId — a 404, indistinguishable from a flow that never
    // existed, so it cannot be used to probe for one.
    const stolen = await call(`/admin/api/studio/github/device/poll?flowId=${start.flowId}`, {
      cookie: cookieB,
      fetchImpl,
    })
    expect(stolen.status).toBe(404)
    expect(await readGithubToken(db, 'user-b')).toBeNull()
  })

  it('keeps one user’s credential entirely out of another’s reads', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })

    const bAccount = (await (
      await call('/admin/api/studio/github/account', { cookie: cookieB, fetchImpl: githubStub() })
    ).json()) as { account: unknown }
    expect(bAccount.account).toBeNull()

    const bRepos = await call('/admin/api/studio/github/repos', { cookie: cookieB, fetchImpl: githubStub() })
    expect(bRepos.status).toBe(409)

    // B signing out must not remove A's credential.
    await call('/admin/api/studio/github/token', { method: 'DELETE', cookie: cookieB })
    expect(await readGithubToken(db, 'user-a')).toBe(TOKEN)
  })

  it('never stores a token GitHub will not identify', async () => {
    const res = await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: OTHER_TOKEN },
      fetchImpl: rejectingGithub,
    })
    expect(res.status).toBe(401)
    expect(await readGithubToken(db, 'user-a')).toBeNull()
  })

  it('refuses a token whose characters could break the askpass script, before calling GitHub', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return jsonReply({ login: 'octocat' })
    }) as unknown as typeof fetch

    for (const hostile of ["ghp_x'; id; '", 'ghp_x`whoami`', 'ghp_x\nrm -rf /', 'short']) {
      const res = await call('/admin/api/studio/github/token', {
        method: 'POST',
        cookie: cookieA,
        body: { token: hostile },
        fetchImpl: spy,
      })
      expect(res.status).toBe(400)
    }
    expect(called).toBe(false)
    expect(await readGithubToken(db, 'user-a')).toBeNull()
  })

  it('rejects a body that is not a token object', async () => {
    const res = await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { notAToken: 1 },
      fetchImpl: githubStub(),
    })
    expect(res.status).toBe(400)
  })

  it('answers 501, naming the paste fallback, when no OAuth App client id is configured', async () => {
    delete process.env[CLIENT_ID_ENV]
    const res = await call('/admin/api/studio/github/device/start', {
      method: 'POST',
      cookie: cookieA,
      fetchImpl: githubStub(),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('personal access token')

    // The paste path still works with no configuration at all.
    const pasted = await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })
    expect(pasted.status).toBe(200)
  })

  it('answers 404 for a flowId that was never issued', async () => {
    const res = await call('/admin/api/studio/github/device/poll?flowId=made-up', {
      cookie: cookieA,
      fetchImpl: githubStub(),
    })
    expect(res.status).toBe(404)
  })

  it('answers 400 for a device poll with no flowId', async () => {
    const res = await call('/admin/api/studio/github/device/poll', { cookie: cookieA, fetchImpl: githubStub() })
    expect(res.status).toBe(400)
  })

  it('refuses to list repositories for a user who has not signed in', async () => {
    const res = await call('/admin/api/studio/github/repos', { cookie: cookieA, fetchImpl: githubStub() })
    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Account reads and sign-out
// ---------------------------------------------------------------------------

describe('github auth — account and sign-out', () => {
  it('reports no account, and whether the device flow is even available', async () => {
    const configured = (await (
      await call('/admin/api/studio/github/account', { cookie: cookieA, fetchImpl: githubStub() })
    ).json()) as { account: unknown; clientConfigured: boolean }
    expect(configured.account).toBeNull()
    expect(configured.clientConfigured).toBe(true)

    delete process.env[CLIENT_ID_ENV]
    const unconfigured = (await (
      await call('/admin/api/studio/github/account', { cookie: cookieA, fetchImpl: githubStub() })
    ).json()) as { clientConfigured: boolean }
    expect(unconfigured.clientConfigured).toBe(false)
  })

  it('reads the account back without ever returning the token, and lists repositories', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })

    const accountRes = await call('/admin/api/studio/github/account', { cookie: cookieA, fetchImpl: githubStub() })
    const accountBody = await accountRes.text()
    expect(accountBody).toContain('octocat')
    expect(accountBody).not.toContain(TOKEN)

    const reposRes = await call('/admin/api/studio/github/repos', { cookie: cookieA, fetchImpl: githubStub() })
    const reposBody = await reposRes.text()
    expect(reposBody).toContain('octocat/hello-world')
    expect(reposBody).not.toContain(TOKEN)
  })

  it('signing out deletes the stored credential and is idempotent', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })
    expect(await readGithubToken(db, 'user-a')).toBe(TOKEN)

    const first = await call('/admin/api/studio/github/token', { method: 'DELETE', cookie: cookieA })
    expect(first.status).toBe(200)
    expect(await readGithubToken(db, 'user-a')).toBeNull()

    const second = await call('/admin/api/studio/github/token', { method: 'DELETE', cookie: cookieA })
    expect(second.status).toBe(200)
  })

  it('signing in twice replaces the stored token rather than accumulating rows', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: OTHER_TOKEN },
      fetchImpl: githubStub(),
    })
    expect(await readGithubToken(db, 'user-a')).toBe(OTHER_TOKEN)
    const { rows } = await db<{ n: number }>`select count(*) as n from git_credentials where user_id = 'user-a'`
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('drops the credential when GitHub stops recognising it', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })
    // A restart loses the cached identity; the next read asks GitHub, which
    // now refuses. The row must go, so the panel offers sign-in again.
    clearGithubIdentityCacheForTest()

    const res = await call('/admin/api/studio/github/account', { cookie: cookieA, fetchImpl: rejectingGithub })
    expect(((await res.json()) as { account: unknown }).account).toBeNull()
    expect(await readGithubToken(db, 'user-a')).toBeNull()
  })

  it('stores the plaintext token nowhere in the row', async () => {
    await call('/admin/api/studio/github/token', {
      method: 'POST',
      cookie: cookieA,
      body: { token: TOKEN },
      fetchImpl: githubStub(),
    })
    const { rows } = await db<Record<string, unknown>>`select * from git_credentials where user_id = 'user-a'`
    const serialized = rows.map((row) =>
      Object.values(row)
        .map((value) => (value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value)))
        .join('|'),
    )
    expect(serialized.join('\n')).not.toContain(TOKEN)
  })
})
