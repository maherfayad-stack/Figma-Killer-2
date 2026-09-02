/**
 * Browser OAuth sign-in for a project's outbound MCP servers —
 * `/admin/api/ai/mcp/oauth[/start|/callback|/status]`.
 *
 *   POST   /admin/api/ai/mcp/oauth/start   { dir, name }
 *     -> `{ authorizeUrl }`. Discovers the server's authorization server from
 *        its own published metadata, registers Studio as a client via DCR
 *        (reusing the client from a previous session when the issuer and
 *        redirect URI still match), mints a PKCE verifier + state, and hands
 *        back the URL to open. Nothing is persisted yet.
 *   GET    /admin/api/ai/mcp/oauth/callback?code&state
 *     -> the authorization server's redirect target. Exchanges the code,
 *        stores the session encrypted, and renders a small page telling the
 *        user they can close the tab. Never JSON: a human is looking at it.
 *   GET    /admin/api/ai/mcp/oauth/status?dir&name
 *     -> `{ supportsOAuth, connected, expiresAt, scope }` — drives the
 *        Settings row's sign-in control. Never returns the token.
 *   DELETE /admin/api/ai/mcp/oauth?dir&name
 *     -> signs out of that one server, leaving its other secrets alone.
 *
 * ## Why the pending flow lives in memory
 *
 * Between `/start` and `/callback` there is exactly one secret worth
 * protecting — the PKCE verifier — and its entire useful life is the seconds
 * the user spends on the authorization server's consent screen. Writing it to
 * disk would mean persisting a credential-adjacent value that must then be
 * expired, swept, and cleaned up on failure; keeping it in a process-local map
 * with a hard TTL means a Studio restart simply invalidates in-flight sign-ins,
 * which is the correct outcome and needs no cleanup path at all. The map is
 * bounded and swept on every insert so an abandoned flow cannot accumulate.
 *
 * ## What binds a callback to its request
 *
 * `state` is the map key, compared in constant time, and the entry records the
 * `userId` that started the flow. A callback carrying a valid state but
 * arriving on a different user's session is refused: on a multi-user install,
 * completing someone else's sign-in would store THEIR Figma token under YOUR
 * account.
 *
 * Approval and sign-in stay separate actions. Signing in does not approve a
 * server, and an approved server with no session simply resolves without an
 * `Authorization` header and is dropped for the turn. Both gates are human.
 */
import {
  StartMcpOAuthBodySchema,
  type McpCliConnection,
  type McpOAuthStatus,
} from '@core/ai'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { requireCapability } from '../../../auth/authz'
import { expectedOrigin } from '../../../auth/security'
import type { DbClient } from '../../../db/client'
import { projectsRootDir, resolveProjectDir } from '../../../handlers/studioProjects'
import { claudeCliPlatformSupport, resolveClaudeCliConfigDir, resolveClaudeCliDataRoot } from '../../../handlers/studio/claudeCliEnv'
import { isRealpathContained } from '../../../handlers/studio/workspacePackageResolve'
import { mergeStudioMeta, readStudioMeta } from '../../../handlers/studio/studioMeta'
import { listRegisteredMcpServers, recordBuiltInSignIn, registeredMcpServerProjectKey } from '../../drivers/registeredMcpServers'
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpAuthServer,
  exchangeAuthorizationCode,
  McpClientRegistrationClosedError,
  McpOAuthError,
  registerOAuthClient,
  statesMatch,
  type McpAuthServerMetadata,
} from '../../credentials/mcpOAuth'
import {
  buildMcpOAuthSession,
  deleteMcpOAuthSession,
  readMcpOAuthSession,
  writeMcpOAuthSession,
} from '../../credentials/mcpOAuthStore'
import {
  clearCliMcpConnectionCache,
  clearCliNeedsAuthCache,
  ensureCliMcpServerRegistered,
  probeCliMcpConnections,
  rememberCliSignIn,
} from '../../credentials/cliMcpConnectionProbe'

const BASE = '/admin/api/ai/mcp/oauth'
const START_PATH = `${BASE}/start`
const CALLBACK_PATH = `${BASE}/callback`
const STATUS_PATH = `${BASE}/status`
const CLI_STATUS_PATH = `${BASE}/cli-status`

/** Long enough for a real consent screen (including a fresh Figma login), short enough that an abandoned flow is gone quickly. */
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 32

interface PendingFlow {
  readonly userId: string
  readonly dir: string
  readonly projectKey: string
  readonly serverName: string
  readonly serverUrl: string
  readonly metadata: McpAuthServerMetadata
  readonly clientId: string
  readonly clientSecret: string | null
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly createdAt: number
}

