/**
 * githubAuthRoutes — `/admin/api/studio/github/*`, signing in to GitHub.
 *
 *   POST   github/device/start        → { flowId, userCode, verificationUri, … }
 *   GET    github/device/poll?flowId= → { status: 'pending'|'authorized'|'denied'|'expired', account? }
 *   POST   github/token               { token }  → { account }   (paste-a-PAT)
 *   GET    github/account             → { account: … | null, clientConfigured }
 *   DELETE github/token               → { ok: true }
 *   GET    github/repos               → { repositories: [ … ] }
 *
 * ## Every route here requires a session, and every write requires an origin
 *
 * Unlike most of `/admin/api/studio/*` (see `docs/server.md` on the
 * single-operator posture), these six require a session, because a credential
 * belongs to an ACCOUNT. There is no honest answer to "whose token is this?"
 * without one, and `readGithubToken` is keyed by user id.
 *
 * The three state-changing ones additionally go through `originAllowed`, the
 * same CSRF check `handleCmsRequest` and the AI routes apply. `SameSite=Lax`
 * already stops a POST from an unrelated origin from carrying the session
 * cookie; this closes the same-registrable-domain case, which matters more than
 * anywhere else on this surface because a forged `POST github/token` would
 * plant an attacker's credential under the operator's account.
 *
 * ## The two shapes, and why both exist
 *
 * **Device flow** is the good path: no client secret, no redirect URI to
 * register against whatever host and port this install runs on, and the user
 * never handles a credential. It needs one thing from the operator — a GitHub
 * OAuth App client id in `GITHUB_OAUTH_CLIENT_ID` — and when that is absent
 * the device routes answer **501** and say so, rather than failing in a way
 * that looks like GitHub being down.
 *
 * **Paste a PAT** is the fallback for exactly that case, and for hosts where
 * the device endpoints are blocked. The pasted token is validated against
 * `GET /user` BEFORE it is stored, so a typo is rejected at the paste rather
 * than at the next push.
 *
 * ## What never crosses this boundary
 *
 * A token. Not in a response body, not in a log, not in an error message.
 * Every route answers with {@link GithubAccountViewSchema} at most — login,
 * avatar, scopes, expiry — and `GET account` deliberately does NOT decrypt
 * anything: it reads the row's metadata plus a cached identity, so opening the
 * panel does not put plaintext in memory and does not spend a GitHub API call.
 *
 * The one thing cached across requests is the IDENTITY (login + avatar) for a
 * user id, in memory. It is derived from a GitHub call already made at
 * sign-in; it is not a credential, and it is dropped on sign-out.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import type { StudioSessionRuntime } from './routeGate'
import type { DbClient } from '../../db/client'
import {
  GithubApiError,
  listGithubRepositories,
  readGithubIdentity,
  type GithubApiDeps,
} from './githubApi'
import {
  deleteGithubCredential,
  readGithubCredentialMeta,
  readGithubToken,
  writeGithubCredential,
  type GithubAccountView,
  type GithubCredentialMeta,
} from './githubCredentialStore'
import {
  GithubDeviceFlowError,
  githubOAuthClientId,
  pollGithubDeviceFlow,
  startGithubDeviceFlow,
  type GithubDeviceFlowDeps,
} from './githubDeviceFlow'
import { isEmbeddableGitToken } from './gitAskpass'

const ROUTE_PREFIX = '/admin/api/studio/github/'

/**
 * Body of `POST github/token`. One field, and the only place in this feature
 * a token arrives over the wire — which is why the route validates it against
 * GitHub before storing it and never echoes it back.
 */
const PasteTokenBodySchema = Type.Object({
  token: Type.String(),
})

/**
 * login + avatar for the signed-in account, so `GET account` can render the
 * panel without decrypting the token or calling GitHub on every panel open.
 * Not a credential; dropped on sign-out and on process restart (after which
 * the first `account` read re-derives it, once).
 *
 * Keyed by USER id, not by credential id. A credential id is new on every
 * sign-in — `writeGithubCredential` deletes the row and inserts a fresh one —
 * so a map keyed by it kept the previous id's entry forever and grew by one
 * every time anyone signed in again. The user id is the stable identity, and
 * there is exactly one credential per `(user, provider)` for it to describe.
 */
const identityCache = new Map<string, { login: string; avatarUrl: string | null }>()

export interface GithubAuthRouteDeps extends GithubApiDeps, GithubDeviceFlowDeps {}

function accountView(
  meta: GithubCredentialMeta,
  identity: { login: string; avatarUrl: string | null },
): GithubAccountView {
  return {
    login: identity.login,
    avatarUrl: identity.avatarUrl,
    scopes: meta.scopes,
    expiresAt: meta.expiresAt,
    createdAt: meta.createdAt,
  }
}

