/**
 * gitRemoteCredential — "whose GitHub credential, if anyone's, should this
 * request use?"
 *
 * The network git verbs (`fetch`, `pull`) and the pull-request call are the
 * only places in Studio that act with somebody's GitHub identity rather than
 * merely reading a directory. That identity comes from the request's own
 * session and nowhere else — **never from the environment**, which is why
 * `gitRunner.ts`'s env allowlist contains no token variable.
 *
 * ## Why the identity is OPTIONAL rather than required
 *
 * Studio's git routes work perfectly well with no GitHub account at all: a
 * local repository, an ssh remote, or the user's own credential helper. A 401
 * on `fetch` for someone who never connected GitHub would be a gate the
 * feature does not have. So this answers `undefined` for "no session, or no
 * connected token", and every caller has a real path for that:
 *
 *   - `fetch`/`pull` run without a credential and let git use whatever the
 *     user's own helper or ssh-agent provides — today's documented posture.
 *   - the pull-request route, which genuinely cannot work without a token,
 *     refuses with a named code so the panel can say "Sign in to GitHub" and
 *     offer the compare URL instead.
 *
 * `getGithubTokenForUser` is G2's (see `githubToken.ts`). Until it lands it
 * answers `null`, so every credential here is `undefined` — which is exactly
 * the state this module is designed to make harmless.
 */
import { getSessionHash } from '../../auth/authz'
import { findUserBySessionHash } from '../../auth/sessions'
import type { DbClient } from '../../db/client'
import { getGithubTokenForUser } from './githubToken'

/** The signed-in user's id, or `null` when the request carries no usable session. Never throws and never 401s — the caller decides whether absence matters. */
export async function requestUserId(req: Request, db: DbClient): Promise<string | null> {
  const idHash = await getSessionHash(req)
  if (!idHash) return null
  const user = await findUserBySessionHash(db, idHash)
  return user?.id ?? null
}

/**
 * The GitHub token to hand `runGit`'s `credential` option for this request, or
 * `undefined`. Safe to pass unconditionally — `runGit` treats `undefined` as
 * "no askpass, behave exactly as before".
 */
export async function gitCredentialForRequest(req: Request, db: DbClient): Promise<string | undefined> {
  const userId = await requestUserId(req, db)
  if (!userId) return undefined
  return (await getGithubTokenForUser(userId)) ?? undefined
}
