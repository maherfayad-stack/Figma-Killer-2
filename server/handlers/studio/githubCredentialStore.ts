/**
 * githubCredentialStore — the `git_credentials` table, and the only place a
 * user's GitHub token is encrypted, decrypted, or deleted.
 *
 * ## Why Studio stores a git token at all
 *
 * It did not, until G2. `push` succeeded only if the host had a working OS
 * credential helper or ssh-agent, which on a fresh machine it does not — and
 * the error a designer saw was git's "Support for password authentication was
 * removed", with no action Studio could offer. Signing in to GitHub once, in
 * the panel, is the action.
 *
 * ## The rules this module exists to keep
 *
 * - **Plaintext lives in one call frame.** `encryptSecret`/`decryptSecret`
 *   (`server/secrets/encryption.ts`, AES-256-GCM under the process master
 *   key) are the same primitives `ai_provider_credentials` uses. A token is
 *   decrypted only when a caller is about to hand it to one git invocation or
 *   one GitHub API call, and nothing here returns a record carrying plaintext
 *   alongside anything else.
 * - **There is no wire shape with a token in it.** {@link GithubAccountView}
 *   is what the HTTP layer may return: a login, an avatar URL, the scopes,
 *   and when it expires. `readGithubToken` is server-only and returns a bare
 *   string.
 * - **One row per (user, provider).** Signing in again replaces the row
 *   (delete-then-insert inside one call), so there is never a second, stale
 *   token that a later read might pick instead.
 * - **A token that will not decrypt is deleted, not reported.** The master
 *   key rotating is the only way that happens, and the remedy is ten seconds
 *   of signing in again — so the row goes and the user is asked, rather than
 *   the panel growing a "your credential needs re-encrypting" state.
 *
 * Dialect-naive by the repository rule: ANSI SQL only, `current_timestamp`
 * never `now()`, and `scopes_json` written as an explicit `JSON.stringify`
 * (see the migration's comment for why an array param would not survive both
 * adapters).
 */
import { nanoid } from 'nanoid'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { DbClient } from '../../db/client'
import { decryptSecret, encryptSecret } from '../../secrets/encryption'
import { loadMasterKey } from '../../secrets/masterKey'

/** The only provider this table accepts, matched by a CHECK constraint in the migration. */
const PROVIDER = 'github'

/**
 * What the HTTP layer may say about a stored credential. No token, no
 * ciphertext, no iv — `githubAuthRoutes.ts` returns exactly this shape and
 * nothing else.
 */
export const GithubAccountViewSchema = Type.Object({
  /** GitHub login, read from `GET /user` at sign-in time and cached in `.studio`-free server memory only. */
  login: Type.String(),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  /** OAuth scopes the token actually carries, as GitHub reported them — not what was asked for. */
  scopes: Type.Array(Type.String()),
  /** ISO-8601, or `null` for a token with no expiry (a device-flow token, a classic PAT). */
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})
export type GithubAccountView = Static<typeof GithubAccountViewSchema>

/** Everything about a stored credential EXCEPT the token — what a read that does not need the secret gets. */
export interface GithubCredentialMeta {
  id: string
  scopes: string[]
  expiresAt: string | null
  createdAt: string
}

interface GitCredentialRow {
  id: string
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  /** Auto-parsed from text by both adapters' `*_json` contract. Typed `unknown` because the DB is a boundary. */
  scopes_json: unknown
  created_at: Date | string
  expires_at: Date | string | null
}

/**
 * `scopes_json` is auto-parsed by both adapters' `*_json` contract, but the
 * database is still a boundary: a row written by an older build, or edited by
 * hand, must not reach the panel as `undefined`. Anything that is not an array
 * of strings reads as "no scopes", which disables exactly the affordances a
 * scope would have unlocked.
 */
function rowScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Stores `token` for `userId`, replacing whatever was there. `scopes` and
 * `expiresAt` are what the provider reported, not what was requested — the
 * panel shows the truth about the credential, and a scope the token does not
 * actually carry would make "Push" look available when it is not.
 */
export async function writeGithubCredential(
  db: DbClient,
  userId: string,
  input: { token: string; scopes: readonly string[]; expiresAt: string | null },
): Promise<GithubCredentialMeta> {
  const masterKey = await loadMasterKey()
  const encrypted = await encryptSecret(masterKey, input.token)

  // Replace rather than upsert: `on conflict` clauses differ between the two
  // dialects this repository must stay naive about, and a delete + insert has
  // the same observable effect for a table with one row per (user, provider).
  await db`delete from git_credentials where user_id = ${userId} and provider = ${PROVIDER}`

  const { rows } = await db<GitCredentialRow>`
    insert into git_credentials (id, user_id, provider, ciphertext, iv, scopes_json, expires_at)
    values (
      ${nanoid()},
      ${userId},
      ${PROVIDER},
      ${encrypted.ciphertext},
      ${encrypted.iv},
      ${JSON.stringify([...input.scopes])},
      ${input.expiresAt}
    )
    returning id, ciphertext, iv, scopes_json, created_at, expires_at
  `
  const row = rows[0]!
  return {
    id: row.id,
    scopes: [...input.scopes],
    expiresAt: isoDateOrNull(row.expires_at),
    createdAt: isoDateOrNull(row.created_at)!,
  }
}

/** Metadata for the signed-in credential, or `null` when this user has none. Never touches the master key. */
export async function readGithubCredentialMeta(
  db: DbClient,
  userId: string,
): Promise<GithubCredentialMeta | null> {
  const { rows } = await db<GitCredentialRow>`
    select id, ciphertext, iv, scopes_json, created_at, expires_at
    from git_credentials
    where user_id = ${userId} and provider = ${PROVIDER}
    limit 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    scopes: rowScopes(row.scopes_json),
    expiresAt: isoDateOrNull(row.expires_at),
    createdAt: isoDateOrNull(row.created_at)!,
  }
}

/**
 * The decrypted token, or `null` when there is none — including when the row
 * exists but cannot be decrypted, in which case the row is DELETED first (see
 * the module doc). Callers scope the returned string to a single git
 * invocation or a single API call and never log it.
 */
export async function readGithubToken(db: DbClient, userId: string): Promise<string | null> {
  const { rows } = await db<GitCredentialRow>`
    select id, ciphertext, iv, scopes_json, created_at, expires_at
    from git_credentials
    where user_id = ${userId} and provider = ${PROVIDER}
    limit 1
  `
  const row = rows[0]
  if (!row || !row.ciphertext || !row.iv) return null

  // An expired token is not a credential. Dropping it here (rather than
  // letting git fail with a 403 the user cannot act on) means the panel's very
  // next `account` read says "signed out" and offers the sign-in button again.
  const expiresAt = isoDateOrNull(row.expires_at)
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await deleteGithubCredential(db, userId)
    return null
  }

  try {
    const masterKey = await loadMasterKey()
    return await decryptSecret(masterKey, { ciphertext: row.ciphertext, iv: row.iv })
  } catch (err) {
    // The master key rotated, or the row was tampered with. Either way the
    // stored bytes are unusable and the only remedy is signing in again — so
    // do not keep them. The error is logged WITHOUT the row's contents.
    console.error('[studio/githubCredentialStore] stored GitHub token could not be decrypted; dropping it', err)
    await deleteGithubCredential(db, userId)
    return null
  }
}

/** Signs the user out. Returns `true` when a row was actually removed, so the route can 404 an already-signed-out delete. */
export async function deleteGithubCredential(db: DbClient, userId: string): Promise<boolean> {
  const result = await db`
    delete from git_credentials where user_id = ${userId} and provider = ${PROVIDER}
  `
  return result.rowCount > 0
}