/** GitHub said no → an envelope with its status. Anything else → 500 with a message that names no path and no token. */
function githubFailure(err: unknown, fallback: string): Response {
  if (err instanceof GithubApiError) return jsonResponse({ error: err.message }, { status: err.status })
  if (err instanceof GithubDeviceFlowError) return jsonResponse({ error: err.message }, { status: err.status })
  console.error('[studio/githubAuthRoutes]', err)
  return jsonResponse({ error: fallback }, { status: 500 })
}

export async function tryServeStudioGithubAuth(
  req: Request,
  runtime: StudioSessionRuntime,
  url: URL,
  pathname: string,
  deps: GithubAuthRouteDeps = {},
): Promise<Response | null> {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const action = pathname.slice(ROUTE_PREFIX.length)

  const routed =
    (action === 'device/start' && req.method === 'POST') ||
    (action === 'device/poll' && req.method === 'GET') ||
    (action === 'token' && (req.method === 'POST' || req.method === 'DELETE')) ||
    (action === 'account' && req.method === 'GET') ||
    (action === 'repos' && req.method === 'GET')
  if (!routed) return null

  // CSRF defence in depth, matching `handleCmsRequest` and the AI routes.
  // `SameSite=Lax` on the session cookie already stops a POST from an
  // unrelated origin from carrying it, but these three routes STORE AND DELETE A
  // CREDENTIAL — the highest-value writes on the whole Studio surface — and
  // the same-site-different-subdomain case is exactly the one SameSite does
  // not cover. A forged `POST github/token` would plant an attacker's token
  // under the operator's account, and a forged `DELETE` would sign them out.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  // Every route below is account-scoped — see the module doc. The user was
  // resolved once by `routeGate.ts`, which also required `studio.git.write`
  // for the three state-changing actions.
  const user = runtime.user

  try {
    if (action === 'device/start') return await serveDeviceStart(user.id, deps)
    if (action === 'device/poll') return await serveDevicePoll(runtime.db, user.id, url, deps)
    if (action === 'token' && req.method === 'POST') return await servePasteToken(req, runtime.db, user.id, deps)
    if (action === 'token') return await serveSignOut(runtime.db, user.id)
    if (action === 'account') return await serveAccount(runtime.db, user.id, deps)
    return await serveRepos(runtime.db, user.id, deps)
  } catch (err) {
    return githubFailure(err, 'The GitHub request could not be completed.')
  }
}

async function serveDeviceStart(userId: string, deps: GithubAuthRouteDeps): Promise<Response> {
  const clientId = githubOAuthClientId()
  if (!clientId) {
    // 501, not 500: the server is working correctly and is telling the caller
    // that this capability was never configured. The panel turns this into
    // "paste a token instead", which needs no configuration at all.
    return jsonResponse(
      {
        error:
          'Signing in with GitHub needs a GitHub OAuth App client id (GITHUB_OAUTH_CLIENT_ID) on this server. Paste a personal access token instead.',
      },
      { status: 501 },
    )
  }
  // Starting a second flow while one is pending is fine — the old one is
  // simply never polled again and expires. Nothing is written to the database
  // until a token actually arrives, which is why this route needs no `db`.
  const start = await startGithubDeviceFlow(clientId, userId, deps)
  return jsonResponse(start)
}

async function serveDevicePoll(
  db: DbClient,
  userId: string,
  url: URL,
  deps: GithubAuthRouteDeps,
): Promise<Response> {
  const clientId = githubOAuthClientId()
  if (!clientId) return jsonResponse({ error: 'GitHub sign-in is not configured on this server.' }, { status: 501 })

  const flowId = url.searchParams.get('flowId')
  if (!flowId) return badRequest('a device poll needs a flowId')

  const result = await pollGithubDeviceFlow(clientId, userId, flowId, deps)
  // `null` covers "never existed", "already finished", and "someone else's" —
  // all three are a 404, because distinguishing them would confirm the
  // existence of another account's flow.
  if (!result) return jsonResponse({ error: 'That sign-in is no longer in progress.' }, { status: 404 })

  if (result.status !== 'authorized') {
    return jsonResponse({
      status: result.status,
      retryInSeconds: result.status === 'pending' ? result.retryInSeconds : null,
      account: null,
    })
  }

  const account = await storeToken(db, userId, result.token, result.scopes, deps)
  return jsonResponse({ status: 'authorized', retryInSeconds: null, account })
}

