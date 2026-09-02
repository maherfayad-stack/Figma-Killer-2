/**
 * Persistence and lifecycle for an MCP server's OAuth session — the stateful
 * half of `mcpOAuth.ts`.
 *
 * ## Where it lives, and why not somewhere new
 *
 * A completed OAuth session is a reversible secret scoped to exactly the
 * triple `mcpServerSecretStore.ts` already keys on: (user, project, server).
 * So it is stored THERE, as one reserved field, rather than in a second
 * encrypted store with its own crypto path, its own data root and its own
 * lifecycle bugs. Three things fall out for free and are the reason for the
 * choice:
 *
 *   - the same AES-256-GCM master key, the same `keyFingerprint` rotation
 *     detection, the same 0600/0700 file discipline;
 *   - `removeRegisteredMcpServer` already deletes every secret field for a
 *     server, so removing a server signs it out too — no orphaned refresh
 *     token surviving the thing it authenticated;
 *   - `.data/` is git-ignored and outside `studio-workspace/**`, so a token
 *     can never ride along in a user's project repo.
 *
 * The field name is reserved and deliberately un-header-like
 * ({@link OAUTH_SECRET_FIELD}): a definition's own `secretHeaderNames` are
 * real HTTP header names, so the two namespaces cannot collide, and the
 * Settings list — which enumerates `secretFieldNames` from the definition —
 * never renders this as a text box for someone to paste into.
 *
 * ## Refresh happens on read, not on a timer
 *
 * There is no background job. `resolveMcpOAuthHeader` is called on the path
 * that builds a turn's `--mcp-config`, checks the stored deadline, and
 * refreshes when the access token is expired or about to be. That is the only
 * moment the answer matters, and it means a Studio that was closed for a week
 * reconnects on the next turn instead of shipping a dead token to the CLI.
 *
 * A refresh that FAILS clears nothing: the stored session is kept and the
 * header resolves to `null`, so the turn proceeds without that server (the
 * same fail-soft posture `resolvedApprovedRegisteredMcpServers` already takes)
 * and the Settings UI still shows a session it can offer to renew. Deleting a
 * user's session because a network call failed once would turn a blip into a
 * re-authorisation.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import {
  deleteMcpServerSecretField,
  getMcpServerSecret,
  hasMcpServerSecret,
  resolveMcpServerSecretsRoot,
  setMcpServerSecret,
} from './mcpServerSecretStore'
import { McpOAuthError, refreshAccessToken, type McpAuthServerMetadata, type OAuthTokenSet } from './mcpOAuth'

/** The reserved `mcpServerSecretStore` field an OAuth session is persisted under. Not a legal-looking HTTP header name, so it can never collide with a definition's own `secretHeaderNames`. */
export const OAUTH_SECRET_FIELD = '__studio_oauth__'

/** Refresh this far ahead of the recorded deadline, so a token cannot expire in flight between resolving the config file and the CLI actually connecting. */
const REFRESH_SKEW_MS = 60_000

const McpOAuthSessionSchema = Type.Object({
  version: Type.Literal(1),
  /** The server URL this session authenticates, recorded so a redefined server URL invalidates the session instead of silently reusing a token minted for a different resource. */
  serverUrl: Type.String(),
  resource: Type.String(),
  issuer: Type.String(),
  authorizationEndpoint: Type.String(),
  tokenEndpoint: Type.String(),
  registrationEndpoint: Type.Union([Type.String(), Type.Null()]),
  scope: Type.String(),
  clientId: Type.String(),
  clientSecret: Type.Union([Type.String(), Type.Null()]),
  /** Recorded because DCR binds the client to it — a Studio reachable at a different origin needs a fresh registration, not a mismatched redirect. */
  redirectUri: Type.String(),
  accessToken: Type.String(),
  refreshToken: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.Union([Type.Number(), Type.Null()]),
  connectedAt: Type.Number(),
})
export type McpOAuthSession = Static<typeof McpOAuthSessionSchema>

export interface McpOAuthSessionAddress {
  readonly userId: string
  readonly projectKey: string
  readonly serverName: string
  readonly dataRoot?: string
}

function root(address: McpOAuthSessionAddress): string {
  return address.dataRoot ?? resolveMcpServerSecretsRoot()
}