const pending = new Map<string, PendingFlow>()

function sweepPending(now: number): void {
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > PENDING_TTL_MS) pending.delete(state)
  }
  // A hard cap as well as a TTL: the sweep only removes EXPIRED entries, so a
  // burst of starts inside the TTL window would otherwise grow unbounded.
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next()
    if (oldest.done) break
    pending.delete(oldest.value)
  }
}

export function tryHandleAiMcpOAuth(
  req: Request,
  db: DbClient,
  url: URL,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null
  return handle(req, db, url, pathname)
}

async function handle(req: Request, db: DbClient, url: URL, pathname: string): Promise<Response> {
  if (pathname === START_PATH) {
    if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
    return handleStart(req, db)
  }
  if (pathname === CALLBACK_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
    return handleCallback(req, db, url)
  }
  if (pathname === STATUS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
    return handleStatus(req, db, url)
  }
  if (pathname === CLI_STATUS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
    return handleCliStatus(req, db, url)
  }
  if (pathname === BASE && req.method === 'DELETE') return handleSignOut(req, db, url)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

type Resolved =
  | { ok: true; dir: string; projectKey: string; serverUrl: string }
  | { ok: false; response: Response }

/**
 * Resolve `(dir, name)` to a registered http/sse server's URL, with the same
 * containment check every other project-scoped route uses. A stdio server has
 * no OAuth story at all — it is a local command, and its credentials are
 * environment variables — so it is refused here rather than silently treated
 * as unsupported.
 */
function resolveServer(dirParam: string | null, name: string): Resolved {
  const dir = resolveProjectDir(dirParam)
  if (!isRealpathContained(dir, projectsRootDir())) {
    return { ok: false, response: new Response('Not found', { status: 404 }) }
  }
  const server = listRegisteredMcpServers(dir).find((s) => s.name === name)
  if (!server) {
    return { ok: false, response: jsonResponse({ error: `No MCP server named "${name}" is registered for this project.` }, { status: 404 }) }
  }
  if (server.definition.transport === 'stdio') {
    return { ok: false, response: badRequest(`"${name}" is a local command, not a remote server — it has no OAuth sign-in.`) }
  }
  return { ok: true, dir, projectKey: registeredMcpServerProjectKey(dir), serverUrl: server.definition.url }
}

/**
 * The absolute URL the authorization server will redirect back to.
 *
 * Taken from the browser's own `Origin` when it sent one — the AI dispatcher
 * has already rejected any origin outside the expected/dev allowlist before
 * this runs, so an `Origin` that reached here is one Studio trusts, and it is
 * the only value guaranteed to be reachable from the browser that will follow
 * the redirect (Studio's API is commonly proxied through the Vite dev server
 * on a different port than the one the server itself sees).
 */
function redirectUriFor(req: Request): string {
  const origin = req.headers.get('origin') ?? expectedOrigin(req)
  return `${origin.replace(/\/$/, '')}${CALLBACK_PATH}`
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleStart(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, StartMcpOAuthBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const resolved = resolveServer(body.dir ?? null, body.name)
  if (!resolved.ok) return resolved.response

  const redirectUri = redirectUriFor(req)

  try {
    const metadata = await discoverMcpAuthServer(resolved.serverUrl)

    // Reuse the client from a previous session when it is still valid for this
    // issuer AND this redirect URI. DCR is cheap but not free, and some
    // authorization servers rate-limit it; re-registering on every sign-in
    // would also orphan a client record on their side each time.
    const existing = await readMcpOAuthSession({
      userId: userOrResponse.id,
      projectKey: resolved.projectKey,
      serverName: body.name,
    })
    const reusable = existing && existing.issuer === metadata.issuer && existing.redirectUri === redirectUri
    let clientId: string
    let clientSecret: string | null
    if (reusable) {
      clientId = existing.clientId
      clientSecret = existing.clientSecret
    } else {
      if (!metadata.registrationEndpoint) {
        return jsonResponse(
          {
            error: `${new URL(resolved.serverUrl).host} requires OAuth but does not support dynamic client registration, so Studio cannot sign in to it automatically.`,
          },
          { status: 400 },
        )
      }
      const client = await registerOAuthClient(metadata.registrationEndpoint, redirectUri, metadata.scope)
      clientId = client.clientId
      clientSecret = client.clientSecret
    }

    const state = createOAuthState()
    const pkce = createPkcePair()
    sweepPending(Date.now())
    pending.set(state, {
      userId: userOrResponse.id,
      dir: resolved.dir,
      projectKey: resolved.projectKey,
      serverName: body.name,
      serverUrl: resolved.serverUrl,
      metadata,
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: pkce.verifier,
      createdAt: Date.now(),
    })

    return jsonResponse({
      authorizeUrl: buildAuthorizeUrl({ metadata, clientId, redirectUri, state, codeChallenge: pkce.challenge }),
    })
  } catch (err) {
    // A closed allow-list is the provider forbidding Studio, not a bad gateway
    // and not a bad request — so it answers 403, which is the one status the
    // panel can act on without reading the message text. Remembered too: the
    // answer is the same tomorrow, and the user should not have to buy it
    // again with a click that cannot work.
    if (err instanceof McpClientRegistrationClosedError) {
      rememberRegistrationClosed(resolved.dir, body.name)
      return jsonResponse({ error: err.message }, { status: 403 })
    }
    if (err instanceof McpOAuthError) return jsonResponse({ error: err.message }, { status: 502 })
    console.error('[ai/mcpOAuth] sign-in could not be started:', err)
    return jsonResponse({ error: 'Could not start the sign-in flow.' }, { status: 500 })
  }
}

/** Persist "this provider refuses to register Studio" against the project, additively and idempotently. Never throws — a note that fails to save costs one extra doomed attempt, never the flow. */
function rememberRegistrationClosed(dir: string, name: string): void {
  try {
    const current = readStudioMeta(dir).mcpOAuthRegistrationClosed ?? []
    if (current.includes(name)) return
    mergeStudioMeta(dir, { mcpOAuthRegistrationClosed: [...current, name] })
  } catch (err) {
    console.error('[ai/mcpOAuth] could not record the closed client registration:', err)
  }
}

/** Whether this project has already learned that `name`'s provider refuses new OAuth clients. */
function registrationClosedFor(dir: string, name: string): boolean {
  try {
    return (readStudioMeta(dir).mcpOAuthRegistrationClosed ?? []).includes(name)
  } catch {
    return false
  }
}

async function handleCallback(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) {
    return resultPage('Not signed in to Studio', 'Sign in to Studio in the other tab, then start the connection again.', 403)
  }

  const authError = url.searchParams.get('error')
  if (authError) {
    const description = url.searchParams.get('error_description')
    return resultPage('Sign-in was refused', description || authError, 400)
  }

  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code) {
    return resultPage('Incomplete redirect', 'The authorization server did not return a code and state. Start the connection again.', 400)
  }

  sweepPending(Date.now())
  const match = [...pending.entries()].find(([candidate]) => statesMatch(candidate, state))
  if (!match) {
    return resultPage('This sign-in expired', 'It took too long, or Studio restarted while it was open. Start the connection again.', 400)
  }
  const [stateKey, flow] = match
  pending.delete(stateKey)

  if (flow.userId !== userOrResponse.id) {
    return resultPage('Wrong account', 'This sign-in was started by a different Studio user. Start it again from your own account.', 403)
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      metadata: flow.metadata,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      redirectUri: flow.redirectUri,
      code,
      codeVerifier: flow.codeVerifier,
    })
    await writeMcpOAuthSession(
      { userId: flow.userId, projectKey: flow.projectKey, serverName: flow.serverName },
      buildMcpOAuthSession({
        serverUrl: flow.serverUrl,
        metadata: flow.metadata,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        redirectUri: flow.redirectUri,
        tokens,
      }),
    )
    return resultPage(`Connected to ${flow.serverName}`, 'You can close this tab and go back to Studio.', 200, true)
  } catch (err) {
    const detail = err instanceof McpOAuthError ? err.message : 'The token exchange failed.'
    console.error('[ai/mcpOAuth] token exchange failed:', err)
    return resultPage('Could not finish signing in', detail, 502)
  }
}

