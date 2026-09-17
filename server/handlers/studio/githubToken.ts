/**
 * githubToken — "what token may I use for this user's git operations?", asked
 * by callers that have a user id and nothing else.
 *
 * Every git verb that crosses the network (`push`, and after G1 `clone`;
 * after G4 `fetch`/`pull`) needs a credential, and every one of them is
 * reached from a route that knows who is signed in. But those routes are
 * spread across several sub-routers written by different hands, so the
 * dependency they share is stated here as ONE function with ONE argument
 * rather than threaded as a `DbClient` parameter through each operation
 * signature:
 *
 *     getGithubTokenForUser(userId): Promise<string | null>
 *
 * `null` means "no usable credential" and is a completely normal answer — it
 * is the state of every install that has not signed in, and the caller's
 * correct response is to run git WITHOUT a credential, exactly as it did
 * before G2 (the user's own helper or ssh-agent then answers, or the push
 * fails with git's real message).
 *
 * ## Why there is a `provideGithubCredentialDb`
 *
 * This process has no ambient database singleton: `server/index.ts` creates
 * the one `DbClient` and passes it down. The signature above takes a user id
 * and nothing else — deliberately, so that four call sites do not each have to
 * carry a `db` they otherwise have no use for — so the client is handed to
 * this module once at boot instead. Tests call the same function with their
 * own client.
 *
 * If it was never provided, `getGithubTokenForUser` answers `null` and logs
 * once. That is the honest degradation: a boot-order bug must not make `push`
 * throw for users who never signed in, and "no stored credential" is a state
 * the whole feature already handles.
 */
import type { DbClient } from '../../db/client'
import { getSessionHash } from '../../auth/authz'
import { findUserBySessionHash } from '../../auth/sessions'
import { readGithubToken } from './githubCredentialStore'

let credentialDb: DbClient | null = null
let warnedAboutMissingDb = false

/** Called once from `server/index.ts` with the process's one `DbClient`, and from tests with theirs. */
export function provideGithubCredentialDb(db: DbClient): void {
  credentialDb = db
  warnedAboutMissingDb = false
}

/**
 * The decrypted GitHub token for `userId`, or `null` when they have not
 * signed in (or the stored one expired / no longer decrypts — see
 * `githubCredentialStore.ts`, which drops it in both cases).
 *
 * The returned string must be scoped to a single operation: handed to
 * `runGit`'s `credential` option, or to one GitHub API call. It is never
 * logged, never put in an error message, and never returned over HTTP.
 */
export async function getGithubTokenForUser(userId: string): Promise<string | null> {
  const db = credentialDbOrWarn()
  if (!db) return null
  return readGithubToken(db, userId)
}

/**
 * The same answer, for a caller that has a `Request` and no user id — the
 * shape every existing `/admin/api/studio/git/*` route is in, since those
 * sub-routers take `(req, url, pathname)` and were written before any of them
 * needed to know who was asking.
 *
 * Deliberately SOFT: an unauthenticated request gets `null`, not a 401. These
 * routes' authorization posture is not this function's to change (see
 * `docs/server.md` on the single-operator posture), and the only thing this
 * answers is "is there a stored credential to use". A request with no session
 * simply has no stored credential, and git runs without one.
 */
export async function getGithubTokenForRequest(req: Request): Promise<string | null> {
  const db = credentialDbOrWarn()
  if (!db) return null
  const sessionHash = await getSessionHash(req)
  if (!sessionHash) return null
  const user = await findUserBySessionHash(db, sessionHash)
  if (!user) return null
  return readGithubToken(db, user.id)
}

/** The provided client, or `null` with a one-time log — see the module doc for why this degrades rather than throws. */
function credentialDbOrWarn(): DbClient | null {
  if (credentialDb) return credentialDb
  if (!warnedAboutMissingDb) {
    warnedAboutMissingDb = true
    console.error('[studio/githubToken] no database client was provided; git runs without a stored credential')
  }
  return null
}