/** Read and validate the stored session, or `null` when there is none / it cannot be decrypted or parsed. Never throws — a master-key rotation reads as "not signed in", which is the truth from the caller's point of view. */
export async function readMcpOAuthSession(address: McpOAuthSessionAddress): Promise<McpOAuthSession | null> {
  let raw: string | null
  try {
    raw = await getMcpServerSecret(address.userId, address.projectKey, address.serverName, OAUTH_SECRET_FIELD, root(address))
  } catch (err) {
    console.error(`[ai/mcpOAuthStore] could not decrypt the stored session for "${address.serverName}":`, err)
    return null
  }
  if (raw === null) return null

  const parsed = safeParseJson(raw, McpOAuthSessionSchema)
  if (!parsed.ok) {
    console.error(`[ai/mcpOAuthStore] the stored session for "${address.serverName}" has an unreadable shape — treating it as signed out.`)
    return null
  }
  return parsed.value
}

export async function writeMcpOAuthSession(address: McpOAuthSessionAddress, session: McpOAuthSession): Promise<void> {
  await setMcpServerSecret(
    address.userId,
    address.projectKey,
    address.serverName,
    OAUTH_SECRET_FIELD,
    JSON.stringify(session),
    root(address),
  )
}

/** Sign out of one server without touching any other secret it holds. */
export function deleteMcpOAuthSession(address: McpOAuthSessionAddress): void {
  deleteMcpServerSecretField(address.userId, address.projectKey, address.serverName, OAUTH_SECRET_FIELD, root(address))
}

/** Whether a session exists at all — the cheap check, with no decryption, for list endpoints that only need a badge. */
export function hasMcpOAuthSession(address: McpOAuthSessionAddress): boolean {
  return hasMcpServerSecret(address.userId, address.projectKey, address.serverName, OAUTH_SECRET_FIELD, root(address))
}

/** Assemble a session record from a completed grant — the one place the two halves (what discovery said, what the token endpoint returned) are joined. */
export function buildMcpOAuthSession(input: {
  readonly serverUrl: string
  readonly metadata: McpAuthServerMetadata
  readonly clientId: string
  readonly clientSecret: string | null
  readonly redirectUri: string
  readonly tokens: OAuthTokenSet
}): McpOAuthSession {
  return {
    version: 1,
    serverUrl: input.serverUrl,
    resource: input.metadata.resource,
    issuer: input.metadata.issuer,
    authorizationEndpoint: input.metadata.authorizationEndpoint,
    tokenEndpoint: input.metadata.tokenEndpoint,
    registrationEndpoint: input.metadata.registrationEndpoint,
    scope: input.metadata.scope,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri,
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    expiresAt: input.tokens.expiresAt,
    connectedAt: Date.now(),
  }
}

function isExpired(session: McpOAuthSession, now: number): boolean {
  return session.expiresAt !== null && session.expiresAt - REFRESH_SKEW_MS <= now
}

/**
 * The value to set as the `Authorization` header for this server on this
 * turn, refreshing first if the stored access token is expired or nearly so.
 * `null` means "not signed in, or the session could not be renewed" — the
 * caller drops the server for the turn rather than sending it unauthenticated.
 *
 * `serverUrl` is checked against the session's own: a server that has since
 * been redefined to point somewhere else must not be handed a token minted
 * for the previous resource.
 */
export async function resolveMcpOAuthHeader(
  address: McpOAuthSessionAddress,
  serverUrl: string,
  now: number = Date.now(),
): Promise<string | null> {
  const session = await readMcpOAuthSession(address)
  if (!session) return null

  if (session.serverUrl !== serverUrl) {
    console.error(
      `[ai/mcpOAuthStore] "${address.serverName}" now points at ${serverUrl} but its stored session was issued for ${session.serverUrl} — sign in again.`,
    )
    return null
  }

  if (!isExpired(session, now)) return `Bearer ${session.accessToken}`

  if (!session.refreshToken) {
    console.error(`[ai/mcpOAuthStore] the session for "${address.serverName}" expired and the server issued no refresh token — sign in again.`)
    return null
  }

  try {
    const tokens = await refreshAccessToken({
      tokenEndpoint: session.tokenEndpoint,
      resource: session.resource,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      refreshToken: session.refreshToken,
    })
    const renewed: McpOAuthSession = {
      ...session,
      accessToken: tokens.accessToken,
      // An authorization server that rotates refresh tokens returns a new one;
      // one that does not returns none, and the existing token stays valid.
      // Overwriting with `null` in that second case would sign the user out on
      // the NEXT expiry for no reason.
      refreshToken: tokens.refreshToken ?? session.refreshToken,
      expiresAt: tokens.expiresAt,
    }
    await writeMcpOAuthSession(address, renewed)
    return `Bearer ${renewed.accessToken}`
  } catch (err) {
    const detail = err instanceof McpOAuthError ? err.message : String(err)
    console.error(`[ai/mcpOAuthStore] could not refresh the session for "${address.serverName}" — dropping it for this turn: ${detail}`)
    return null
  }
}