async function handleStatus(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const name = url.searchParams.get('name')
  if (!name) return badRequest('A server name is required.')

  const resolved = resolveServer(url.searchParams.get('dir'), name)
  if (!resolved.ok) return resolved.response

  const session = await readMcpOAuthSession({
    userId: userOrResponse.id,
    projectKey: resolved.projectKey,
    serverName: name,
  })
  // Path computation only — never creates the directory, and costs no network
  // call, so it is safe to answer on every status poll.
  const cliConfigDir = claudeCliPlatformSupport().supported
    ? resolveClaudeCliConfigDir(resolveClaudeCliDataRoot(), userOrResponse.id)
    : null

  if (session && session.serverUrl === resolved.serverUrl) {
    const status: McpOAuthStatus = {
      supportsOAuth: true,
      connected: true,
      expiresAt: session.expiresAt,
      scope: session.scope,
      cliConfigDir,
      registrationClosed: false,
    }
    return jsonResponse(status)
  }

  // No usable session — ask the server itself whether it even wants one, so a
  // plain unauthenticated http server never grows a sign-in button it has no
  // use for. A discovery failure means the same thing in practice.
  let supportsOAuth: boolean
  try {
    await discoverMcpAuthServer(resolved.serverUrl)
    supportsOAuth = true
  } catch {
    supportsOAuth = false
  }
  const status: McpOAuthStatus = {
    supportsOAuth,
    connected: false,
    expiresAt: null,
    scope: null,
    cliConfigDir,
    registrationClosed: registrationClosedFor(resolved.dir, name),
  }
  return jsonResponse(status)
}