async function servePasteToken(
  req: Request,
  db: DbClient,
  userId: string,
  deps: GithubAuthRouteDeps,
): Promise<Response> {
  const body = await readValidatedBody(req, PasteTokenBodySchema)
  if (!body) return badRequest('invalid token body')

  const token = body.token.trim()
  // The same charset the askpass script requires. Rejecting here means a
  // credential that could never be used is never stored — and the refusal
  // names the shape, never the value.
  if (!isEmbeddableGitToken(token)) {
    return badRequest('That does not look like a GitHub token. Paste the token itself, with no surrounding quotes.')
  }

  // `readGithubIdentity` IS the validation: an unusable token cannot answer
  // `GET /user`, and its 401 becomes the message the user reads.
  const identity = await readGithubIdentity(token, deps)
  const meta = await writeGithubCredential(db, userId, {
    token,
    scopes: identity.scopes,
    // A PAT's expiry is not exposed on `GET /user`, and guessing one would
    // sign the user out of a token that still works. `null` means "until
    // GitHub says otherwise", and a 401 later drops the row (see the store).
    expiresAt: null,
  })
  identityCache.set(userId, { login: identity.login, avatarUrl: identity.avatarUrl })
  return jsonResponse({ account: accountView(meta, identity) })
}

async function serveSignOut(db: DbClient, userId: string): Promise<Response> {
  identityCache.delete(userId)
  await deleteGithubCredential(db, userId)
  // Idempotent on purpose: signing out twice is not an error, and a 404 here
  // would make the panel show a failure for reaching the state it wanted.
  return jsonResponse({ ok: true })
}

async function serveAccount(db: DbClient, userId: string, deps: GithubAuthRouteDeps): Promise<Response> {
  const meta = await readGithubCredentialMeta(db, userId)
  if (!meta) {
    return jsonResponse({ account: null, clientConfigured: githubOAuthClientId() !== null })
  }

  const identity = await resolveIdentity(db, userId, deps)
  if (!identity) {
    // The stored token no longer identifies anyone — GitHub revoked it, or it
    // expired. `resolveIdentity` already dropped the row, so the honest
    // answer is "signed out" plus the offer to sign in again.
    return jsonResponse({ account: null, clientConfigured: githubOAuthClientId() !== null })
  }
  return jsonResponse({ account: accountView(meta, identity), clientConfigured: githubOAuthClientId() !== null })
}

async function serveRepos(db: DbClient, userId: string, deps: GithubAuthRouteDeps): Promise<Response> {
  const token = await readGithubToken(db, userId)
  if (!token) return jsonResponse({ error: 'Sign in to GitHub first.' }, { status: 409 })
  const repositories = await listGithubRepositories(token, deps)
  return jsonResponse({ repositories })
}

/** Writes a freshly-obtained token and returns the panel's view of it. Shared by the device flow's terminal poll and the paste path. */
async function storeToken(
  db: DbClient,
  userId: string,
  token: string,
  scopes: readonly string[],
  deps: GithubAuthRouteDeps,
): Promise<GithubAccountView> {
  const identity = await readGithubIdentity(token, deps)
  const meta = await writeGithubCredential(db, userId, {
    token,
    // GitHub reports the granted scopes on the token response AND on every
    // API response header. Prefer the header's answer when the grant did not
    // name any — a fine-grained app reports nothing in the grant.
    scopes: scopes.length > 0 ? scopes : identity.scopes,
    expiresAt: null,
  })
  identityCache.set(userId, { login: identity.login, avatarUrl: identity.avatarUrl })
  return accountView(meta, identity)
}

/**
 * The cached identity for this user's credential, or one freshly read from
 * GitHub.
 * A read that GitHub refuses means the stored token is dead, so the row is
 * removed and `null` is returned — the panel then shows "signed out" rather
 * than an account that can no longer do anything.
 */
async function resolveIdentity(
  db: DbClient,
  userId: string,
  deps: GithubAuthRouteDeps,
): Promise<{ login: string; avatarUrl: string | null } | null> {
  const cached = identityCache.get(userId)
  if (cached) return cached

  const token = await readGithubToken(db, userId)
  if (!token) return null
  try {
    const identity = await readGithubIdentity(token, deps)
    const resolved = { login: identity.login, avatarUrl: identity.avatarUrl }
    identityCache.set(userId, resolved)
    return resolved
  } catch (err) {
    if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
      identityCache.delete(userId)
      await deleteGithubCredential(db, userId)
      return null
    }
    throw err
  }
}

/** Test-only: drops the identity cache so one case's sign-in cannot satisfy another's `account` read. */
export function clearGithubIdentityCacheForTest(): void {
  identityCache.clear()
}

/** Test-only: how many identities are cached, so "signing in again does not add an entry" is assertable. */
export function githubIdentityCacheSizeForTest(): number {
  return identityCache.size
}