async function handleSignOut(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const name = url.searchParams.get('name')
  if (!name) return badRequest('A server name is required.')

  const resolved = resolveServer(url.searchParams.get('dir'), name)
  if (!resolved.ok) return resolved.response

  deleteMcpOAuthSession({ userId: userOrResponse.id, projectKey: resolved.projectKey, serverName: name })
  // The CLI's own sign-in state is cached for a minute; without this a sign-out
  // would keep reporting "signed in via the CLI" until it expired.
  clearCliMcpConnectionCache()
  return jsonResponse({ ok: true })
}

/**
 * What the Claude CLI is signed in to, for one server — split from
 * `handleStatus` because it costs a ~10 second live health check and
 * `handleStatus` is what renders the card.
 *
 * Studio's own token store is the wrong place to ask: for a provider whose
 * client allow-list refuses Studio (Figma), the sign-in can ONLY have landed
 * in the CLI's keychain, so a badge derived from Studio's store alone is
 * structurally incapable of ever flipping. See `cliMcpConnectionProbe.ts`.
 */
async function handleCliStatus(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const name = url.searchParams.get('name')
  if (!name) return badRequest('A server name is required.')

  const resolved = resolveServer(url.searchParams.get('dir'), name)
  if (!resolved.ok) return resolved.response

  if (!claudeCliPlatformSupport().supported) {
    return jsonResponse({ state: 'unknown' } satisfies McpCliConnection)
  }

  const configDir = resolveClaudeCliConfigDir(resolveClaudeCliDataRoot(), userOrResponse.id)

  // Register the definition ourselves before asking. It is non-interactive and
  // idempotent, so there is no reason to make a human paste it — and without a
  // USER-scope entry the sign-in they perform is invisible from every other
  // directory, including the one this probe runs in. What is left for them is
  // the one step that genuinely cannot be automated.
  await ensureCliMcpServerRegistered({ configDir, name, url: resolved.serverUrl })

  const connections = await probeCliMcpConnections({ configDir })
  // Absent from the listing is NOT "not connected" — the CLI may not have that
  // server configured at all, or the probe may have failed entirely. Both are
  // `unknown`, and the UI must not render either as a negative.
  const state: McpCliConnection['state'] = connections.get(name) ?? 'unknown'

  // A completed sign-in is the consent an approval checkbox was asking for.
  // Recorded twice, for two different horizons: durably against this user, so
  // a project opened next week starts working without another probe; and as an
  // approval on THIS project, so the turn path reads an ordinary approval. See
  // `recordBuiltInSignIn`.
  if (state === 'connected') {
    rememberCliSignIn(configDir, name)
    // A live `connected` is proof the CLI's own cached "needs authentication"
    // verdict for this server is stale — and until it is dropped, every
    // headless turn keeps believing it and registers zero tools while this
    // panel says the opposite. See `clearCliNeedsAuthCache`.
    clearCliNeedsAuthCache(configDir, [name])
  }
  recordBuiltInSignIn(resolved.dir, name, state === 'connected')

  return jsonResponse({ state } satisfies McpCliConnection)
}

// ---------------------------------------------------------------------------
// The callback's rendered page
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The callback lands in a real browser tab, so it answers in HTML rather than
 * the `{ error }` envelope every other route uses. Everything interpolated —
 * a server name, an authorization server's `error_description` — is escaped:
 * both are strings from outside Studio rendered into a page.
 *
 * Self-contained on purpose: no stylesheet, no script beyond the close
 * attempt, so it renders identically whether Studio's assets are being served
 * by Vite or from a build.
 */
function resultPage(title: string, detail: string, status: number, success = false): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.125rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
  .mark { font-size: 2rem; line-height: 1; margin-bottom: .75rem; }
</style>
</head>
<body>
<main>
  <div class="mark">${success ? '&#10003;' : '&#9888;'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
</main>
${success ? '<script>setTimeout(function () { window.close() }, 1200)</script>' : ''}
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
